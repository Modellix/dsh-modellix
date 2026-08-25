import { createHash, randomUUID } from "node:crypto";

import {
  DEFAULT_RESULT_TTL_MS,
  DesignError,
  DesignPlannerClient,
  DesignTaskRepository,
  ModelCatalogClient,
  ModelSchemaClient,
  PredictionClient,
  applyExactPatch,
  buildInvocationBody,
  materializeDefaults,
  parseDesignSchema,
  type CacheEntry,
  type CachePort,
  type DesignModelSummary,
  type DesignSchemaIR,
  type DesignTaskRecord,
  type JsonValue,
  type StoragePort,
  type UiField,
} from "../design/index.js";

const DESIGN_CATEGORIES = ["image", "video", "audio"] as const;
const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_SESSIONS = 100;
const MAX_CATALOG_PAGES_PER_CATEGORY = 10;
const PREFERRED_DEFAULT_MODELS = [
  "openai/gpt-image-2",
  "alibaba/z-image-turbo",
] as const;

interface CredentialSnapshot {
  readonly value: string;
  readonly credentialEpoch: number;
}

export interface DesignHostControllerOptions {
  readonly storage: StoragePort;
  readonly resolveCredential: () => Promise<CredentialSnapshot | undefined>;
  readonly isCredentialEpochCurrent: (credentialEpoch: number) => boolean;
  readonly onUnauthorized: (credentialEpoch: number) => void | Promise<void>;
  readonly isEnabled: () => boolean;
  readonly getLastModel: () => string | null;
  readonly rememberModel: (modelId: string) => Promise<void>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

interface DesignDraftState {
  readonly modelId: string;
  readonly revision: number;
  readonly schema: DesignSchemaIR;
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

interface DesignProposalState {
  readonly wire: DesignProposalWire;
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

interface DesignSessionState {
  selectedModelId: string | null;
  draft: DesignDraftState | null;
  proposal: DesignProposalState | null;
  notice: string | null;
  touchedAt: number;
}

interface DesignModelWire {
  readonly id: string;
  readonly label: string;
  readonly kind: "image" | "video" | "audio" | "unknown";
  readonly featured: boolean;
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

interface DesignFieldWire {
  readonly path: string;
  readonly label: string;
  readonly description: string | null;
  readonly kind: "string" | "number" | "integer" | "boolean" | "enum" | "array" | "object" | "media";
  readonly widget: "input" | "textarea" | "select" | "switch" | "json" | "media";
  readonly required: boolean;
  readonly options: readonly { readonly label: string; readonly value: string | number | boolean }[];
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly step: number | null;
  readonly maxLength: number | null;
  readonly disabledReason: string | null;
}

interface DesignProposalChangeWire {
  readonly path: string;
  readonly label: string;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
}

interface DesignProposalWire {
  readonly proposalId: string;
  readonly baseDraftRevision: number;
  readonly summary: string;
  readonly changes: readonly DesignProposalChangeWire[];
  readonly conflicts: readonly string[];
}

export interface DesignSnapshotWire {
  readonly version: 1;
  readonly enabled: boolean;
  readonly credentialReady: boolean;
  readonly models: readonly DesignModelWire[];
  readonly selectedModelId: string | null;
  readonly draft: {
    readonly modelId: string;
    readonly draftRevision: number;
    readonly irContractHash: string;
    readonly primaryInputPath: string;
    readonly fields: readonly DesignFieldWire[];
    readonly parameters: Readonly<Record<string, JsonValue>>;
  } | null;
  readonly proposal: DesignProposalWire | null;
  readonly jobs: readonly {
    readonly jobId: string;
    readonly modelId: string;
    readonly status: "running" | "succeeded" | "failed" | "canceled" | "submit-unknown" | "expired";
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly resources: readonly {
      readonly id: string;
      readonly kind: "image" | "video" | "audio";
      readonly url: string;
      readonly downloadUrl: string;
      readonly expiresAt: string | null;
    }[];
    readonly diagnostic: {
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    } | null;
  }[];
  readonly notice: string | null;
}

/** Stateful Host facade over pure Design contracts; no Secret crosses its wire. */
export class DesignHostController {
  readonly #repository: DesignTaskRepository;
  readonly #resolveCredential: DesignHostControllerOptions["resolveCredential"];
  readonly #isCredentialEpochCurrent: DesignHostControllerOptions["isCredentialEpochCurrent"];
  readonly #onUnauthorized: DesignHostControllerOptions["onUnauthorized"];
  readonly #isEnabled: DesignHostControllerOptions["isEnabled"];
  readonly #getLastModel: DesignHostControllerOptions["getLastModel"];
  readonly #rememberModel: DesignHostControllerOptions["rememberModel"];
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #cache = new MemoryCache();
  readonly #sessions = new Map<string, DesignSessionState>();
  #lastModels: readonly DesignModelWire[] = [];
  #catalogNotice: string | null = null;

