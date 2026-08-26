import { DesignError } from "./errors.js";
import type {
  ClockPort,
  DesignLogEvent,
  FetchPort,
  LoggerPort,
  SleepPort,
} from "./ports.js";
import { systemClock, systemSleep } from "./ports.js";
import type { JsonValue } from "./schema-ir.js";
import { readBoundedResponseJson } from "../core/http.js";
import { DESIGN_WIRE_LIMITS } from "../shared/design-wire-limits.js";

const PREDICTION_ORIGIN = "https://api.modellix.ai";
const MAX_PREDICTION_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_RETRY_DELAY_MS = 5_000;
const MAX_PERSISTED_RETRY_AFTER_MS = 5 * 60_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,256}$/;

export type PredictionTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "unknown";

export interface PredictionResource {
  readonly kind: "image" | "video" | "audio";
  readonly url: string;
  readonly mimeType: string | null;
  readonly expiresAt: number | null;
}

export interface PredictionTask {
  readonly taskId: string;
  readonly status: PredictionTaskStatus;
  readonly resources: readonly PredictionResource[];
  readonly createdAt: number | null;
  readonly completedAt: number | null;
  readonly expiresAt: number | null;
}

export interface PredictionClientOptions {
  readonly fetch: FetchPort;
  readonly clock?: ClockPort;
  readonly sleep?: SleepPort;
  readonly logger?: LoggerPort;
}

export interface SubmitPredictionInput {
  /** Authoritative servers[0].url returned by the public api_schema. */
  readonly endpoint: string;
  /** Used only to bind endpoint path; it is never used to construct the URL. */
  readonly modelSlug: string;
  readonly apiKey: string;
  readonly body: Readonly<Record<string, JsonValue>>;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export interface ReadPredictionInput {
  readonly taskId: string;
  readonly apiKey: string;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
}

export class PredictionClient {
  readonly #fetch: FetchPort;
  readonly #clock: ClockPort;
  readonly #sleep: SleepPort;
  readonly #logger: LoggerPort | undefined;

  constructor(options: PredictionClientOptions) {
    this.#fetch = options.fetch;
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? systemSleep;
    this.#logger = options.logger;
  }

