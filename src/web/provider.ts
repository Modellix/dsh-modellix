import {
  WebError,
  type WebFetchProvider,
  type WebFetchRequest,
  type WebFetchResult,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
} from "@deepseek-ai/dsh-web";

import {
  parseRetryAfter,
  approveHttpRequest,
  redactForLog,
  readBoundedResponseText,
  requestDeadline,
  toModellixError,
  type ModellixErrorContract,
  type RedactedValue,
} from "../core/index.js";
import {
  DEFAULT_WEB_RESPONSE_BYTES,
  MODELLIX_WEB_FETCH_ENDPOINT,
  MODELLIX_WEB_SEARCH_ENDPOINT,
  ModellixWebContractError,
  buildFetchRequest,
  buildSearchRequest,
  parseFetchResponse,
  parseSearchResponse,
} from "./contracts.js";

export const MODELLIX_WEB_PROVIDER_ID = "modellix" as const;

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_API_KEY_CHARS = 16 * 1024;
const MAX_CONFIGURED_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export interface ModellixWebCredentialSnapshot {
  /** Host-only secret. It must be resolved for each operation and never cached. */
  readonly apiKey: string;
  readonly credentialEpoch: number;
}

export interface ModellixWebProviderOptions {
  /** Cheap local switch state. */
  readonly isEnabled: () => boolean;
  /** Cheap local descriptor check. This callback must never resolve the Key. */
  readonly hasCredential: () => boolean;
  /** Resolves a fresh Host Credential snapshot for every paid request. */
  readonly resolveCredential: () => Promise<ModellixWebCredentialSnapshot | null>;
  /** Returns a stable, locally derived Modellix user identifier. */
  readonly getUserId: () => string;
  /** Rejects a stale 401 from an earlier Credential generation. */
  readonly isCredentialEpochCurrent: (credentialEpoch: number) => boolean;
  readonly onCredentialRejected?: (
    credentialEpoch: number,
    error: ModellixErrorContract,
  ) => void | Promise<void>;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

export interface ModellixWebProviders {
  readonly search: ModellixWebSearchProvider;
  readonly fetch: ModellixWebFetchProvider;
}

export interface ModellixWebRegistry {
  registerSearchProvider(provider: WebSearchProvider): () => void;
  registerFetchProvider(provider: WebFetchProvider): () => void;
}

export class ModellixWebProviderError extends WebError {
  readonly contract: ModellixErrorContract;
  readonly diagnostic: RedactedValue;

  constructor(
    contract: ModellixErrorContract,
    diagnostic: unknown = { code: contract.code },
  ) {
    super(messageFor(contract), contract.code, { cause: contract });
    this.contract = contract;
    this.diagnostic = redactForLog(diagnostic);
  }
}

export class ModellixWebFetchFailedError extends WebError {
  readonly requestId: string;
  readonly diagnostic: RedactedValue;

  constructor(requestId: string, url: string) {
    super(
      "Modellix Web Fetch could not retrieve the requested URL",
      "MODELLIX_WEB_FETCH_FAILED",
    );
    this.requestId = requestId;
    this.diagnostic = redactForLog({ requestId, url, outcome: "failed" });
  }
}

export class ModellixWebSearchProvider implements WebSearchProvider {
  readonly id = MODELLIX_WEB_PROVIDER_ID;
  readonly #transport: ModellixWebTransport;

  constructor(options: ModellixWebProviderOptions) {
    this.#transport = new ModellixWebTransport(options);
  }

  available(): boolean {
    return this.#transport.available();
  }

  async search(
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    let body: ReturnType<typeof buildSearchRequest>;
    try {
      body = buildSearchRequest(request.query, request.maxResults);
    } catch (error) {
      throw localContractError("search", error);
    }

    const payload = await this.#transport.post(
      MODELLIX_WEB_SEARCH_ENDPOINT,
      body,
      "search",
      signal,
    );
    try {
      return parseSearchResponse(payload.text, body.max_results).result;
    } catch (error) {
      throw paidOutcomeUnknownError("search", payload.credentialEpoch, error);
    }
  }
}

export class ModellixWebFetchProvider implements WebFetchProvider {
  readonly id = MODELLIX_WEB_PROVIDER_ID;
  readonly #transport: ModellixWebTransport;

