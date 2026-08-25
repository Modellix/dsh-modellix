import {
  parseRetryAfter,
  toModellixError,
  type ModellixErrorContract,
} from "../core/index.js";

export const MODELLIX_LLM_BASE_URL = "https://llm.modellix.ai/v1" as const;
export const MODELLIX_LLM_MODELS_URL = `${MODELLIX_LLM_BASE_URL}/models` as const;

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 5_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;

export interface LlmCredentialSnapshot {
  readonly value: string;
  readonly credentialEpoch: number;
}

export interface ModellixLlmModel {
  readonly id: string;
  readonly name?: string;
}

export interface ModellixLlmCatalog {
  readonly models: readonly ModellixLlmModel[];
  readonly credentialEpoch: number;
  readonly fetchedAt: number;
}

export interface LlmCatalogClientOptions {
  readonly resolveCredential: () => Promise<LlmCredentialSnapshot | undefined>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly maxResponseBytes?: number;
}

export class LlmCatalogRequestError extends Error {
  readonly contract: ModellixErrorContract;

  constructor(contract: ModellixErrorContract) {
    super(contract.messageKey);
    this.name = "LlmCatalogRequestError";
    this.contract = contract;
  }
}

export class StaleLlmCatalogError extends Error {
  readonly expectedCredentialEpoch: number;
  readonly actualCredentialEpoch: number;

  constructor(expectedCredentialEpoch: number, actualCredentialEpoch: number) {
    super("Credential changed while the Modellix LLM catalog was loading");
    this.name = "StaleLlmCatalogError";
    this.expectedCredentialEpoch = expectedCredentialEpoch;
    this.actualCredentialEpoch = actualCredentialEpoch;
  }
}

/**
 * Authenticated, read-only Modellix LLM catalog client. The resolved key lives
 * only in the request closure and is never retained on the instance or result.
 */
export class LlmCatalogClient {
  readonly #resolveCredential: LlmCatalogClientOptions["resolveCredential"];
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #maxResponseBytes: number;

  constructor(options: LlmCatalogClientOptions) {
    this.#resolveCredential = options.resolveCredential;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#maxResponseBytes = options.maxResponseBytes ?? MAX_CATALOG_BYTES;
    if (!Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1) {
      throw new TypeError("maxResponseBytes must be a positive safe integer");
    }
  }

  async fetchModels(signal?: AbortSignal): Promise<ModellixLlmCatalog> {
    const credential = await this.#resolveCredential();
    if (credential === undefined) {
      throw new LlmCatalogRequestError(toModellixError({
        service: "llm",
        subsystem: "catalog",
        operation: "list-models",
      }, { kind: "http", status: 401 }));
    }
    assertCredentialSnapshot(credential);

    let response: Response;
    try {
      response = await this.#fetch(MODELLIX_LLM_MODELS_URL, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential.value}`,
        },
        redirect: "manual",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      const kind = signal?.aborted || isAbortError(error) ? "abort" : "network";
      throw new LlmCatalogRequestError(toModellixError({
        service: "llm",
        subsystem: "catalog",
        operation: "list-models",
        credentialEpoch: credential.credentialEpoch,
      }, { kind }));
    }

    if (response.status >= 300 && response.status < 400) {
      throw unexpected(credential.credentialEpoch);
    }
    if (!response.ok) {
      throw new LlmCatalogRequestError(toModellixError({
        service: "llm",
        subsystem: "catalog",
        operation: "list-models",
        credentialEpoch: credential.credentialEpoch,
      }, {
        kind: "http",
        status: response.status,
        requestId: response.headers.get("x-request-id"),
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), this.#now()),
      }));
    }

    const raw = await readBoundedJson(response, this.#maxResponseBytes, credential.credentialEpoch);
    return {
      models: parseCatalog(raw, credential.credentialEpoch),
      credentialEpoch: credential.credentialEpoch,
      fetchedAt: this.#now(),
    };
  }
}

export interface LlmCatalogCacheOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/** Five-minute epoch-keyed cache with one in-flight read per credential epoch. */
export class LlmCatalogCache {
  readonly #client: LlmCatalogClient;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #cached: ModellixLlmCatalog | undefined;
  #inflight: { epoch: number; promise: Promise<ModellixLlmCatalog> } | undefined;

  constructor(client: LlmCatalogClient, options: LlmCatalogCacheOptions = {}) {
    this.#client = client;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 0) {
      throw new TypeError("ttlMs must be a non-negative safe integer");
    }
  }

  peek(credentialEpoch: number): ModellixLlmCatalog | undefined {
    const cached = this.#cached;
    return cached !== undefined && cached.credentialEpoch === credentialEpoch
      && this.#now() - cached.fetchedAt <= this.#ttlMs
      ? cached
      : undefined;
  }

  async get(credentialEpoch: number, options: {
    readonly force?: boolean;
    readonly signal?: AbortSignal;
  } = {}): Promise<ModellixLlmCatalog> {
    assertEpoch(credentialEpoch);
    const cached = options.force === true ? undefined : this.peek(credentialEpoch);
    if (cached !== undefined) return cached;
    if (this.#inflight?.epoch === credentialEpoch) return this.#inflight.promise;

    const promise = this.#client.fetchModels(options.signal).then((catalog) => {
      if (catalog.credentialEpoch !== credentialEpoch) {
        throw new StaleLlmCatalogError(credentialEpoch, catalog.credentialEpoch);
      }
      this.#cached = catalog;
      return catalog;
    }).finally(() => {
      if (this.#inflight?.promise === promise) this.#inflight = undefined;
    });
    this.#inflight = { epoch: credentialEpoch, promise };
    return promise;
  }

  invalidate(): void {
    this.#cached = undefined;
  }
}

function parseCatalog(value: unknown, credentialEpoch: number): ModellixLlmModel[] {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > MAX_MODELS) {
    throw unexpected(credentialEpoch);
  }
  const seen = new Set<string>();
  const models: ModellixLlmModel[] = [];
  for (const item of value.data) {
    if (!isRecord(item) || typeof item.id !== "string" || !MODEL_ID.test(item.id)) {
      throw unexpected(credentialEpoch);
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const name = typeof item.name === "string" && isSafeDisplayName(item.name)
      ? item.name
      : undefined;
    models.push(name === undefined ? { id: item.id } : { id: item.id, name });
  }
  if (models.length === 0) throw unexpected(credentialEpoch);
  return models;
}

async function readBoundedJson(
  response: Response,
  maximum: number,
  credentialEpoch: number,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximum) {
    throw unexpected(credentialEpoch);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximum) throw unexpected(credentialEpoch);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw unexpected(credentialEpoch);
  }
}

function unexpected(credentialEpoch: number): LlmCatalogRequestError {
  return new LlmCatalogRequestError(toModellixError({
    service: "llm",
    subsystem: "catalog",
    operation: "list-models",
    credentialEpoch,
  }, { kind: "unexpected-response" }));
}

function assertCredentialSnapshot(value: LlmCredentialSnapshot): void {
  if (typeof value.value !== "string" || value.value.length === 0) {
    throw new TypeError("resolved Credential must be a non-empty string");
  }
  assertEpoch(value.credentialEpoch);
}

function assertEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("credentialEpoch must be a non-negative safe integer");
  }
}

function isSafeDisplayName(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !hasControlCharacters(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