  /** A paid POST is attempted exactly once and never follows redirects. */
  async submit(input: SubmitPredictionInput): Promise<PredictionTask> {
    input.signal?.throwIfAborted();
    const endpoint = validateSubmitEndpoint(input.endpoint, input.modelSlug);
    const apiKey = validateApiKey(input.apiKey);
    const requestId = safeId(input.requestId);
    const model = normalizeModelSlug(input.modelSlug).join("/");
    this.#log({
      level: "info",
      event: "design.submit.started",
      operation: "submit",
      model,
      ...(requestId === null ? {} : { requestId }),
    });

    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST",
        headers: new Headers({
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(requestId === null ? {} : { "x-request-id": requestId }),
        }),
        body: JSON.stringify(input.body),
        redirect: "error",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (cause) {
      this.#log({
        level: "warn",
        event: "design.submit.unknown",
        operation: "submit",
        model,
        ...(requestId === null ? {} : { requestId }),
      });
      throw new DesignError(
        "SUBMIT_UNKNOWN",
        "The paid request outcome is unknown; do not retry automatically",
        { cause },
      );
    }

    if (!response.ok) {
      const ambiguous = isAmbiguousSubmitStatus(response.status);
      this.#log({
        level: "warn",
        event: ambiguous ? "design.submit.unknown" : "design.submit.rejected",
        operation: "submit",
        model,
        status: response.status,
        ...(requestId === null ? {} : { requestId }),
      });
      throw new DesignError(
        ambiguous ? "SUBMIT_UNKNOWN" : "SUBMIT_REJECTED",
        ambiguous
          ? "The paid request outcome is unknown; do not retry automatically"
          : `The paid request was rejected with HTTP ${response.status}`,
        { status: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = await readBoundedResponseJson(
        response,
        MAX_PREDICTION_RESPONSE_BYTES,
        input.signal,
      );
    } catch (cause) {
      throw new DesignError(
        "SUBMIT_UNKNOWN",
        "The paid request succeeded but its task identifier could not be read",
        { cause },
      );
    }
    const task = parsePredictionTask(payload);
    if (task === null) {
      throw new DesignError(
        "SUBMIT_UNKNOWN",
        "The paid request response did not contain a valid task identifier",
      );
    }
    this.#log({
      level: "info",
      event: "design.submit.accepted",
      operation: "submit",
      model,
      status: response.status,
      taskId: task.taskId,
      ...(requestId === null ? {} : { requestId }),
    });
    return task;
  }

  /** GET retries only transient read failures and is capped at five attempts. */
  async readTask(input: ReadPredictionInput): Promise<PredictionTask> {
    const taskId = requireId(input.taskId, "taskId");
    const apiKey = validateApiKey(input.apiKey);
    const maxAttempts = boundedAttempts(input.maxAttempts ?? 3);
    const url = new URL(`/api/v1/tasks/${encodeURIComponent(taskId)}`, PREDICTION_ORIGIN);
    let lastFailure: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      input.signal?.throwIfAborted();
      try {
        const response = await this.#fetch(url, {
          method: "GET",
          headers: new Headers({
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
          }),
          redirect: "error",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (!response.ok) {
          const failure = new TaskReadFailure(
            response.status,
            retryAfterMs(response.headers.get("retry-after"), this.#clock.now()),
          );
          if (!failure.retryable || attempt === maxAttempts) {
            throw new DesignError(
              "TASK_READ_FAILED",
              `Task status returned HTTP ${response.status}`,
              { status: response.status, retryAfterMs: failure.retryAfterMs },
            );
          }
          lastFailure = failure;
          await this.#waitBeforeRetry(attempt, failure.retryAfterMs, input.signal);
          continue;
        }
        let payload: unknown;
        try {
          payload = await readBoundedResponseJson(
            response,
            MAX_PREDICTION_RESPONSE_BYTES,
            input.signal,
          );
        } catch (cause) {
          throw new DesignError(
            "UNEXPECTED_RESPONSE",
            "Task status response is not valid JSON",
            { cause },
          );
        }
        const task = parsePredictionTask(payload, taskId);
        if (task === null) {
          throw new DesignError(
            "UNEXPECTED_RESPONSE",
            "Task status response does not contain a valid task",
          );
        }
        this.#log({
          level: "info",
          event: "design.task.read",
          operation: "read-task",
          attempt,
          status: response.status,
          taskId,
        });
        return task;
      } catch (caught) {
        if (caught instanceof DesignError) {
          throw caught;
        }
        if (isAbortError(caught) || attempt === maxAttempts) {
          throw new DesignError(
            "TASK_READ_FAILED",
            "Task status could not be read within the retry bound",
            { cause: caught },
          );
        }
        lastFailure = caught;
        await this.#waitBeforeRetry(attempt, null, input.signal);
      }
    }
    throw new DesignError(
      "TASK_READ_FAILED",
      "Task status could not be read within the retry bound",
      { cause: lastFailure },
    );
  }

  async #waitBeforeRetry(
    attempt: number,
    retryAfter: number | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const delay = Math.min(
      MAX_INLINE_RETRY_DELAY_MS,
      Math.max(retryAfter ?? 0, 250 * 2 ** (attempt - 1)),
    );
    this.#log({
      level: "warn",
      event: "design.task.retry",
      operation: "read-task",
      attempt,
    });
    await abortable(this.#sleep.sleep(delay), signal);
  }

  #log(event: DesignLogEvent): void {
    this.#logger?.write(event);
  }
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export function validateSubmitEndpoint(endpoint: string, modelSlug: string): URL {
  const [provider, modelId] = normalizeModelSlug(modelSlug);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (cause) {
    throw new DesignError("ENDPOINT_NOT_ALLOWED", "Submission endpoint is invalid", {
      cause,
    });
  }
  if (
    url.origin !== PREDICTION_ORIGIN ||
    url.pathname !== `/api/v1/${provider}/${modelId}` ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new DesignError(
      "ENDPOINT_NOT_ALLOWED",
      "Submission endpoint does not match the authoritative model allowlist",
    );
  }
  return url;
}