  constructor(options: ModellixWebProviderOptions) {
    this.#transport = new ModellixWebTransport(options);
  }

  available(): boolean {
    return this.#transport.available();
  }

  async fetch(
    request: WebFetchRequest,
    signal?: AbortSignal,
  ): Promise<WebFetchResult> {
    let body: ReturnType<typeof buildFetchRequest>;
    try {
      body = buildFetchRequest(request.url);
    } catch (error) {
      throw localContractError("fetch", error);
    }

    const payload = await this.#transport.post(
      MODELLIX_WEB_FETCH_ENDPOINT,
      body,
      "fetch",
      signal,
    );
    try {
      const parsed = parseFetchResponse(payload.text);
      if (parsed.kind === "failure") {
        throw new ModellixWebFetchFailedError(parsed.requestId, body.urls[0]);
      }
      return parsed.result;
    } catch (error) {
      if (error instanceof ModellixWebFetchFailedError) {
        throw error;
      }
      throw paidOutcomeUnknownError("fetch", payload.credentialEpoch, error);
    }
  }
}

export function createModellixWebProviders(
  options: ModellixWebProviderOptions,
): ModellixWebProviders {
  return {
    search: new ModellixWebSearchProvider(options),
    fetch: new ModellixWebFetchProvider(options),
  };
}

/** Registers only providers; the Harness-owned web_search/web_fetch Tools remain untouched. */
export function registerModellixWebProviders(
  registry: ModellixWebRegistry,
  options: ModellixWebProviderOptions,
): () => void {
  const providers = createModellixWebProviders(options);
  const disposeSearch = registry.registerSearchProvider(providers.search);
  let disposeFetch: (() => void) | undefined;
  try {
    disposeFetch = registry.registerFetchProvider(providers.fetch);
  } catch (error) {
    disposeSearch();
    throw error;
  }
  return () => {
    disposeFetch?.();
    disposeSearch();
  };
}

interface PostResult {
  readonly text: string;
  readonly credentialEpoch: number;
}

