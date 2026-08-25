export const MODELLIX_CLIENT_WIRE_VERSION = 1 as const;
export const MODELLIX_RPC_CHANNEL = "/modellix" as const;

export const MODELLIX_RPC_ENDPOINTS = Object.freeze({
  stateGet: "state/get",
  credentialSave: "credential/save",
  onboardingDefer: "onboarding/defer",
  settingsToggles: "settings/toggles",
  credentialRemove: "credential/remove",
  llmRefresh: "llm/refresh",
  designRead: "design/read",
  designRefresh: "design/refresh",
  designSelectModel: "design/select-model",
  designPropose: "design/propose",
  designProposalApply: "design/proposal/apply",
  designProposalReject: "design/proposal/reject",
  designSubmit: "design/submit",
});

export type ModellixRpcEndpoint =
  (typeof MODELLIX_RPC_ENDPOINTS)[keyof typeof MODELLIX_RPC_ENDPOINTS];

export interface ServiceTogglesWire {
  readonly design: boolean;
  readonly llm: boolean;
  readonly web: boolean;
}

export type CredentialVerificationWire =
  | "unknown"
  | "unverified"
  | "valid"
  | "invalid";

export interface CredentialDescriptorWire {
  readonly configured: boolean;
  readonly source: "local" | "env" | null;
  readonly writable: boolean;
  /** Opaque Host descriptor token. The Client may echo it for CAS but never renders it. */
  readonly revision: string | null;
  readonly credentialEpoch: number;
  readonly verification: CredentialVerificationWire;
  readonly invalidEpoch: number | null;
}

export interface SettingsSnapshotWire {
  readonly version: 1;
  readonly settingsRevision: number;
  readonly services: ServiceTogglesWire;
  readonly credential: CredentialDescriptorWire;
  readonly onboarding: {
    readonly status: "active" | "completed" | "deferred";
    readonly recoveryPending: boolean;
  };
  readonly llm: {
    readonly health:
      | "unknown"
      | "missing"
      | "disabled"
      | "ready"
      | "error"
      | "policy-blocked";
    readonly modelCount: number;
    readonly refreshedAt: number | null;
  };
}

export type ClientJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ClientJsonValue[]
  | { readonly [key: string]: ClientJsonValue };

export interface DesignModelWire {
  readonly id: string;
  readonly label: string;
  readonly kind: "image" | "video" | "audio" | "unknown";
  readonly featured: boolean;
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

export interface DesignEnumOptionWire {
  readonly label: string;
  readonly value: string | number | boolean;
}

export interface DesignFieldWire {
  readonly path: string;
  readonly label: string;
  readonly description: string | null;
  readonly kind:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "enum"
    | "array"
    | "object"
    | "media";
  readonly widget: "input" | "textarea" | "select" | "switch" | "json" | "media";
  readonly required: boolean;
  readonly options: readonly DesignEnumOptionWire[];
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly step: number | null;
  readonly maxLength: number | null;
  readonly disabledReason: string | null;
}

export interface DesignDraftWire {
  readonly modelId: string;
  readonly draftRevision: number;
  readonly irContractHash: string;
  readonly primaryInputPath: string;
  readonly fields: readonly DesignFieldWire[];
  /** Flattened IR field path -> JSON value. The Host revalidates before submit. */
  readonly parameters: Readonly<Record<string, ClientJsonValue>>;
}

export interface DesignProposalChangeWire {
  readonly path: string;
  readonly label: string;
  readonly before: ClientJsonValue | undefined;
  readonly after: ClientJsonValue | undefined;
}

export interface DesignProposalWire {
  readonly proposalId: string;
  readonly baseDraftRevision: number;
  readonly summary: string;
  readonly changes: readonly DesignProposalChangeWire[];
  readonly conflicts: readonly string[];
}

export interface DesignResourceWire {
  readonly id: string;
  readonly kind: "image" | "video" | "audio";
  readonly url: string;
  readonly downloadUrl: string;
  readonly expiresAt: string | null;
}

export interface DesignDiagnosticWire {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface DesignJobWire {
  readonly jobId: string;
  readonly modelId: string;
  readonly status:
    | "running"
    | "succeeded"
    | "failed"
    | "canceled"
    | "submit-unknown"
    | "expired";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resources: readonly DesignResourceWire[];
  readonly diagnostic: DesignDiagnosticWire | null;
}

export interface DesignSnapshotWire {
  readonly version: 1;
  readonly enabled: boolean;
  readonly credentialReady: boolean;
  readonly models: readonly DesignModelWire[];
  readonly selectedModelId: string | null;
  readonly draft: DesignDraftWire | null;
  readonly proposal: DesignProposalWire | null;
  readonly jobs: readonly DesignJobWire[];
  readonly notice: string | null;
}

export interface AckWire {
  readonly version: 1;
  readonly accepted: true;
}

export type SettingsMutationWire =
  | {
      readonly version: 1;
      readonly accepted: true;
      readonly state: SettingsSnapshotWire;
    }
  | {
      readonly version: 1;
      readonly accepted: false;
      readonly code: "credential-changed" | "settings-changed";
      readonly messageKey: null;
      readonly state: SettingsSnapshotWire;
    }
  | {
      readonly version: 1;
      readonly accepted: false;
      readonly code: string;
      readonly messageKey: string;
      readonly state: null;
    };

export class ModellixClientContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModellixClientContractError";
  }
}