export function parsePredictionTask(
  payload: unknown,
  expectedTaskId?: string,
): PredictionTask | null {
  const root = asRecord(payload);
  if (root === null) {
    return null;
  }
  const envelope = asRecord(root.data) ?? root;
  const data = asRecord(envelope.task) ?? asRecord(root.task) ?? envelope;
  const taskId =
    safeId(data.task_id) ??
    safeId(data.taskId) ??
    safeId(data.id) ??
    safeId(root.task_id) ??
    safeId(root.taskId) ??
    (expectedTaskId === undefined ? null : safeId(expectedTaskId));
  if (taskId === null) {
    return null;
  }
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) {
    throw new DesignError(
      "UNEXPECTED_RESPONSE",
      "Task status response identifier does not match the requested task",
    );
  }
  const result = asRecord(data.result) ?? asRecord(root.result);
  const expiresAt = timestamp(
    data.result_expires_at ??
      data.resultExpiresAt ??
      data.expires_at ??
      data.expiresAt ??
      result?.result_expires_at ??
      result?.resultExpiresAt ??
      result?.expires_at ??
      result?.expiresAt,
  );
  const resourceContainer =
    data.result_resources ??
    data.resources ??
    result?.result_resources ??
    result?.resources ??
    data.output ??
    result?.output ??
    root.resources ??
    root.output ??
    result;
  return {
    taskId,
    status: normalizeStatus(data.status ?? data.state ?? root.status),
    resources: parseResources(resourceContainer, expiresAt),
    createdAt: timestamp(data.created_at ?? data.createdAt ?? root.created_at),
    completedAt: timestamp(
      data.completed_at ?? data.completedAt ?? data.finished_at ?? root.completed_at,
    ),
    expiresAt,
  };
}

export function parseResources(
  value: unknown,
  inheritedExpiresAt: number | null = null,
): PredictionResource[] {
  const envelope = asRecord(value);
  if (envelope !== null && !hasResourceUrl(envelope)) {
    const nested =
      envelope.resources ?? envelope.result_resources ?? envelope.output;
    if (nested !== undefined && nested !== value) {
      return parseResources(nested, inheritedExpiresAt);
    }
    const grouped: PredictionResource[] = [];
    for (const [kind, keys] of [
      ["image", ["image", "images", "image_urls"]],
      ["video", ["video", "videos", "video_urls"]],
      ["audio", ["audio", "audios", "audio_urls"]],
    ] as const) {
      for (const key of keys) {
        const items = envelope[key];
        if (items === undefined) {
          continue;
        }
        const candidates = Array.isArray(items) ? items : [items];
        for (const candidate of candidates) {
          const resource =
            typeof candidate === "string"
              ? parseResource(
                  { type: kind, url: candidate },
                  inheritedExpiresAt,
                )
              : parseResource(
                  { ...asRecord(candidate), type: kind },
                  inheritedExpiresAt,
                );
          if (resource !== null) {
            appendResource(grouped, resource);
          }
        }
      }
    }
    if (grouped.length > 0) {
      return grouped;
    }
  }
  const candidates = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const resources: PredictionResource[] = [];
  for (const candidate of candidates) {
    const parsed = parseResource(candidate, inheritedExpiresAt);
    if (parsed !== null) {
      appendResource(resources, parsed);
    }
  }
  return resources;
}

function appendResource(
  resources: PredictionResource[],
  resource: PredictionResource | null,
): void {
  if (resource === null) return;
  if (resources.length >= DESIGN_WIRE_LIMITS.maxResources) {
    throw new DesignError("UNEXPECTED_RESPONSE", "Prediction response has too many resources");
  }
  resources.push(resource);
}

