export const MODELLIX_ORIGINS = Object.freeze({
  prediction: "https://api.modellix.ai",
  llm: "https://llm.modellix.ai",
  webTools: "https://tool.modellix.ai",
  publicSchema: "https://www.modellix.ai",
});

export type ModellixOriginName = keyof typeof MODELLIX_ORIGINS;
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpRequestPolicyInput {
  readonly url: string | URL;
  readonly method: HttpMethod;
  readonly hasAuthorization: boolean;
}

export interface ApprovedHttpRequest {
  readonly url: URL;
  readonly originName: ModellixOriginName;
  readonly method: HttpMethod;
  readonly authorizationAllowed: boolean;
}

export class HttpPolicyError extends Error {
  readonly code:
    | "INVALID_URL"
    | "ORIGIN_NOT_ALLOWED"
    | "USERINFO_NOT_ALLOWED"
    | "FRAGMENT_NOT_ALLOWED"
    | "AUTHORIZATION_NOT_ALLOWED"
    | "METHOD_NOT_ALLOWED"
    | "REDIRECT_NOT_ALLOWED";

  constructor(code: HttpPolicyError["code"], message: string) {
    super(message);
    this.name = "HttpPolicyError";
    this.code = code;
  }
}

export class HttpResponseBoundaryError extends Error {
  readonly code: "BODY_MISSING" | "BODY_TOO_LARGE" | "INVALID_ENCODING" | "INVALID_JSON";

  constructor(code: HttpResponseBoundaryError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpResponseBoundaryError";
    this.code = code;
  }
}

/** Reads a response incrementally so a hostile Content-Length cannot allocate an unbounded body. */
export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024 * 1024) {
    throw new TypeError("maximumBytes must be an integer from 1 through 67108864");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared)) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpResponseBoundaryError("BODY_TOO_LARGE", "Response exceeds the byte limit");
    }
  }
  if (response.body === null) {
    throw new HttpResponseBoundaryError("BODY_MISSING", "Response body is missing");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let received = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await readChunk(reader, signal);
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maximumBytes) {
        throw new HttpResponseBoundaryError("BODY_TOO_LARGE", "Response exceeds the byte limit");
      }
      try {
        chunks.push(decoder.decode(chunk.value, { stream: true }));
      } catch (cause) {
        throw new HttpResponseBoundaryError("INVALID_ENCODING", "Response is not valid UTF-8", { cause });
      }
    }
    try {
      chunks.push(decoder.decode());
    } catch (cause) {
      throw new HttpResponseBoundaryError("INVALID_ENCODING", "Response is not valid UTF-8", { cause });
    }
    signal?.throwIfAborted();
    return chunks.join("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<
  | { readonly done: true; readonly value: Uint8Array | undefined }
  | { readonly done: false; readonly value: Uint8Array }
> {
  if (signal === undefined) {
    return reader.read();
  }
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(
      signal.reason ?? new DOMException("The operation was aborted", "AbortError"),
    );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function readBoundedResponseJson(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const text = await readBoundedResponseText(response, maximumBytes, signal);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new HttpResponseBoundaryError("INVALID_JSON", "Response is not valid JSON", { cause });
  }
}

/**
 * Applies the shared origin boundary. Model-specific endpoint/path validation is
 * intentionally an additional Design-layer policy and must run before submit.
 */
export function approveHttpRequest(
  input: HttpRequestPolicyInput,
): ApprovedHttpRequest {
  const url = parseUrl(input.url);
  assertSafeUrlShape(url);
  const originName = originNameFor(url.origin);
  if (originName === null) {
    throw new HttpPolicyError(
      "ORIGIN_NOT_ALLOWED",
      "Request origin is not in the Modellix allowlist",
    );
  }

  if (originName === "publicSchema") {
    if (input.method !== "GET") {
      throw new HttpPolicyError(
        "METHOD_NOT_ALLOWED",
        "The public Schema origin only allows GET",
      );
    }
    if (input.hasAuthorization) {
      throw new HttpPolicyError(
        "AUTHORIZATION_NOT_ALLOWED",
        "Authorization is forbidden on the public Schema origin",
      );
    }
  }

  return {
    url,
    originName,
    method: input.method,
    authorizationAllowed: originName !== "publicSchema",
  };
}

/**
 * Redirects are manual and same-origin only. This remains true for public
 * no-credential GETs so an upstream response cannot widen the allowlist.
 */
export function approveRedirect(
  from: string | URL,
  to: string | URL,
  request: Pick<HttpRequestPolicyInput, "method" | "hasAuthorization">,
): ApprovedHttpRequest {
  const source = approveHttpRequest({ ...request, url: from });
  const target = approveHttpRequest({ ...request, url: to });
  if (source.url.origin !== target.url.origin) {
    throw new HttpPolicyError(
      "REDIRECT_NOT_ALLOWED",
      "Cross-origin redirects are not allowed",
    );
  }
  return target;
}

export function isAllowedModellixOrigin(value: string | URL): boolean {
  try {
    const url = parseUrl(value);
    assertSafeUrlShape(url);
    return originNameFor(url.origin) !== null;
  } catch {
    return false;
  }
}

export interface HttpRetryFailure {
  readonly kind: "network" | "http" | "abort";
  readonly status?: number;
  readonly retryAfterMs?: number | null;
}

export interface RetryOptions<E> {
  readonly method: HttpMethod;
  readonly maxRetries: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly shouldRetry: (error: E) => boolean;
  readonly retryAfterMs?: (error: E) => number | null;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly random?: () => number;
}

export interface RetrySuccess<T> {
  readonly value: T;
  readonly attempts: number;
}

/**
 * Generic bounded retry executor. Unsafe methods are structurally prevented
 * from receiving retries; callers must perform a new explicit user action.
 */
export async function executeWithRetry<T, E = unknown>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions<E>,
): Promise<RetrySuccess<T>> {
  assertRetryOptions(options);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const jitterRatio = options.jitterRatio ?? 0.2;

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      const value = await operation(attempt);
      return { value, attempts: attempt };
    } catch (caught) {
      const error = caught as E;
      const retriesUsed = attempt - 1;
      if (
        retriesUsed >= options.maxRetries ||
        !options.shouldRetry(error)
      ) {
        throw caught;
      }

      const retryAfter = options.retryAfterMs?.(error) ?? null;
      const delayMs = computeRetryDelay({
        retryIndex: retriesUsed,
        baseDelayMs,
        maxDelayMs,
        jitterRatio,
        retryAfterMs: retryAfter,
        random: random(),
      });
      await sleep(delayMs);
    }
  }
}

