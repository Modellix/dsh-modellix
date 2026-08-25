import { createHash } from "node:crypto";
import { MODELLIX_CREDENTIAL_REF } from "../core/index.js";
import type { ModellixLlmModel } from "./catalog.js";

export const MODELLIX_LLM_PROVIDER_ID = "modellix" as const;

export interface PiAiModelEntry {
  readonly id: string;
  readonly name?: string;
  readonly [key: string]: unknown;
}

export interface ModellixPiAiRoute {
  readonly apiKeyEnv: typeof MODELLIX_CREDENTIAL_REF;
  readonly displayName: "Modellix";
  readonly api: "openai-completions";
  readonly baseURL: "https://llm.modellix.ai/v1";
  readonly defaultInput: readonly ["text"];
  readonly retryPolicy: {
    readonly mode: "normal";
    readonly maxRetries: 0;
  };
  readonly models: readonly PiAiModelEntry[];
  readonly [key: string]: unknown;
}

export type LlmRouteOwnership = "none" | "created" | "adopted";

export interface LlmOwnedEntry {
  readonly kind: "field" | "model";
  readonly key: string;
  readonly appliedFingerprint: string;
}

export interface LlmRouteLedger {
  readonly ownership: LlmRouteOwnership;
  readonly appliedRouteFingerprint: string | null;
  readonly entries: readonly LlmOwnedEntry[];
}

export interface RouteMaterializationPlan {
  readonly route: ModellixPiAiRoute & Record<string, unknown>;
  readonly ledger: LlmRouteLedger;
  readonly changed: boolean;
}