const MAX_TEXT = 32_000;
const MAX_SHORT_TEXT = 4_096;
const MAX_ID = 256;
const MAX_MODELS = 1_000;
const MAX_FIELDS = 256;
const MAX_OPTIONS = 256;
const MAX_JOBS = 1_000;
const MAX_RESOURCES = 32;
const MAX_RESOURCE_URL = 16_384;
const MAX_JSON_DEPTH = 10;
const MAX_JSON_NODES = 4_096;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SAFE_HASH = /^[A-Za-z0-9._:-]{8,256}$/;
const FORBIDDEN_RESPONSE_KEY =
  /^(?:api[-_]?key|authorization|secret|password|mask(?:ed)?|last[-_]?four|last4|credential[-_]?value)$/iu;

export function parseSettingsSnapshot(input: unknown): SettingsSnapshotWire {
  assertNoSecretFields(input);
  const root = object(input, "settings snapshot");
  version(root.version);
  const credential = object(root.credential, "credential descriptor");
  const configured = boolean(credential.configured, "credential.configured");
  const source = oneOf(credential.source, ["local", "env", null] as const, "credential.source");
  const writable = boolean(credential.writable, "credential.writable");
  if (!configured && source !== null) {
    throw new ModellixClientContractError("missing Credential cannot expose a source");
  }
  if (configured && source === null) {
    throw new ModellixClientContractError("configured Credential must expose a source");
  }
  if (source === "env" && writable) {
    throw new ModellixClientContractError("environment Credential must be read-only");
  }
  const revision = opaqueRevision(credential.revision);
  if (configured !== (revision !== null)) {
    throw new ModellixClientContractError(
      "Credential revision presence disagrees with configured state",
    );
  }

  return {
    version: 1,
    settingsRevision: natural(root.settingsRevision, "settingsRevision"),
    services: parseServices(root.services),
    credential: {
      configured,
      source,
      writable,
      revision,
      credentialEpoch: natural(
        credential.credentialEpoch,
        "credential.credentialEpoch",
      ),
      verification: oneOf(
        credential.verification,
        ["unknown", "unverified", "valid", "invalid"] as const,
        "credential.verification",
      ),
      invalidEpoch:
        credential.invalidEpoch === null
          ? null
          : natural(credential.invalidEpoch, "credential.invalidEpoch"),
    },
    onboarding: parseOnboarding(root.onboarding),
    llm: parseLlmHealth(root.llm),
  };
}

export function parseDesignSnapshot(input: unknown): DesignSnapshotWire {
  assertNoSecretFields(input);
  const root = object(input, "Design snapshot");
  version(root.version);
  const models = array(root.models, "models", MAX_MODELS).map(parseModel);
  const selectedModelId =
    root.selectedModelId === null
      ? null
      : safeId(root.selectedModelId, "selectedModelId");
  if (
    selectedModelId !== null &&
    !models.some((candidate) => candidate.id === selectedModelId)
  ) {
    throw new ModellixClientContractError(
      "selectedModelId is absent from the model catalog",
    );
  }
  const draft = root.draft === null ? null : parseDraft(root.draft);
  if (draft !== null && draft.modelId !== selectedModelId) {
    throw new ModellixClientContractError(
      "Design draft does not belong to the selected model",
    );
  }

  return {
    version: 1,
    enabled: boolean(root.enabled, "enabled"),
    credentialReady: boolean(root.credentialReady, "credentialReady"),
    models,
    selectedModelId,
    draft,
    proposal: root.proposal === null ? null : parseProposal(root.proposal),
    jobs: array(root.jobs, "jobs", MAX_JOBS).map(parseJob),
    notice:
      root.notice === null ? null : readable(root.notice, "notice", MAX_SHORT_TEXT),
  };
}