export function isRetryableReadFailure(failure: HttpRetryFailure): boolean {
  if (failure.kind === "abort") {
    return false;
  }
  if (failure.kind === "network") {
    return true;
  }
  return (
    failure.status === 408 ||
    failure.status === 429 ||
    (typeof failure.status === "number" && failure.status >= 500)
  );
}

export function retryAfterFromFailure(
  failure: HttpRetryFailure,
): number | null {
  return normalizeDelay(failure.retryAfterMs, 86_400_000);
}

export interface RetryDelayInput {
  readonly retryIndex: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  readonly retryAfterMs: number | null;
  /** A deterministic value in [0, 1], injectable for tests. */
  readonly random: number;
}

export function computeRetryDelay(input: RetryDelayInput): number {
  if (!Number.isInteger(input.retryIndex) || input.retryIndex < 0) {
    throw new TypeError("retryIndex must be a non-negative integer");
  }
  if (!Number.isFinite(input.random) || input.random < 0 || input.random > 1) {
    throw new TypeError("random must be within [0, 1]");
  }
  if (
    !Number.isFinite(input.jitterRatio) ||
    input.jitterRatio < 0 ||
    input.jitterRatio > 1
  ) {
    throw new TypeError("jitterRatio must be within [0, 1]");
  }

  const base = positiveDelay(input.baseDelayMs, "baseDelayMs");
  const maximum = positiveDelay(input.maxDelayMs, "maxDelayMs");
  const exponential = Math.min(maximum, base * 2 ** input.retryIndex);
  const jitterMultiplier = 1 - input.jitterRatio + input.random * 2 * input.jitterRatio;
  const jittered = Math.min(maximum, Math.max(0, exponential * jitterMultiplier));
  const serverDelay = normalizeDelay(input.retryAfterMs, maximum) ?? 0;
  return Math.ceil(Math.max(jittered, serverDelay));
}

/** Supports Retry-After delta-seconds and IMF-fixdate. */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number,
  maximumMs = 86_400_000,
): number | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new TypeError("nowMs must be a non-negative finite number");
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return normalizeDelay(Number(trimmed) * 1_000, maximumMs);
  }
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp)
    ? normalizeDelay(Math.max(0, timestamp - nowMs), maximumMs)
    : null;
}

function parseUrl(value: string | URL): URL {
  try {
    return value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new HttpPolicyError("INVALID_URL", "Request URL is invalid");
  }
}

function assertSafeUrlShape(url: URL): void {
  if (url.username !== "" || url.password !== "") {
    throw new HttpPolicyError("USERINFO_NOT_ALLOWED", "URL userinfo is forbidden");
  }
  if (url.hash !== "") {
    throw new HttpPolicyError("FRAGMENT_NOT_ALLOWED", "URL fragments are forbidden");
  }
}

function originNameFor(origin: string): ModellixOriginName | null {
  for (const [name, allowedOrigin] of Object.entries(MODELLIX_ORIGINS) as Array<
    [ModellixOriginName, string]
  >) {
    if (origin === allowedOrigin) {
      return name;
    }
  }
  return null;
}

function assertRetryOptions<E>(options: RetryOptions<E>): void {
  if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
    throw new TypeError("maxRetries must be a non-negative integer");
  }
  if (
    options.maxRetries > 0 &&
    options.method !== "GET" &&
    options.method !== "HEAD"
  ) {
    throw new TypeError("Automatic retries are only allowed for GET or HEAD");
  }
}

function positiveDelay(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive finite number`);
  }
  return value;
}

function normalizeDelay(
  value: number | null | undefined,
  maximumMs: number,
): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= maximumMs
    ? Math.floor(value)
    : null;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