function parseResource(
  value: unknown,
  inheritedExpiresAt: number | null,
): PredictionResource | null {
  if (typeof value === "string") {
    const url = safeHttpsUrl(value);
    const kind = inferResourceKind(null, null, url);
    return url === null || kind === null
      ? null
      : { kind, url, mimeType: null, expiresAt: inheritedExpiresAt };
  }
  const resource = asRecord(value);
  if (resource === null) {
    return null;
  }
  const rawUrl =
    resource.url ??
    resource.uri ??
    resource.image_url ??
    resource.video_url ??
    resource.audio_url;
  const url = safeHttpsUrl(rawUrl);
  const mimeType = boundedString(resource.mime_type ?? resource.mimeType);
  const explicitKind = boundedString(resource.type ?? resource.kind ?? resource.media_type);
  const kind = inferResourceKind(explicitKind, mimeType, url);
  if (url === null || kind === null) {
    return null;
  }
  return {
    kind,
    url,
    mimeType,
    expiresAt:
      timestamp(
        resource.result_expires_at ??
          resource.resultExpiresAt ??
          resource.expires_at ??
          resource.expiresAt,
      ) ?? inheritedExpiresAt,
  };
}

function inferResourceKind(
  explicit: string | null,
  mimeType: string | null,
  url: string | null,
): PredictionResource["kind"] | null {
  const hints = [explicit, mimeType, url].filter(
    (value): value is string => value !== null,
  );
  for (const hint of hints) {
    const lower = hint.toLowerCase();
    if (lower.includes("image") || /\.(?:png|jpe?g|webp|gif|avif)(?:$|\?)/u.test(lower)) {
      return "image";
    }
    if (lower.includes("video") || /\.(?:mp4|webm|mov|mkv)(?:$|\?)/u.test(lower)) {
      return "video";
    }
    if (lower.includes("audio") || /\.(?:mp3|wav|m4a|ogg|flac)(?:$|\?)/u.test(lower)) {
      return "audio";
    }
  }
  return null;
}

function normalizeStatus(value: unknown): PredictionTaskStatus {
  if (typeof value !== "string") {
    return "unknown";
  }
  switch (value.toLowerCase()) {
    case "queued":
    case "pending":
    case "created":
      return "queued";
    case "running":
    case "processing":
    case "in_progress":
      return "running";
    case "succeeded":
    case "success":
    case "completed":
    case "done":
      return "succeeded";
    case "failed":
    case "error":
      return "failed";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "unknown";
  }
}

function isAmbiguousSubmitStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500 ||
    status < 400
  );
}

function hasResourceUrl(value: Readonly<Record<string, unknown>>): boolean {
  return [
    "url",
    "uri",
    "image_url",
    "video_url",
    "audio_url",
  ].some((key) => typeof value[key] === "string");
}

function normalizeModelSlug(value: string): readonly [string, string] {
  const parts = value.split("/");
  if (
    parts.length !== 2 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    !IDENTIFIER.test(parts[0]) ||
    !IDENTIFIER.test(parts[1])
  ) {
    throw new DesignError(
      "INVALID_ARGUMENT",
      "modelSlug must have the exact provider/model form",
    );
  }
  return [parts[0], parts[1]];
}

function validateApiKey(value: string): string {
  if (value.trim() === "" || value.length > 16_384 || /[\r\n]/u.test(value)) {
    throw new DesignError("INVALID_ARGUMENT", "apiKey is missing or malformed");
  }
  return value;
}

function boundedAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new DesignError(
      "INVALID_ARGUMENT",
      "maxAttempts must be an integer from 1 through 5",
    );
  }
  return value;
}

function requireId(value: string, field: string): string {
  const id = safeId(value);
  if (id === null) {
    throw new DesignError("INVALID_ARGUMENT", `${field} is malformed`);
  }
  return id;
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && CORRELATION_ID.test(value) ? value : null;
}

function boundedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= 512
    ? value.trim()
    : null;
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16_384) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value < 1_000_000_000_000 ? value * 1_000 : value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function retryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    return Math.min(MAX_PERSISTED_RETRY_AFTER_MS, Number(trimmed) * 1_000);
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed)
    ? Math.min(MAX_PERSISTED_RETRY_AFTER_MS, Math.max(0, parsed - nowMs))
    : null;
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

class TaskReadFailure extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfter: number | null) {
    super(`Task read failed with HTTP ${status}`);
    this.name = "TaskReadFailure";
    this.retryable = status === 408 || status === 429 || status >= 500;
    this.retryAfterMs = retryAfter;
  }
}
