import { DesignError } from "./errors.js";
import type { ClockPort, StoragePort } from "./ports.js";
import { systemClock } from "./ports.js";
import type {
  PredictionResource,
  PredictionTask,
  PredictionTaskStatus,
} from "./prediction-client.js";

export const DEFAULT_RESULT_TTL_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_DESIGN_WAL_KEY = "modellix.design.task-wal.v1";

export type DesignTaskState =
  | "submitting"
  | "submit-unknown"
  | PredictionTaskStatus;

export interface DesignTaskRecord {
  readonly requestId: string;
  readonly modelSlug: string;
  readonly taskId: string | null;
  readonly state: DesignTaskState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  readonly expiresAt: number | null;
  readonly resources: readonly PredictionResource[];
}

export interface AvailableDesignResult {
  readonly requestId: string;
  readonly taskId: string;
  readonly modelSlug: string;
  readonly kind: PredictionResource["kind"];
  readonly url: string;
  readonly mimeType: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type DesignWalEvent =
  | {
      readonly type: "submit-intent";
      readonly sequence: number;
      readonly timestamp: number;
      readonly requestId: string;
      readonly modelSlug: string;
    }
  | {
      readonly type: "submit-unknown";
      readonly sequence: number;
      readonly timestamp: number;
      readonly requestId: string;
    }
  | {
      readonly type: "submit-rejected";
      readonly sequence: number;
      readonly timestamp: number;
      readonly requestId: string;
    }
  | {
      readonly type: "submit-accepted";
      readonly sequence: number;
      readonly timestamp: number;
      readonly requestId: string;
      readonly task: PredictionTask;
    }
  | {
      readonly type: "task-observed";
      readonly sequence: number;
      readonly timestamp: number;
      readonly task: PredictionTask;
    };

interface DesignWalDocument {
  readonly version: 1;
  readonly events: readonly DesignWalEvent[];
}

export interface DesignTaskRepositoryOptions {
  readonly storage: StoragePort;
  readonly clock?: ClockPort;
  readonly key?: string;
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}

const ID = /^[A-Za-z0-9._:-]{1,256}$/;
const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_MAX_EVENTS = 5_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Append-only logical WAL. Its closed event types intentionally have no place
 * for API keys or prompts; only replay identifiers, task state, and result URLs
 * can be persisted.
 */
export class DesignTaskRepository {
  readonly #storage: StoragePort;
  readonly #clock: ClockPort;
  readonly #key: string;
  readonly #maxEvents: number;
  readonly #maxBytes: number;