  constructor(options: DesignHostControllerOptions) {
    this.#repository = new DesignTaskRepository({ storage: options.storage });
    this.#resolveCredential = options.resolveCredential;
    this.#isCredentialEpochCurrent = options.isCredentialEpochCurrent;
    this.#onUnauthorized = options.onUnauthorized;
    this.#isEnabled = options.isEnabled;
    this.#getLastModel = options.getLastModel;
    this.#rememberModel = options.rememberModel;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async handle(
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<DesignSnapshotWire> {
    signal?.throwIfAborted();
    switch (endpoint) {
      case "design/read":
        return this.read(parseSessionPayload(payload), signal);
      case "design/refresh":
        return this.refresh(parseSessionPayload(payload), signal);
      case "design/select-model":
        return this.selectModel(parseModelPayload(payload), signal);
      case "design/propose":
        return this.propose(parseProposalPayload(payload), signal);
      case "design/proposal/apply":
        return this.applyProposal(parseProposalMutationPayload(payload), signal);
      case "design/proposal/reject":
        return this.rejectProposal(parseProposalMutationPayload(payload), signal);
      case "design/submit":
        return this.submit(parseSubmitPayload(payload), signal);
      default:
        throw new DesignError("INVALID_ARGUMENT", "Unknown Design endpoint");
    }
  }

  async pollRunning(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (!this.#isEnabled()) return false;
    const credential = await this.#resolveCredential();
    if (credential === undefined) return false;
    const tasks = await this.#repository.listTasks();
    const running = tasks.filter((task) =>
      task.taskId !== null && (task.state === "queued" || task.state === "running"));
    for (const record of running.slice(0, 5)) {
      if (!this.#isCredentialEpochCurrent(credential.credentialEpoch)) break;
      try {
        const task = await new PredictionClient({ fetch: this.#fetch }).readTask({
          taskId: record.taskId as string,
          apiKey: credential.value,
          maxAttempts: 1,
          ...(signal === undefined ? {} : { signal }),
        });
        await this.#repository.recordTaskObserved(task);
      } catch (error) {
        await this.#markUnauthorized(error, credential.credentialEpoch);
      }
    }
    const after = await this.#repository.listTasks();
    return after.some((task) => task.state === "queued" || task.state === "running");
  }

  private async read(
    input: { readonly sessionId: string },
    signal?: AbortSignal,
  ): Promise<DesignSnapshotWire> {
    const session = this.#session(input.sessionId);
    if (this.#isEnabled()) await this.pollRunning(signal);
    const models = await this.#loadModelsSafely(signal);
    if (session.selectedModelId === null && models.length > 0) {
      const modelId = chooseDefaultModel(models, this.#getLastModel());
      if (modelId !== null) {
        session.selectedModelId = modelId;
        try {
          session.draft = await this.#loadDraft(modelId, 0, signal);
          session.notice = null;
        } catch (error) {
          session.draft = null;
          session.notice = error instanceof DesignError
            ? error.message
            : "The suggested model schema is temporarily unavailable.";
        }
      }
    }
    return this.#snapshot(session, models);
  }

  private async refresh(
    input: { readonly sessionId: string },
    signal?: AbortSignal,
  ): Promise<DesignSnapshotWire> {
    if (!this.#isEnabled()) throw new DesignError("INVALID_ARGUMENT", "Design is disabled");
    this.#cache.clear();
    this.#lastModels = [];
    this.#catalogNotice = null;
    const session = this.#session(input.sessionId);
    const models = await this.#loadModelsSafely(signal);
    return this.#snapshot(session, models);
  }

  private async selectModel(input: {
    readonly sessionId: string;
    readonly modelId: string;
  }, signal?: AbortSignal): Promise<DesignSnapshotWire> {
    if (!this.#isEnabled()) throw new DesignError("INVALID_ARGUMENT", "Design is disabled");
    const session = this.#session(input.sessionId);
    const models = await this.#loadModelsSafely(signal);
    const selected = models.find((model) => model.id === input.modelId);
    if (selected === undefined || !selected.available) {
      throw new DesignError("INVALID_ARGUMENT", "The selected model is unavailable");
    }
    const draft = await this.#loadDraft(
      input.modelId,
      (session.draft?.revision ?? -1) + 1,
      signal,
    );
    session.selectedModelId = input.modelId;
    session.draft = draft;
    session.proposal = null;
    session.notice = null;
    await this.#rememberModel(input.modelId);
    return this.#snapshot(session, models);
  }

  private async propose(input: {
    readonly sessionId: string;
    readonly modelId: string;
    readonly instruction: string;
    readonly draftRevision: number;
    readonly irContractHash: string;
  }, signal?: AbortSignal): Promise<DesignSnapshotWire> {
    if (!this.#isEnabled()) throw new DesignError("INVALID_ARGUMENT", "Design is disabled");
    const session = this.#session(input.sessionId);
    const draft = requireDraft(session, input.modelId, input.draftRevision, input.irContractHash);
    const credential = await this.#resolveCredential();
    if (credential === undefined) throw new DesignError("MISSING_API_KEY", "A Modellix API key is required");
    let planned: Awaited<ReturnType<DesignPlannerClient["plan"]>>;
    try {
      planned = await new DesignPlannerClient({ fetch: this.#fetch }).plan({
        apiKey: credential.value,
        schema: draft.schema,
        current: draft.parameters,
        instruction: input.instruction,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      await this.#markUnauthorized(error, credential.credentialEpoch);
      throw error;
    }
    if (!this.#isCredentialEpochCurrent(credential.credentialEpoch)) {
      throw new DesignError("MISSING_API_KEY", "The Modellix credential changed");
    }
    requireDraft(session, input.modelId, input.draftRevision, input.irContractHash);
    const fields = indexUiFields(draft.schema.fields);
    const changedPaths = [
      ...Object.keys(planned.patch.set ?? {}),
      ...(planned.patch.unset ?? []),
    ];
    const changes = changedPaths.flatMap((path): DesignProposalChangeWire[] => {
      const field = fields.get(path);
      if (field === undefined) return [];
      const before = pointerValue(draft.parameters, path);
      const after = pointerValue(planned.parameters, path);
      if (jsonEqual(before, after)) return [];
      return [{
        path,
        label: field.title,
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      }];
    });
    const wire: DesignProposalWire = {
      proposalId: `proposal_${randomUUID().replaceAll("-", "")}`,
      baseDraftRevision: draft.revision,
      summary: planned.needsClarification ??
        `${String(changes.length)} parameter change${changes.length === 1 ? "" : "s"} proposed.`,
      changes,
      conflicts: planned.needsClarification === null ? [] : [planned.needsClarification],
    };
    session.proposal = { wire, parameters: planned.parameters };
    return this.#snapshot(session, await this.#loadModelsSafely(signal));
  }

  private async applyProposal(input: {
    readonly sessionId: string;
    readonly proposalId: string;
  }, signal?: AbortSignal): Promise<DesignSnapshotWire> {
    const session = this.#session(input.sessionId);
    const proposal = session.proposal;
    const draft = session.draft;
    if (
      proposal === null || draft === null ||
      proposal.wire.proposalId !== input.proposalId ||
      proposal.wire.baseDraftRevision !== draft.revision
    ) {
      throw new DesignError("INVALID_ARGUMENT", "The Design proposal is stale");
    }
    session.draft = { ...draft, revision: draft.revision + 1, parameters: proposal.parameters };
    session.proposal = null;
    return this.#snapshot(session, await this.#loadModelsSafely(signal));
  }

  private async rejectProposal(input: {
    readonly sessionId: string;
    readonly proposalId: string;
  }, signal?: AbortSignal): Promise<DesignSnapshotWire> {
    const session = this.#session(input.sessionId);
    if (session.proposal?.wire.proposalId !== input.proposalId) {
      throw new DesignError("INVALID_ARGUMENT", "The Design proposal is stale");
    }
    session.proposal = null;
    return this.#snapshot(session, await this.#loadModelsSafely(signal));
  }

  private async submit(input: {
    readonly sessionId: string;
    readonly modelId: string;
    readonly draftRevision: number;
    readonly irContractHash: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  }, signal?: AbortSignal): Promise<DesignSnapshotWire> {
    if (!this.#isEnabled()) throw new DesignError("INVALID_ARGUMENT", "Design is disabled");
    const session = this.#session(input.sessionId);
    const draft = requireDraft(session, input.modelId, input.draftRevision, input.irContractHash);
    const credential = await this.#resolveCredential();
    if (credential === undefined) throw new DesignError("MISSING_API_KEY", "A Modellix API key is required");

    // Submission re-reads the no-store public schema so a changed contract can
    // never reuse a stale endpoint or parameter set.
    const schemaDocument = await new ModelSchemaClient({ fetch: this.#fetch }).load(
      ...splitModel(input.modelId),
      signal,
    );
    const schema = parseDesignSchema(schemaDocument.document);
    if (schemaDocument.submitUrl === null || schema.schemaHash !== draft.schema.schemaHash) {
      throw new DesignError("SCHEMA_INVALID", "The model schema changed; reload the draft");
    }
    if (!this.#isCredentialEpochCurrent(credential.credentialEpoch)) {
      throw new DesignError("MISSING_API_KEY", "The Modellix credential changed");
    }
    const parameters = applyExactPatch(schema, materializeDefaults(schema), {
      set: input.parameters,
    });
    const body = buildInvocationBody(schema, parameters);
    const requestId = `request_${randomUUID().replaceAll("-", "")}`;
    signal?.throwIfAborted();
    await this.#repository.recordSubmitIntent(requestId, input.modelId);

    // Advancing before the one-shot POST is the in-process replay fence: a
    // lost RPC response cannot be submitted again with the stale revision.
    session.draft = {
      modelId: input.modelId,
      revision: draft.revision + 1,
      schema,
      parameters,
    };
    session.proposal = null;
    try {
      const task = await new PredictionClient({ fetch: this.#fetch }).submit({
        endpoint: schemaDocument.submitUrl,
        modelSlug: input.modelId,
        apiKey: credential.value,
        body,
        requestId,
        ...(signal === undefined ? {} : { signal }),
      });
      await this.#repository.recordSubmitAccepted(requestId, task);
    } catch (error) {
      if (error instanceof DesignError && error.code === "SUBMIT_UNKNOWN") {
        await this.#repository.markSubmitUnknown(requestId);
      } else {
        await this.#repository.markSubmitRejected(requestId);
      }
      await this.#markUnauthorized(error, credential.credentialEpoch);
      throw error;
    }
    return this.#snapshot(session, await this.#loadModelsSafely(signal));
  }

  async #loadDraft(
    modelId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<DesignDraftState> {
    const [provider, model] = splitModel(modelId);
    const document = await new ModelSchemaClient({ fetch: this.#fetch }).load(
      provider,
      model,
      signal,
    );
    if (document.submitUrl === null) {
      throw new DesignError("SCHEMA_INVALID", "The model schema has no authoritative endpoint");
    }
    const schema = parseDesignSchema(document.document);
    if (!schema.supported || schema.primaryPromptPath === null) {
      throw new DesignError("SCHEMA_INVALID", "The model schema is not supported by Design");
    }
    return { modelId, revision, schema, parameters: materializeDefaults(schema) };
  }

  async #loadModelsSafely(signal?: AbortSignal): Promise<readonly DesignModelWire[]> {
    try {
      const models = await this.#loadModels(signal);
      this.#lastModels = models;
      this.#catalogNotice = null;
      return models;
    } catch (error) {
      if (signal?.aborted === true) throw error;
      this.#catalogNotice = this.#lastModels.length > 0
        ? "The live model catalog could not be refreshed; showing the last in-memory result."
        : "The Modellix Design model catalog is temporarily unavailable.";
      return this.#lastModels;
    }
  }

  async #loadModels(signal?: AbortSignal): Promise<readonly DesignModelWire[]> {
    const credential = await this.#resolveCredential();
    if (credential === undefined) return [];
    const client = new ModelCatalogClient({
      fetch: this.#fetch,
      getApiKey: () => credential.value,
      cache: this.#cache,
    });
    try {
      const pages = await Promise.all(DESIGN_CATEGORIES.map(async (category) => {
        const items: DesignModelSummary[] = [];
        for (let page = 1; page <= MAX_CATALOG_PAGES_PER_CATEGORY; page += 1) {
          const result = await client.list({ category, page, pageSize: 100 }, signal);
          items.push(...result.items);
          if (!result.hasMore || items.length >= 1_000) break;
        }
        return items;
      }));
      if (!this.#isCredentialEpochCurrent(credential.credentialEpoch)) return this.#lastModels;
      const merged = new Map<string, DesignModelSummary>();
      for (const item of pages.flat()) {
        const prior = merged.get(item.slug);
        merged.set(item.slug, prior === undefined ? item : {
          ...prior,
          categories: [...new Set([...prior.categories, ...item.categories])],
        });
      }
      const preferred = chooseDefaultModelFromSummaries([...merged.values()], this.#getLastModel());
      return [...merged.values()].slice(0, 1_000).map((model, index) => ({
        id: model.slug,
        label: model.displayName,
        kind: model.categories[0] ?? "unknown",
        featured: model.slug === preferred || (preferred === null && index === 0),
        available: true,
        unavailableReason: null,
      }));
    } catch (error) {
      await this.#markUnauthorized(error, credential.credentialEpoch);
      throw error;
    }
  }

  async #snapshot(
    session: DesignSessionState,
    currentModels: readonly DesignModelWire[],
  ): Promise<DesignSnapshotWire> {
    const credentialReady = (await this.#resolveCredential()) !== undefined;
    const models = ensureSelectedModel(currentModels, session.selectedModelId);
    const tasks = [...await this.#repository.listTasks()]
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return {
      version: 1,
      enabled: this.#isEnabled(),
      credentialReady,
      models,
      selectedModelId: session.selectedModelId,
      draft: session.draft === null ? null : draftWire(session.draft),
      proposal: session.proposal?.wire ?? null,
      jobs: tasks.slice(0, 1_000).map((task) => taskWire(task, this.#now())),
      notice: session.notice ?? this.#catalogNotice,
    };
  }

  #session(sessionId: string): DesignSessionState {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      existing.touchedAt = this.#now();
      return existing;
    }
    if (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.#sessions.entries()]
        .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
      if (oldest !== undefined) this.#sessions.delete(oldest[0]);
    }
    const created: DesignSessionState = {
      selectedModelId: null,
      draft: null,
      proposal: null,
      notice: null,
      touchedAt: this.#now(),
    };
    this.#sessions.set(sessionId, created);
    return created;
  }

  async #markUnauthorized(error: unknown, credentialEpoch: number): Promise<void> {
    if (error instanceof DesignError && error.status === 401) {
      await this.#onUnauthorized(credentialEpoch);
    }
  }
}

class MemoryCache implements CachePort {
  readonly #entries = new Map<string, CacheEntry<unknown>>();

  async read<T>(key: string): Promise<CacheEntry<T> | null> {
    return (this.#entries.get(key) as CacheEntry<T> | undefined) ?? null;
  }

  async write<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    this.#entries.set(key, entry);
  }

  clear(): void {
    this.#entries.clear();
  }
}

function parseSessionPayload(payload: unknown): { readonly sessionId: string } {
  const input = record(payload);
  return { sessionId: safeSessionId(input.sessionId) };
}

function parseModelPayload(payload: unknown): { readonly sessionId: string; readonly modelId: string } {
  const input = record(payload);
  return { sessionId: safeSessionId(input.sessionId), modelId: safeModelId(input.modelId) };
}

function parseProposalPayload(payload: unknown): {
  readonly sessionId: string;
  readonly modelId: string;
  readonly instruction: string;
  readonly draftRevision: number;
  readonly irContractHash: string;
} {
  const input = record(payload);
  if (typeof input.instruction !== "string" || input.instruction.length > 64 * 1024) {
    throw new DesignError("INVALID_ARGUMENT", "Design instruction is invalid");
  }
  return {
    sessionId: safeSessionId(input.sessionId),
    modelId: safeModelId(input.modelId),
    instruction: input.instruction,
    draftRevision: natural(input.draftRevision, "draftRevision"),
    irContractHash: safeHash(input.irContractHash),
  };
}

function parseProposalMutationPayload(payload: unknown): {
  readonly sessionId: string;
  readonly proposalId: string;
} {
  const input = record(payload);
  if (typeof input.proposalId !== "string" || !/^proposal_[a-f0-9]{32}$/u.test(input.proposalId)) {
    throw new DesignError("INVALID_ARGUMENT", "proposalId is invalid");
  }
  return { sessionId: safeSessionId(input.sessionId), proposalId: input.proposalId };
}

function parseSubmitPayload(payload: unknown): {
  readonly sessionId: string;
  readonly modelId: string;
  readonly draftRevision: number;
  readonly irContractHash: string;
  readonly parameters: Readonly<Record<string, unknown>>;
} {
  const input = record(payload);
  return {
    sessionId: safeSessionId(input.sessionId),
    modelId: safeModelId(input.modelId),
    draftRevision: natural(input.draftRevision, "draftRevision"),
    irContractHash: safeHash(input.irContractHash),
    parameters: record(input.parameters),
  };
}

function requireDraft(
  session: DesignSessionState,
  modelId: string,
  draftRevision: number,
  schemaHash: string,
): DesignDraftState {
  const draft = session.draft;
  if (
    draft === null || session.selectedModelId !== modelId || draft.modelId !== modelId ||
    draft.revision !== draftRevision || draft.schema.schemaHash !== schemaHash
  ) {
    throw new DesignError("INVALID_ARGUMENT", "The Design draft is stale");
  }
  return draft;
}

function draftWire(draft: DesignDraftState): NonNullable<DesignSnapshotWire["draft"]> {
  const fields = flattenUiFields(draft.schema.fields).map(fieldWire);
  const promptPath = draft.schema.primaryPromptPath;
  if (promptPath === null || !fields.some((field) => field.path === promptPath)) {
    throw new DesignError("SCHEMA_INVALID", "The Design prompt field is unavailable");
  }
  return {
    modelId: draft.modelId,
    draftRevision: draft.revision,
    irContractHash: draft.schema.schemaHash,
    primaryInputPath: promptPath,
    fields,
    parameters: flattenParameters(draft.parameters, fields),
  };
}

function flattenUiFields(fields: readonly UiField[]): readonly UiField[] {
  const output: UiField[] = [];
  const visit = (field: UiField): void => {
    if (field.kind === "object" && field.properties.length > 0) {
      field.properties.forEach(visit);
      return;
    }
    output.push(field);
  };
  fields.forEach(visit);
  return output;
}

function fieldWire(field: UiField): DesignFieldWire {
  const options = field.enumValues.flatMap((value) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? [{ label: String(value), value }]
      : []);
  const isEnum = options.length > 0;
  const kind = isEnum
    ? "enum" as const
    : field.kind === "unknown"
      ? "object" as const
      : field.kind;
  const widget = isEnum
    ? "select" as const
    : kind === "boolean"
      ? "switch" as const
      : kind === "media"
        ? "media" as const
        : kind === "string" && (field.key === "prompt" || (field.constraints.maxLength ?? 0) > 256)
          ? "textarea" as const
          : kind === "string" || kind === "number" || kind === "integer"
            ? "input" as const
            : "json" as const;
  return {
    path: field.path,
    label: field.title,
    description: field.description,
    kind,
    widget,
    required: field.required,
    options,
    minimum: field.constraints.minimum,
    maximum: field.constraints.maximum,
    step: kind === "integer" ? 1 : null,
    maxLength: field.constraints.maxLength,
    disabledReason: field.kind === "unknown" ? "This field requires JSON input." : null,
  };
}

function flattenParameters(
  parameters: Readonly<Record<string, JsonValue>>,
  fields: readonly DesignFieldWire[],
): Readonly<Record<string, JsonValue>> {
  const output: Record<string, JsonValue> = {};
  for (const field of fields) {
    const value = pointerValue(parameters, field.path);
    if (value !== undefined) output[field.path] = value;
  }
  return output;
}

function indexUiFields(fields: readonly UiField[]): ReadonlyMap<string, UiField> {
  const result = new Map<string, UiField>();
  const visit = (field: UiField): void => {
    result.set(field.path, field);
    field.properties.forEach(visit);
    if (field.item !== null) visit(field.item);
    field.variants.forEach((variant) => visit(variant.field));
  };
  fields.forEach(visit);
  return result;
}

function pointerValue(root: Readonly<Record<string, JsonValue>>, pointer: string): JsonValue | undefined {
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current as JsonValue | undefined;
}

function taskWire(task: DesignTaskRecord, now: number): DesignSnapshotWire["jobs"][number] {
  const resources = task.resources.flatMap((resource, index) => {
    const expiresAt = resource.expiresAt ?? task.expiresAt ??
      (task.completedAt ?? task.updatedAt) + DEFAULT_RESULT_TTL_MS;
    if (expiresAt <= now) return [];
    return [{
      id: `resource_${String(index)}_${createHash("sha256").update(resource.url).digest("hex").slice(0, 16)}`,
      kind: resource.kind,
      url: resource.url,
      downloadUrl: resource.url,
      expiresAt: new Date(expiresAt).toISOString(),
    }];
  });
  const status = designStatus(task, resources.length, task.resources.length, now);
  return {
    jobId: task.taskId ?? task.requestId,
    modelId: task.modelSlug,
    status,
    createdAt: new Date(task.createdAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
    resources,
    diagnostic: status === "submit-unknown"
      ? { code: "submit-unknown", message: "The generation outcome is unknown.", retryable: false }
      : status === "failed"
        ? { code: "generation-failed", message: "The generation was not completed.", retryable: false }
        : status === "succeeded" && resources.length === 0
          ? { code: "result-unavailable", message: "The generation completed without a usable output resource.", retryable: false }
        : null,
  };
}

function designStatus(
  task: DesignTaskRecord,
  availableResources: number,
  recordedResources: number,
  now: number,
): DesignSnapshotWire["jobs"][number]["status"] {
  switch (task.state) {
    case "submitting":
    case "submit-unknown":
      return "submit-unknown";
    case "queued":
    case "running":
    case "unknown":
      return "running";
    case "succeeded": {
      const fallbackExpiry = (task.completedAt ?? task.updatedAt) + DEFAULT_RESULT_TTL_MS;
      return availableResources === 0 &&
        (recordedResources > 0 || (task.expiresAt ?? fallbackExpiry) <= now)
        ? "expired"
        : "succeeded";
    }
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
  }
}

function ensureSelectedModel(
  models: readonly DesignModelWire[],
  selectedModelId: string | null,
): readonly DesignModelWire[] {
  if (selectedModelId === null || models.some((model) => model.id === selectedModelId)) return models;
  const unavailable: DesignModelWire = {
    id: selectedModelId,
    label: selectedModelId,
    kind: "unknown",
    featured: false,
    available: false,
    unavailableReason: "The selected model is no longer in the current catalog.",
  };
  return [unavailable, ...models].slice(0, 1_000);
}

function chooseDefaultModel(
  models: readonly DesignModelWire[],
  lastModel: string | null,
): string | null {
  const available = models.filter((model) => model.available);
  if (lastModel !== null && available.some((model) => model.id === lastModel)) {
    return lastModel;
  }
  for (const modelId of PREFERRED_DEFAULT_MODELS) {
    if (available.some((model) => model.id === modelId)) return modelId;
  }
  return available.find((model) => model.kind === "image")?.id ?? available[0]?.id ?? null;
}

function chooseDefaultModelFromSummaries(
  models: readonly DesignModelSummary[],
  lastModel: string | null,
): string | null {
  if (lastModel !== null && models.some((model) => model.slug === lastModel)) {
    return lastModel;
  }
  for (const modelId of PREFERRED_DEFAULT_MODELS) {
    if (models.some((model) => model.slug === modelId)) return modelId;
  }
  return models.find((model) => model.categories.includes("image"))?.slug ??
    models[0]?.slug ?? null;
}

function splitModel(modelId: string): [string, string] {
  safeModelId(modelId);
  const [provider, model] = modelId.split("/");
  return [provider as string, model as string];
}

function safeSessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID.test(value)) {
    throw new DesignError("INVALID_ARGUMENT", "sessionId is invalid");
  }
  return value;
}

function safeModelId(value: unknown): string {
  if (typeof value !== "string" || !MODEL_SLUG.test(value)) {
    throw new DesignError("INVALID_ARGUMENT", "modelId is invalid");
  }
  return value;
}

function safeHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new DesignError("INVALID_ARGUMENT", "irContractHash is invalid");
  }
  return value;
}

function natural(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DesignError("INVALID_ARGUMENT", `${field} is invalid`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DesignError("INVALID_ARGUMENT", "Design payload must be an object");
  }
  return value as Record<string, unknown>;
}

function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