export function parseAck(input: unknown): AckWire {
  assertNoSecretFields(input);
  const root = object(input, "acknowledgement");
  version(root.version);
  if (root.accepted !== true) {
    throw new ModellixClientContractError("acknowledgement was not accepted");
  }
  return { version: 1, accepted: true };
}

export function parseSettingsMutation(input: unknown): SettingsMutationWire {
  assertNoSecretFields(input);
  const root = object(input, "settings mutation");
  version(root.version);
  if (root.accepted === true) {
    return {
      version: 1,
      accepted: true,
      state: parseSettingsSnapshot(root.state),
    };
  }
  if (root.accepted !== false) {
    throw new ModellixClientContractError(
      "settings mutation accepted flag is malformed",
    );
  }
  if (root.reason === "credential-changed" || root.reason === "settings-changed") {
    return {
      version: 1,
      accepted: false,
      code: root.reason,
      messageKey: null,
      state: parseSettingsSnapshot(root.state),
    };
  }
  const error = object(root.error, "settings mutation error");
  return {
    version: 1,
    accepted: false,
    code: stableErrorCode(error.code),
    messageKey: stableMessageKey(error.messageKey),
    state: null,
  };
}

export function sanitizeParameters(
  input: Readonly<Record<string, ClientJsonValue>>,
): Readonly<Record<string, ClientJsonValue>> {
  const value = jsonObject(input, "parameters");
  return value;
}

export function safeResourceHref(value: string): string {
  if (value.length < 1 || value.length > MAX_RESOURCE_URL || /\s/u.test(value)) {
    throw new ModellixClientContractError("resource URL is malformed");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ModellixClientContractError("resource URL must be absolute");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname.length === 0
  ) {
    throw new ModellixClientContractError(
      "resource URL must be credential-free HTTPS",
    );
  }
  return url.href;
}

function parseServices(value: unknown): ServiceTogglesWire {
  const services = object(value, "services");
  return {
    design: boolean(services.design, "services.design"),
    llm: boolean(services.llm, "services.llm"),
    web: boolean(services.web, "services.web"),
  };
}

function parseOnboarding(value: unknown): SettingsSnapshotWire["onboarding"] {
  const onboarding = object(value, "onboarding");
  return {
    status: oneOf(
      onboarding.status,
      ["active", "completed", "deferred"] as const,
      "onboarding.status",
    ),
    recoveryPending: boolean(
      onboarding.recoveryPending,
      "onboarding.recoveryPending",
    ),
  };
}

function parseLlmHealth(value: unknown): SettingsSnapshotWire["llm"] {
  const llm = object(value, "llm");
  return {
    health: oneOf(
      llm.health,
      [
        "unknown",
        "missing",
        "disabled",
        "ready",
        "error",
        "policy-blocked",
      ] as const,
      "llm.health",
    ),
    modelCount: natural(llm.modelCount, "llm.modelCount"),
    refreshedAt:
      llm.refreshedAt === null ? null : natural(llm.refreshedAt, "llm.refreshedAt"),
  };
}

function parseModel(value: unknown): DesignModelWire {
  const model = object(value, "model");
  return {
    id: safeId(model.id, "model.id"),
    label: readable(model.label, "model.label", MAX_SHORT_TEXT),
    kind: oneOf(
      model.kind,
      ["image", "video", "audio", "unknown"] as const,
      "model.kind",
    ),
    featured: boolean(model.featured, "model.featured"),
    available: boolean(model.available, "model.available"),
    unavailableReason:
      model.unavailableReason === null
        ? null
        : readable(
            model.unavailableReason,
            "model.unavailableReason",
            MAX_SHORT_TEXT,
          ),
  };
}

function parseDraft(value: unknown): DesignDraftWire {
  const draft = object(value, "draft");
  const fields = array(draft.fields, "draft.fields", MAX_FIELDS).map(parseField);
  const primaryInputPath = path(draft.primaryInputPath, "draft.primaryInputPath");
  if (!fields.some((field) => field.path === primaryInputPath)) {
    throw new ModellixClientContractError(
      "primaryInputPath is absent from the Schema IR fields",
    );
  }
  return {
    modelId: safeId(draft.modelId, "draft.modelId"),
    draftRevision: natural(draft.draftRevision, "draft.draftRevision"),
    irContractHash: hash(draft.irContractHash, "draft.irContractHash"),
    primaryInputPath,
    fields,
    parameters: jsonObject(draft.parameters, "draft.parameters"),
  };
}