  constructor(options: DesignTaskRepositoryOptions) {
    this.#storage = options.storage;
    this.#clock = options.clock ?? systemClock;
    this.#key = options.key ?? DEFAULT_DESIGN_WAL_KEY;
    this.#maxEvents = boundedInteger(
      options.maxEvents ?? DEFAULT_MAX_EVENTS,
      1,
      100_000,
      "maxEvents",
    );
    this.#maxBytes = boundedInteger(
      options.maxBytes ?? DEFAULT_MAX_BYTES,
      1_024,
      32 * 1024 * 1024,
      "maxBytes",
    );
  }

  async recordSubmitIntent(requestId: string, modelSlug: string): Promise<void> {
    requireId(requestId, "requestId");
    requireModelSlug(modelSlug);
    const wal = await this.#loadWal();
    const records = replayDesignWal(wal.events);
    if (records.some((record) => record.requestId === requestId)) {
      throw new DesignError("STORAGE_INVALID", "requestId already exists in the Design WAL");
    }
    await this.#append(wal, {
      type: "submit-intent",
      sequence: nextSequence(wal),
      timestamp: this.#clock.now(),
      requestId,
      modelSlug,
    });
  }

  async markSubmitUnknown(requestId: string): Promise<void> {
    requireId(requestId, "requestId");
    const wal = await this.#loadWal();
    const record = replayDesignWal(wal.events).find(
      (candidate) => candidate.requestId === requestId,
    );
    if (record?.state !== "submitting") {
      throw new DesignError(
        "STORAGE_INVALID",
        "Only an active submit intent can become submit-unknown",
      );
    }
    await this.#append(wal, {
      type: "submit-unknown",
      sequence: nextSequence(wal),
      timestamp: this.#clock.now(),
      requestId,
    });
  }

  async markSubmitRejected(requestId: string): Promise<void> {
    requireId(requestId, "requestId");
    const wal = await this.#loadWal();
    const record = replayDesignWal(wal.events).find(
      (candidate) => candidate.requestId === requestId,
    );
    if (record?.state !== "submitting") {
      throw new DesignError(
        "STORAGE_INVALID",
        "Only an active submit intent can become rejected",
      );
    }
    await this.#append(wal, {
      type: "submit-rejected",
      sequence: nextSequence(wal),
      timestamp: this.#clock.now(),
      requestId,
    });
  }

  async recordSubmitAccepted(
    requestId: string,
    task: PredictionTask,
  ): Promise<void> {
    requireId(requestId, "requestId");
    validateTask(task);
    const wal = await this.#loadWal();
    const record = replayDesignWal(wal.events).find(
      (candidate) => candidate.requestId === requestId,
    );
    if (record === undefined || (record.state !== "submitting" && record.state !== "submit-unknown")) {
      throw new DesignError(
        "STORAGE_INVALID",
        "An accepted task requires an existing unresolved submit intent",
      );
    }
    await this.#append(wal, {
      type: "submit-accepted",
      sequence: nextSequence(wal),
      timestamp: this.#clock.now(),
      requestId,
      task: cloneTask(task),
    });
  }

  async recordTaskObserved(task: PredictionTask): Promise<void> {
    validateTask(task);
    const wal = await this.#loadWal();
    const record = replayDesignWal(wal.events).find(
      (candidate) => candidate.taskId === task.taskId,
    );
    if (record === undefined) {
      throw new DesignError(
        "STORAGE_INVALID",
        "Observed task is not associated with a Design submission",
      );
    }
    await this.#append(wal, {
      type: "task-observed",
      sequence: nextSequence(wal),
      timestamp: this.#clock.now(),
      task: cloneTask(task),
    });
  }

  async listTasks(): Promise<readonly DesignTaskRecord[]> {
    const wal = await this.#loadWal();
    return replayDesignWal(wal.events);
  }

  async listAvailableResults(): Promise<readonly AvailableDesignResult[]> {
    const records = await this.listTasks();
    return selectAvailableResults(records, this.#clock.now());
  }

  async #append(
    wal: DesignWalDocument,
    event: DesignWalEvent,
  ): Promise<void> {
    const next: DesignWalDocument = {
      version: 1,
      events: [...wal.events, event],
    };
    if (next.events.length > this.#maxEvents) {
      throw new DesignError("STORAGE_INVALID", "Design WAL event limit was reached");
    }
    const serialized = JSON.stringify(next);
    if (new TextEncoder().encode(serialized).byteLength > this.#maxBytes) {
      throw new DesignError("STORAGE_INVALID", "Design WAL size limit was reached");
    }
    await this.#storage.write(this.#key, serialized);
  }

  async #loadWal(): Promise<DesignWalDocument> {
    const serialized = await this.#storage.read(this.#key);
    if (serialized === null) {
      return { version: 1, events: [] };
    }
    if (new TextEncoder().encode(serialized).byteLength > this.#maxBytes) {
      throw new DesignError("STORAGE_INVALID", "Stored Design WAL exceeds its size limit");
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch (cause) {
      throw new DesignError("STORAGE_INVALID", "Stored Design WAL is not valid JSON", {
        cause,
      });
    }
    const parsed = parseWal(value, this.#maxEvents);
    try {
      replayDesignWal(parsed.events);
    } catch (cause) {
      if (cause instanceof DesignError) {
        throw cause;
      }
      throw new DesignError(
        "STORAGE_INVALID",
        "Stored Design WAL contains an invalid event",
        { cause },
      );
    }
    return parsed;
  }
}

export function replayDesignWal(
  events: readonly DesignWalEvent[],
): readonly DesignTaskRecord[] {
  const records = new Map<string, DesignTaskRecord>();
  const taskToRequest = new Map<string, string>();
  let priorSequence = 0;
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== priorSequence + 1) {
      throw new DesignError("STORAGE_INVALID", "Design WAL sequence is not contiguous");
    }
    priorSequence = event.sequence;
    if (!validTimestamp(event.timestamp)) {
      throw new DesignError("STORAGE_INVALID", "Design WAL timestamp is invalid");
    }
    switch (event.type) {
      case "submit-intent": {
        requireId(event.requestId, "requestId");
        requireModelSlug(event.modelSlug);
        if (records.has(event.requestId)) {
          throw new DesignError("STORAGE_INVALID", "Design WAL has a duplicate requestId");
        }
        records.set(event.requestId, {
          requestId: event.requestId,
          modelSlug: event.modelSlug,
          taskId: null,
          state: "submitting",
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          completedAt: null,
          expiresAt: null,
          resources: [],
        });
        break;
      }
      case "submit-unknown": {
        const current = requireRecord(records, event.requestId);
        if (current.state !== "submitting") {
          throw new DesignError("STORAGE_INVALID", "Invalid submit-unknown transition");
        }
        records.set(event.requestId, {
          ...current,
          state: "submit-unknown",
          updatedAt: event.timestamp,
        });
        break;
      }
      case "submit-rejected": {
        const current = requireRecord(records, event.requestId);
        if (current.state !== "submitting") {
          throw new DesignError("STORAGE_INVALID", "Invalid submit-rejected transition");
        }
        records.set(event.requestId, {
          ...current,
          state: "failed",
          updatedAt: event.timestamp,
          completedAt: event.timestamp,
        });
        break;
      }
      case "submit-accepted": {
        validateTask(event.task);
        const current = requireRecord(records, event.requestId);
        if (current.taskId !== null || taskToRequest.has(event.task.taskId)) {
          throw new DesignError("STORAGE_INVALID", "Design WAL has a duplicate taskId");
        }
        if (current.state !== "submitting" && current.state !== "submit-unknown") {
          throw new DesignError("STORAGE_INVALID", "Invalid submit-accepted transition");
        }
        const next = mergeTask(current, event.task, event.timestamp);
        records.set(event.requestId, next);
        taskToRequest.set(event.task.taskId, event.requestId);
        break;
      }
      case "task-observed": {
        validateTask(event.task);
        const requestId = taskToRequest.get(event.task.taskId);
        if (requestId === undefined) {
          throw new DesignError("STORAGE_INVALID", "Observed task has no accepted submission");
        }
        const current = requireRecord(records, requestId);
        records.set(requestId, mergeTask(current, event.task, event.timestamp));
        break;
      }
    }
  }
  return [...records.values()].sort((left, right) => right.createdAt - left.createdAt);
}