export class LlmRouteConflictError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Existing Modellix LLM route has an incompatible ${field}`);
    this.name = "LlmRouteConflictError";
    this.field = field;
  }
}

const WIRE_FIELDS = Object.freeze({
  apiKeyEnv: MODELLIX_CREDENTIAL_REF,
  displayName: "Modellix",
  api: "openai-completions",
  baseURL: "https://llm.modellix.ai/v1",
  defaultInput: ["text"],
  retryPolicy: { mode: "normal", maxRetries: 0 },
} as const);

export const EMPTY_LLM_ROUTE_LEDGER: LlmRouteLedger = Object.freeze({
  ownership: "none",
  appliedRouteFingerprint: null,
  entries: [],
});

/**
 * Merge a live catalog into one llm-pi-ai route without replacing unknown
 * fields or hand-authored model metadata. Previously plugin-owned models may
 * be removed only while their exact applied fingerprint still matches.
 */
export function planLlmRouteMaterialization(
  current: unknown,
  catalog: readonly ModellixLlmModel[],
  previous: LlmRouteLedger = EMPTY_LLM_ROUTE_LEDGER,
): RouteMaterializationPlan {
  assertCatalog(catalog);
  const existing = current === undefined ? undefined : requireRecord(current, "route");
  if (existing !== undefined) assertCompatible(existing);

  const previousOwned = new Map(previous.entries
    .filter((entry) => entry.kind === "model")
    .map((entry) => [entry.key, entry.appliedFingerprint]));
  const existingModels = existing?.models === undefined
    ? []
    : requireModelArray(existing.models);
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  const models: PiAiModelEntry[] = [];
  const present = new Set<string>();

  for (const model of existingModels) {
    const ownedFingerprint = previousOwned.get(model.id);
    const advertised = catalogById.get(model.id);
    if (ownedFingerprint !== undefined && fingerprint(model) === ownedFingerprint) {
      if (advertised === undefined) continue;
      models.push(mergeOwnedModel(model, advertised));
    } else {
      models.push({ ...model });
    }
    present.add(model.id);
  }
  for (const model of catalog) {
    if (present.has(model.id)) continue;
    models.push(model.name === undefined ? { id: model.id } : { id: model.id, name: model.name });
    present.add(model.id);
  }

  const route = {
    ...existing,
    ...WIRE_FIELDS,
    defaultInput: [...WIRE_FIELDS.defaultInput] as ["text"],
    retryPolicy: { ...WIRE_FIELDS.retryPolicy },
    models,
  } as ModellixPiAiRoute & Record<string, unknown>;

  const oldModelMap = new Map(existingModels.map((model) => [model.id, model]));
  const ownedEntries: LlmOwnedEntry[] = [
    ...Object.entries(WIRE_FIELDS).map(([key, value]) => ({
      kind: "field" as const,
      key: `/${key}`,
      appliedFingerprint: fingerprint(value),
    })),
    ...models.filter((model) => {
      const before = oldModelMap.get(model.id);
      return before === undefined || previousOwned.has(model.id);
    }).map((model) => ({
      kind: "model" as const,
      key: model.id,
      appliedFingerprint: fingerprint(model),
    })),
  ];
  const nextFingerprint = fingerprint(route);
  return {
    route,
    ledger: {
      ownership: existing === undefined ? "created" : "adopted",
      appliedRouteFingerprint: nextFingerprint,
      entries: ownedEntries,
    },
    changed: fingerprint(existing) !== nextFingerprint,
  };
}

export interface RouteRemovalPlan {
  readonly action: "none" | "unset-route" | "set-route" | "conflict";
  readonly route?: Record<string, unknown>;
  readonly ledger: LlmRouteLedger;
}

/** Remove only values still byte-for-byte owned by the plugin. */
export function planLlmRouteRemoval(
  current: unknown,
  ledger: LlmRouteLedger,
): RouteRemovalPlan {
  if (ledger.ownership === "none" || current === undefined) {
    return { action: "none", ledger: EMPTY_LLM_ROUTE_LEDGER };
  }
  const route = requireRecord(current, "route");
  if (ledger.ownership === "created") {
    return fingerprint(route) === ledger.appliedRouteFingerprint
      ? { action: "unset-route", ledger: EMPTY_LLM_ROUTE_LEDGER }
      : { action: "conflict", ledger };
  }

  const next: Record<string, unknown> = structuredClone(route);
  let changed = false;
  for (const entry of ledger.entries) {
    if (entry.kind === "field") {
      const field = entry.key.slice(1);
      if (fingerprint(next[field]) === entry.appliedFingerprint) {
        delete next[field];
        changed = true;
      }
      continue;
    }
    if (!Array.isArray(next.models)) continue;
    const index = next.models.findIndex((value) => isRecord(value) && value.id === entry.key);
    if (index >= 0 && fingerprint(next.models[index]) === entry.appliedFingerprint) {
      next.models.splice(index, 1);
      changed = true;
    }
  }
  return {
    action: changed ? "set-route" : "none",
    ...(changed ? { route: next } : {}),
    ledger: EMPTY_LLM_ROUTE_LEDGER,
  };
}

export interface SettingsNamespaceDescriptor {
  readonly revision: number;
  readonly user?: unknown;
}

export interface LlmSettingsPort {
  describe(): Promise<SettingsNamespaceDescriptor | undefined>;
  mutate(
    operations: readonly {
      readonly op: "set" | "unset";
      readonly path: readonly string[];
      readonly value?: unknown;
    }[],
    expectedRevision: number,
  ): Promise<void>;
}

/** CAS materializer over the public Settings namespace contract. */
export class LlmSettingsMaterializer {
  readonly #settings: LlmSettingsPort;

  constructor(settings: LlmSettingsPort) {
    this.#settings = settings;
  }

  async materialize(
    catalog: readonly ModellixLlmModel[],
    ledger: LlmRouteLedger,
  ): Promise<LlmRouteLedger> {
    const descriptor = await this.#settings.describe();
    if (descriptor === undefined) throw new Error("llm-pi-ai settings namespace is unavailable");
    const user = descriptor.user === undefined ? {} : requireRecord(descriptor.user, "settings user section");
    const providers = user.providers === undefined ? {} : requireRecord(user.providers, "providers");
    const plan = planLlmRouteMaterialization(providers[MODELLIX_LLM_PROVIDER_ID], catalog, ledger);
    if (plan.changed) {
      await this.#settings.mutate([{
        op: "set",
        path: ["providers", MODELLIX_LLM_PROVIDER_ID],
        value: plan.route,
      }], descriptor.revision);
    }
    return plan.ledger;
  }

  async remove(ledger: LlmRouteLedger): Promise<LlmRouteLedger> {
    const descriptor = await this.#settings.describe();
    if (descriptor === undefined) return ledger;
    const user = descriptor.user === undefined ? {} : requireRecord(descriptor.user, "settings user section");
    const providers = user.providers === undefined ? {} : requireRecord(user.providers, "providers");
    const plan = planLlmRouteRemoval(providers[MODELLIX_LLM_PROVIDER_ID], ledger);
    if (plan.action === "conflict") return ledger;
    if (plan.action === "unset-route") {
      await this.#settings.mutate([{
        op: "unset",
        path: ["providers", MODELLIX_LLM_PROVIDER_ID],
      }], descriptor.revision);
    } else if (plan.action === "set-route") {
      await this.#settings.mutate([{
        op: "set",
        path: ["providers", MODELLIX_LLM_PROVIDER_ID],
        value: plan.route,
      }], descriptor.revision);
    }
    return plan.ledger;
  }
}

function assertCompatible(route: Record<string, unknown>): void {
  for (const [field, expected] of Object.entries(WIRE_FIELDS)) {
    if (route[field] !== undefined && fingerprint(route[field]) !== fingerprint(expected)) {
      throw new LlmRouteConflictError(field);
    }
  }
}

function mergeOwnedModel(before: PiAiModelEntry, next: ModellixLlmModel): PiAiModelEntry {
  return next.name === undefined ? { ...before, id: next.id } : { ...before, id: next.id, name: next.name };
}

function assertCatalog(catalog: readonly ModellixLlmModel[]): void {
  if (!Array.isArray(catalog) || catalog.length === 0 || catalog.length > 5_000) {
    throw new TypeError("catalog must contain 1-5000 models");
  }
  const ids = new Set<string>();
  for (const model of catalog) {
    if (!isRecord(model) || typeof model.id !== "string" || model.id.length > 256 || !model.id.includes("/")) {
      throw new TypeError("catalog contains an invalid model id");
    }
    if (ids.has(model.id)) throw new TypeError(`catalog contains duplicate model ${model.id}`);
    ids.add(model.id);
  }
}

function requireModelArray(value: unknown): PiAiModelEntry[] {
  if (!Array.isArray(value) || value.length > 5_000) throw new LlmRouteConflictError("models");
  const seen = new Set<string>();
  return value.map((item) => {
    const record = requireRecord(item, "model");
    if (typeof record.id !== "string" || record.id.length === 0 || seen.has(record.id)) {
      throw new LlmRouteConflictError("models");
    }
    seen.add(record.id);
    return { ...record, id: record.id } as PiAiModelEntry;
  });
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("fingerprinted values must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) throw new TypeError("fingerprinted values must be JSON-compatible");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new LlmRouteConflictError(field);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