class ModellixWebTransport {
  readonly #options: ModellixWebProviderOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maximumResponseBytes: number;
  readonly #requestTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: ModellixWebProviderOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#maximumResponseBytes = normalizeMaximumResponseBytes(
      options.maxResponseBytes,
    );
    this.#requestTimeoutMs = normalizeRequestTimeout(options.requestTimeoutMs);
    this.#now = options.now ?? Date.now;
  }

  available(): boolean {
    try {
      return (
        this.#options.isEnabled() &&
        this.#options.hasCredential() &&
        USER_ID_PATTERN.test(this.#options.getUserId())
      );
    } catch {
      return false;
    }
  }

  async post(
    endpoint: string,
    body: object,
    subsystem: "search" | "fetch",
    signal?: AbortSignal,
  ): Promise<PostResult> {
    if (!this.#isEnabled()) {
      throw new WebError(
        "The Modellix Web provider is disabled",
        "WEB_PROVIDER_UNAVAILABLE",
      );
    }
    throwIfCanceledBeforeDispatch(subsystem, signal);

    let credential: ModellixWebCredentialSnapshot | null;
    try {
      credential = await this.#options.resolveCredential();
    } catch (error) {
      throw new WebError(
        "The Modellix Web credential could not be resolved",
        "WEB_PROVIDER_UNAVAILABLE",
        { cause: redactedCause(error) },
      );
    }
    if (credential === null || !isUsableCredential(credential)) {
      throw new WebError(
        "The Modellix Web credential is unavailable",
        "WEB_PROVIDER_UNAVAILABLE",
      );
    }
    if (!this.#isEnabled()) {
      throw new WebError(
        "The Modellix Web provider was disabled before the request started",
        "WEB_PROVIDER_UNAVAILABLE",
      );
    }

    let userId: string;
    try {
      userId = this.#options.getUserId();
    } catch (error) {
      throw localContractError(subsystem, error, credential.credentialEpoch);
    }
    if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
      throw localContractError(
        subsystem,
        new ModellixWebContractError("X-Mdlx-User-Id is malformed"),
        credential.credentialEpoch,
      );
    }

    let approvedUrl: URL;
    try {
      approvedUrl = approveHttpRequest({
        url: endpoint,
        method: "POST",
        hasAuthorization: true,
      }).url;
    } catch (error) {
      throw unexpectedResponseError(subsystem, credential.credentialEpoch, error);
    }
    throwIfCanceledBeforeDispatch(subsystem, signal);

    let response: Response;
    const deadline = requestDeadline(signal, this.#requestTimeoutMs);
    try {
      response = await this.#fetch(approvedUrl, {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential.apiKey}`,
          "content-type": "application/json",
          "x-mdlx-user-id": userId,
        },
        body: JSON.stringify(body),
        signal: deadline.signal,
      });
      throwIfAborted(deadline.signal);
    } catch (error) {
      throw paidOutcomeUnknownError(subsystem, credential.credentialEpoch, error);
    }

    if (
      response.redirected ||
      response.status === 0 ||
      (response.status >= 300 && response.status < 400)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw paidOutcomeUnknownError(
        subsystem,
        credential.credentialEpoch,
        new ModellixWebContractError("Credential-bearing redirects are forbidden"),
      );
    }

    if (response.status !== 200) {
      await this.#throwHttpError(
        response,
        subsystem,
        credential.credentialEpoch,
        deadline.signal,
      );
    }

    if (!isJsonContentType(response.headers.get("content-type"))) {
      void response.body?.cancel().catch(() => undefined);
      throw paidOutcomeUnknownError(
        subsystem,
        credential.credentialEpoch,
        new ModellixWebContractError("Modellix returned a non-JSON response"),
      );
    }

    try {
      const text = await readBoundedResponseText(
        response,
        this.#maximumResponseBytes,
        deadline.signal,
      );
      return { text, credentialEpoch: credential.credentialEpoch };
    } catch (error) {
      throw paidOutcomeUnknownError(subsystem, credential.credentialEpoch, error);
    }
  }

  async #throwHttpError(
    response: Response,
    subsystem: "search" | "fetch",
    credentialEpoch: number,
    signal?: AbortSignal,
  ): Promise<never> {
    let requestId: string | null = null;
    try {
      const text = await readBoundedResponseText(
        response,
        this.#maximumResponseBytes,
        signal,
      );
      requestId = errorRequestId(text);
    } catch {
      // The status remains authoritative even when an optional error envelope
      // is malformed, too large, or canceled. No remote message is reflected.
    }

    const failure =
      (response.status >= 200 && response.status < 300) ||
      response.status === 408 ||
      response.status >= 500
      ? { kind: "submit-unknown" } as const
      : {
        kind: "http",
        status: response.status,
        requestId,
        retryAfterMs: parseRetryAfter(
          response.headers.get("retry-after"),
          this.#now(),
        ),
      } as const;
    const contract = toModellixError(
      operationContext(subsystem, credentialEpoch),
      failure,
    );

    if (
      response.status === 401 &&
      this.#isCredentialEpochCurrent(credentialEpoch) &&
      this.#options.onCredentialRejected !== undefined
    ) {
      try {
        await this.#options.onCredentialRejected(credentialEpoch, contract);
      } catch {
        // Credential state notification must not replace the API failure that
        // caused it. The Host callback owns its own diagnostics.
      }
    }
    throw new ModellixWebProviderError(contract, {
      status: response.status,
      requestId,
    });
  }

  #isEnabled(): boolean {
    try {
      return this.#options.isEnabled() === true;
    } catch {
      return false;
    }
  }

  #isCredentialEpochCurrent(credentialEpoch: number): boolean {
    try {
      return this.#options.isCredentialEpochCurrent(credentialEpoch) === true;
    } catch {
      return false;
    }
  }
}

function errorRequestId(text: string): string | null {
  try {
    const root = JSON.parse(text) as unknown;
    if (!isRecord(root) || !isRecord(root.error)) {
      return null;
    }
    const requestId = root.error.request_id;
    return typeof requestId === "string" &&
      /^[A-Za-z0-9._:-]{1,256}$/u.test(requestId)
      ? requestId
      : null;
  } catch {
    return null;
  }
}

function operationContext(
  subsystem: "search" | "fetch",
  credentialEpoch: number,
): {
  readonly service: "web";
  readonly subsystem: "search" | "fetch";
  readonly operation: "request";
  readonly credentialEpoch: number;
} {
  return { service: "web", subsystem, operation: "request", credentialEpoch };
}