export function selectAvailableResults(
  records: readonly DesignTaskRecord[],
  nowMs: number,
): readonly AvailableDesignResult[] {
  if (!validTimestamp(nowMs)) {
    throw new DesignError("INVALID_ARGUMENT", "nowMs must be a non-negative timestamp");
  }
  const results: AvailableDesignResult[] = [];
  for (const record of records) {
    if (record.state !== "succeeded" || record.taskId === null) {
      continue;
    }
    const baseTime = record.completedAt ?? record.updatedAt;
    for (const resource of record.resources) {
      // Per-resource upstream expiry wins, followed by task expiry, then 7 days.
      const expiresAt =
        resource.expiresAt ?? record.expiresAt ?? baseTime + DEFAULT_RESULT_TTL_MS;
      if (expiresAt <= nowMs) {
        continue;
      }
      results.push({
        requestId: record.requestId,
        taskId: record.taskId,
        modelSlug: record.modelSlug,
        kind: resource.kind,
        url: resource.url,
        mimeType: resource.mimeType,
        createdAt: baseTime,
        expiresAt,
      });
    }
  }
  return results.sort((left, right) => right.createdAt - left.createdAt);
}

function mergeTask(
  record: DesignTaskRecord,
  task: PredictionTask,
  observedAt: number,
): DesignTaskRecord {
  if (record.taskId !== null && record.taskId !== task.taskId) {
    throw new DesignError("STORAGE_INVALID", "Task identifier changed during replay");
  }
  return {
    ...record,
    taskId: task.taskId,
    state: task.status,
    updatedAt: observedAt,
    completedAt: task.completedAt,
    expiresAt: task.expiresAt,
    resources: task.resources.map(cloneResource),
  };
}

function parseWal(value: unknown, maxEvents: number): DesignWalDocument {
  const root = asRecord(value);
  if (root?.version !== 1 || !Array.isArray(root.events) || root.events.length > maxEvents) {
    throw new DesignError("STORAGE_INVALID", "Stored Design WAL has an invalid envelope");
  }
  return {
    version: 1,
    events: root.events as DesignWalEvent[],
  };
}

function nextSequence(wal: DesignWalDocument): number {
  return wal.events.length + 1;
}

function requireRecord(
  records: ReadonlyMap<string, DesignTaskRecord>,
  requestId: string,
): DesignTaskRecord {
  requireId(requestId, "requestId");
  const record = records.get(requestId);
  if (record === undefined) {
    throw new DesignError("STORAGE_INVALID", "Design WAL references an unknown requestId");
  }
  return record;
}

function validateTask(task: PredictionTask): void {
  requireId(task.taskId, "taskId");
  if (!validTimestampOrNull(task.createdAt) || !validTimestampOrNull(task.completedAt) || !validTimestampOrNull(task.expiresAt)) {
    throw new DesignError("STORAGE_INVALID", "Prediction task timestamps are invalid");
  }
  if (!["queued", "running", "succeeded", "failed", "canceled", "unknown"].includes(task.status)) {
    throw new DesignError("STORAGE_INVALID", "Prediction task status is invalid");
  }
  task.resources.forEach((resource) => {
    if (
      !["image", "video", "audio"].includes(resource.kind) ||
      safeHttpsUrl(resource.url) === null ||
      !validTimestampOrNull(resource.expiresAt)
    ) {
      throw new DesignError("STORAGE_INVALID", "Prediction resource is invalid");
    }
  });
}

function cloneTask(task: PredictionTask): PredictionTask {
  return {
    ...task,
    resources: task.resources.map(cloneResource),
  };
}

function cloneResource(resource: PredictionResource): PredictionResource {
  return { ...resource };
}

function requireId(value: string, field: string): void {
  if (!ID.test(value)) {
    throw new DesignError("INVALID_ARGUMENT", `${field} is malformed`);
  }
}

function requireModelSlug(value: string): void {
  if (!MODEL_SLUG.test(value)) {
    throw new DesignError("INVALID_ARGUMENT", "modelSlug must use provider/model form");
  }
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validTimestampOrNull(value: number | null): boolean {
  return value === null || validTimestamp(value);
}

function safeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new DesignError(
      "INVALID_ARGUMENT",
      `${field} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