function parseField(value: unknown): DesignFieldWire {
  const field = object(value, "field");
  const kind = oneOf(
    field.kind,
    [
      "string",
      "number",
      "integer",
      "boolean",
      "enum",
      "array",
      "object",
      "media",
    ] as const,
    "field.kind",
  );
  const options = array(field.options, "field.options", MAX_OPTIONS).map(
    (candidate): DesignEnumOptionWire => {
      const option = object(candidate, "field option");
      const optionValue = option.value;
      if (
        typeof optionValue !== "string" &&
        typeof optionValue !== "number" &&
        typeof optionValue !== "boolean"
      ) {
        throw new ModellixClientContractError(
          "field option value must be a scalar",
        );
      }
      if (typeof optionValue === "number" && !Number.isFinite(optionValue)) {
        throw new ModellixClientContractError(
          "field option number must be finite",
        );
      }
      return {
        label: readable(option.label, "field option label", MAX_SHORT_TEXT),
        value: optionValue,
      };
    },
  );
  if (kind === "enum" && options.length === 0) {
    throw new ModellixClientContractError("enum field must include options");
  }
  return {
    path: path(field.path, "field.path"),
    label: readable(field.label, "field.label", MAX_SHORT_TEXT),
    description:
      field.description === null
        ? null
        : readable(field.description, "field.description", MAX_TEXT),
    kind,
    widget: oneOf(
      field.widget,
      ["input", "textarea", "select", "switch", "json", "media"] as const,
      "field.widget",
    ),
    required: boolean(field.required, "field.required"),
    options,
    minimum: nullableFinite(field.minimum, "field.minimum"),
    maximum: nullableFinite(field.maximum, "field.maximum"),
    step: nullableFinite(field.step, "field.step"),
    maxLength:
      field.maxLength === null ? null : natural(field.maxLength, "field.maxLength"),
    disabledReason:
      field.disabledReason === null
        ? null
        : readable(field.disabledReason, "field.disabledReason", MAX_SHORT_TEXT),
  };
}

function parseProposal(value: unknown): DesignProposalWire {
  const proposal = object(value, "proposal");
  return {
    proposalId: safeId(proposal.proposalId, "proposal.proposalId"),
    baseDraftRevision: natural(
      proposal.baseDraftRevision,
      "proposal.baseDraftRevision",
    ),
    summary: readable(proposal.summary, "proposal.summary", MAX_TEXT),
    changes: array(proposal.changes, "proposal.changes", MAX_FIELDS).map(
      (candidate): DesignProposalChangeWire => {
        const change = object(candidate, "proposal change");
        return {
          path: path(change.path, "proposal change path"),
          label: readable(change.label, "proposal change label", MAX_SHORT_TEXT),
          before:
            change.before === undefined
              ? undefined
              : jsonValue(change.before, "proposal change before"),
          after:
            change.after === undefined
              ? undefined
              : jsonValue(change.after, "proposal change after"),
        };
      },
    ),
    conflicts: array(proposal.conflicts, "proposal.conflicts", MAX_FIELDS).map(
      (conflict) => readable(conflict, "proposal conflict", MAX_SHORT_TEXT),
    ),
  };
}

function parseJob(value: unknown): DesignJobWire {
  const job = object(value, "job");
  return {
    jobId: safeId(job.jobId, "job.jobId"),
    modelId: safeId(job.modelId, "job.modelId"),
    status: oneOf(
      job.status,
      [
        "running",
        "succeeded",
        "failed",
        "canceled",
        "submit-unknown",
        "expired",
      ] as const,
      "job.status",
    ),
    createdAt: isoTimestamp(job.createdAt, "job.createdAt"),
    updatedAt: isoTimestamp(job.updatedAt, "job.updatedAt"),
    resources: array(job.resources, "job.resources", MAX_RESOURCES).map(
      parseResource,
    ),
    diagnostic:
      job.diagnostic === null ? null : parseDiagnostic(job.diagnostic),
  };
}

function parseResource(value: unknown): DesignResourceWire {
  const resource = object(value, "resource");
  return {
    id: safeId(resource.id, "resource.id"),
    kind: oneOf(
      resource.kind,
      ["image", "video", "audio"] as const,
      "resource.kind",
    ),
    url: safeResourceHref(
      readable(resource.url, "resource.url", MAX_RESOURCE_URL),
    ),
    downloadUrl: safeResourceHref(
      readable(resource.downloadUrl, "resource.downloadUrl", MAX_RESOURCE_URL),
    ),
    expiresAt:
      resource.expiresAt === null
        ? null
        : isoTimestamp(resource.expiresAt, "resource.expiresAt"),
  };
}