function localContractError(
  subsystem: "search" | "fetch",
  error: unknown,
  credentialEpoch?: number,
): ModellixWebProviderError {
  return new ModellixWebProviderError(
    toModellixError(
      {
        service: "web",
        subsystem,
        operation: "request",
        ...(credentialEpoch === undefined ? {} : { credentialEpoch }),
      },
      { kind: "http", status: 400 },
    ),
    { error: redactedCause(error) },
  );
}

function unexpectedResponseError(
  subsystem: "search" | "fetch",
  credentialEpoch: number,
  error: unknown,
): ModellixWebProviderError {
  return new ModellixWebProviderError(
    toModellixError(operationContext(subsystem, credentialEpoch), {
      kind: "unexpected-response",
    }),
    { error: redactedCause(error) },
  );
}

function paidOutcomeUnknownError(
  subsystem: "search" | "fetch",
  credentialEpoch: number,
  error: unknown,
): ModellixWebProviderError {
  return new ModellixWebProviderError(
    toModellixError(operationContext(subsystem, credentialEpoch), {
      kind: "submit-unknown",
    }),
    { error: redactedCause(error) },
  );
}

function isUsableCredential(
  value: ModellixWebCredentialSnapshot,
): value is ModellixWebCredentialSnapshot {
  return (
    typeof value.apiKey === "string" &&
    value.apiKey.length > 0 &&
    value.apiKey.length <= MAX_API_KEY_CHARS &&
    !hasHeaderControlCharacter(value.apiKey) &&
    Number.isSafeInteger(value.credentialEpoch) &&
    value.credentialEpoch >= 0
  );
}

function hasHeaderControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

function normalizeMaximumResponseBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_WEB_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_CONFIGURED_RESPONSE_BYTES
  ) {
    throw new TypeError(
      `maxResponseBytes must be an integer from 1 through ${MAX_CONFIGURED_RESPONSE_BYTES}`,
    );
  }
  return resolved;
}

function normalizeRequestTimeout(value: number | undefined): number {
  const resolved = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 10 * 60_000) {
    throw new TypeError(
      "requestTimeoutMs must be a positive safe integer no greater than ten minutes",
    );
  }
  return resolved;
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) {
    return false;
  }
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function transportFailure(
  error: unknown,
  signal?: AbortSignal,
): { readonly kind: "network" | "timeout" | "abort" } {
  const reason = signal?.aborted === true ? signal.reason : error;
  if (reason instanceof Error && reason.name === "TimeoutError") {
    return { kind: "timeout" };
  }
  if (
    signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return { kind: "abort" };
  }
  return { kind: "network" };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}

function canceledRequestError(
  subsystem: "search" | "fetch",
  signal: AbortSignal,
): ModellixWebProviderError {
  return new ModellixWebProviderError(
    toModellixError(
      { service: "web", subsystem, operation: "request" },
      transportFailure(signal.reason, signal),
    ),
    { reason: redactedCause(signal.reason) },
  );
}

function throwIfCanceledBeforeDispatch(
  subsystem: "search" | "fetch",
  signal?: AbortSignal,
): void {
  if (signal?.aborted === true) {
    throw canceledRequestError(subsystem, signal);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactedCause(error: unknown): Error {
  const cause = new Error("Host Credential resolution failed");
  cause.name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)
      ? error.name
      : "Error";
  return cause;
}

function messageFor(contract: ModellixErrorContract): string {
  switch (contract.code) {
    case "MODELLIX_API_KEY_INVALID":
      return "Modellix rejected the configured API Key";
    case "MODELLIX_BILLING_BLOCKED":
      return "The Modellix account cannot run this paid Web request";
    case "MODELLIX_RATE_LIMITED":
      return "The Modellix Web request was rate limited";
    case "MODELLIX_CANCELED":
      return "The Modellix Web request was canceled";
    case "MODELLIX_OFFLINE":
      return "The Modellix Web service could not be reached";
    case "MODELLIX_TIMEOUT":
      return "The Modellix Web request timed out";
    case "MODELLIX_SERVER_ERROR":
      return "The Modellix Web service is temporarily unavailable";
    case "MODELLIX_BAD_REQUEST":
      return "The Modellix Web request is invalid";
    case "MODELLIX_SUBMIT_UNKNOWN":
      return "The paid Modellix Web request outcome is unknown; it was not retried";
    default:
      return "The Modellix Web request failed";
  }
}