function parseDiagnostic(value: unknown): DesignDiagnosticWire {
  const diagnostic = object(value, "diagnostic");
  return {
    code: safeId(diagnostic.code, "diagnostic.code"),
    message: readable(diagnostic.message, "diagnostic.message", MAX_SHORT_TEXT),
    retryable: boolean(diagnostic.retryable, "diagnostic.retryable"),
  };
}

function assertNoSecretFields(value: unknown): void {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) {
      throw new ModellixClientContractError("RPC response nesting is too deep");
    }
    if (typeof candidate !== "object" || candidate === null) return;
    if (seen.has(candidate)) {
      throw new ModellixClientContractError("RPC response contains a cycle");
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(candidate)) {
      if (FORBIDDEN_RESPONSE_KEY.test(key)) {
        throw new ModellixClientContractError(
          "RPC response attempted to expose a Secret-shaped field",
        );
      }
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

function jsonObject(value: unknown, label: string): Readonly<Record<string, ClientJsonValue>> {
  const parsed = jsonValue(value, label);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ModellixClientContractError(`${label} must be a JSON object`);
  }
  return parsed as Readonly<Record<string, ClientJsonValue>>;
}

function jsonValue(value: unknown, label: string): ClientJsonValue {
  const budget = { nodes: 0 };
  const parse = (candidate: unknown, depth: number): ClientJsonValue => {
    budget.nodes += 1;
    if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new ModellixClientContractError(`${label} exceeds the JSON budget`);
    }
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new ModellixClientContractError(`${label} contains a non-finite number`);
      }
      return candidate;
    }
    if (typeof candidate === "string") {
      return readable(candidate, label, MAX_TEXT);
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_FIELDS) {
        throw new ModellixClientContractError(`${label} contains an oversized array`);
      }
      return candidate.map((item) => parse(item, depth + 1));
    }
    if (typeof candidate === "object") {
      const entries = Object.entries(candidate);
      if (entries.length > MAX_FIELDS) {
        throw new ModellixClientContractError(`${label} contains an oversized object`);
      }
      const result: Record<string, ClientJsonValue> = {};
      for (const [key, item] of entries) {
        path(key, `${label} key`);
        result[key] = parse(item, depth + 1);
      }
      return result;
    }
    throw new ModellixClientContractError(`${label} contains a non-JSON value`);
  };
  return parse(value, 0);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModellixClientContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(
  value: unknown,
  label: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ModellixClientContractError(
      `${label} must be an array with at most ${maximum} items`,
    );
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ModellixClientContractError(`${label} must be boolean`);
  }
  return value;
}

function natural(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ModellixClientContractError(`${label} must be a natural number`);
  }
  return value;
}

function nullableFinite(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ModellixClientContractError(`${label} must be finite or null`);
  }
  return value;
}

function readable(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw new ModellixClientContractError(`${label} must be a bounded string`);
  }
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point === 0 || point === 127 || (point < 32 && !"\n\r\t".includes(character))) {
      throw new ModellixClientContractError(`${label} contains a control character`);
    }
  }
  return value;
}

function path(value: unknown, label: string): string {
  const result = readable(value, label, 512);
  if (result.length === 0) {
    throw new ModellixClientContractError(`${label} cannot be empty`);
  }
  return result;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > MAX_ID || !SAFE_ID.test(value)) {
    throw new ModellixClientContractError(`${label} is malformed`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_HASH.test(value)) {
    throw new ModellixClientContractError(`${label} is malformed`);
  }
  return value;
}

function opaqueRevision(value: unknown): string | null {
  if (value === null) return null;
  return readable(value, "credential.revision", 256);
}

function stableErrorCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:MODELLIX_[A-Z0-9_]{1,96}|[a-z][a-z0-9-]{0,63})$/u.test(value)
  ) {
    throw new ModellixClientContractError("mutation error code is malformed");
  }
  return value;
}

function stableMessageKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+){1,15}$/u.test(value) ||
    value.length > 256
  ) {
    throw new ModellixClientContractError("mutation messageKey is malformed");
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const result = readable(value, label, 64);
  if (!Number.isFinite(Date.parse(result))) {
    throw new ModellixClientContractError(`${label} must be an ISO timestamp`);
  }
  return result;
}

function oneOf<const T extends readonly unknown[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (!values.includes(value)) {
    throw new ModellixClientContractError(`${label} has an unsupported value`);
  }
  return value as T[number];
}

function version(value: unknown): void {
  if (value !== MODELLIX_CLIENT_WIRE_VERSION) {
    throw new ModellixClientContractError("RPC wire version is unsupported");
  }
}
