import { describe, expect, it } from "vitest";

import { DesignError } from "../../../src/design/errors.js";
import type { StoragePort } from "../../../src/design/ports.js";
import type { PredictionTask } from "../../../src/design/prediction-client.js";
import {
  DEFAULT_RESULT_TTL_MS,
  DesignTaskRepository,
  replayDesignWal,
  selectAvailableResults,
} from "../../../src/design/task-wal.js";

describe("DesignTaskRepository", () => {
  it("persists submit intent before acceptance and replays task observations", async () => {
    const memory = memoryStorage();
    let now = 1_000;
    const repository = new DesignTaskRepository({
      storage: memory.storage,
      clock: { now: () => now },
    });

    await repository.recordSubmitIntent("request-1", "openai/gpt-image-2", 3);
    expect(await repository.listTasks()).toEqual([
      expect.objectContaining({
        requestId: "request-1",
        credentialEpoch: 3,
        taskId: null,
        state: "submitting",
      }),
    ]);

    now = 2_000;
    await repository.recordSubmitAccepted("request-1", task("task-1", "queued"));
    now = 3_000;
    await repository.recordTaskObserved({
      ...task("task-1", "succeeded"),
      completedAt: 2_500,
      resources: [
        {
          kind: "image",
          url: "https://cdn.example/result.png",
          mimeType: "image/png",
          expiresAt: null,
        },
      ],
    });

    const tasks = await repository.listTasks();
    expect(tasks).toEqual([
      expect.objectContaining({
        state: "succeeded",
        taskId: "task-1",
        completedAt: 2_500,
      }),
    ]);
    now = 2_500 + DEFAULT_RESULT_TTL_MS - 1;
    expect(await repository.listAvailableResults()).toEqual([
      expect.objectContaining({
        taskId: "task-1",
        expiresAt: 2_500 + DEFAULT_RESULT_TTL_MS,
      }),
    ]);
    now += 1;
    expect(await repository.listAvailableResults()).toEqual([]);
  });

  it("records an ambiguous POST as submit-unknown without duplicating it", async () => {
    const memory = memoryStorage();
    const repository = new DesignTaskRepository({ storage: memory.storage });
    await repository.recordSubmitIntent("request-2", "openai/gpt-image-2", 4);
    await repository.markSubmitUnknown("request-2");
    expect(await repository.listTasks()).toEqual([
      expect.objectContaining({ state: "submit-unknown", taskId: null }),
    ]);
    await expect(repository.markSubmitUnknown("request-2")).rejects.toBeInstanceOf(
      DesignError,
    );
  });

  it("closes a definitively rejected submit intent without making it retryable", async () => {
    const memory = memoryStorage();
    const repository = new DesignTaskRepository({ storage: memory.storage });
    await repository.recordSubmitIntent("request-rejected", "openai/gpt-image-2", 5);
    await repository.markSubmitRejected("request-rejected");

    expect(await repository.listTasks()).toEqual([
      expect.objectContaining({ state: "failed", taskId: null }),
    ]);
    await expect(repository.markSubmitRejected("request-rejected")).rejects.toBeInstanceOf(
      DesignError,
    );
  });

  it("stores a closed WAL shape that has no prompt or API-key fields", async () => {
    const memory = memoryStorage();
    const repository = new DesignTaskRepository({ storage: memory.storage });
    await repository.recordSubmitIntent("request-3", "openai/gpt-image-2", 6);
    const serialized = [...memory.values.values()].join("");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("authorization");
  });

  it("does not append an unchanged polling observation", async () => {
    const memory = memoryStorage();
    const repository = new DesignTaskRepository({ storage: memory.storage });
    await repository.recordSubmitIntent("request-stable", "openai/gpt-image-2", 7);
    await repository.recordSubmitAccepted("request-stable", task("task-stable", "running"));
    const writesBeforePoll = memory.writeCount();

    await repository.recordTaskObserved(task("task-stable", "running"));

    expect(memory.writeCount()).toBe(writesBeforePoll);
  });

  it("replays a persisted poll failure and clears it after a successful observation", async () => {
    const memory = memoryStorage();
    const repository = new DesignTaskRepository({ storage: memory.storage });
    await repository.recordSubmitIntent("request-poll-failure", "openai/gpt-image-2", 9);
    await repository.recordSubmitAccepted(
      "request-poll-failure",
      task("task-poll-failure", "running"),
    );
    await repository.recordPollFailure("task-poll-failure", {
      attempt: 2,
      nextPollAt: 70_000,
      blocked: false,
      code: "rate-limited",
    });

    const restarted = new DesignTaskRepository({ storage: memory.storage });
    expect(await restarted.listTasks()).toEqual([
      expect.objectContaining({
        pollAttempt: 2,
        nextPollAt: 70_000,
        pollBlocked: false,
        pollDiagnostic: "rate-limited",
      }),
    ]);

    await restarted.recordTaskObserved(task("task-poll-failure", "running"));
    expect(await restarted.listTasks()).toEqual([
      expect.objectContaining({
        pollAttempt: 0,
        nextPollAt: 0,
        pollBlocked: false,
        pollDiagnostic: null,
      }),
    ]);
  });

  it("fails closed on a non-boolean persisted poll block state", async () => {
    const repository = new DesignTaskRepository({
      storage: {
        read: async () => JSON.stringify({
          version: 1,
          events: [
            {
              type: "submit-intent",
              sequence: 1,
              timestamp: 1,
              requestId: "request-invalid-block",
              modelSlug: "openai/gpt-image-2",
              credentialEpoch: 1,
            },
            {
              type: "submit-accepted",
              sequence: 2,
              timestamp: 2,
              requestId: "request-invalid-block",
              task: task("task-invalid-block", "running"),
            },
            {
              type: "task-poll-failed",
              sequence: 3,
              timestamp: 3,
              taskId: "task-invalid-block",
              attempt: 1,
              nextPollAt: 10,
              blocked: "false",
              code: "poll-unavailable",
            },
          ],
        }),
        write: async () => undefined,
      },
    });

    await expect(repository.listTasks()).rejects.toMatchObject({
      code: "STORAGE_INVALID",
    });
  });

  it("checkpoints the latest replayable task state when the event limit is reached", async () => {
    const memory = memoryStorage();
    let now = 1_000;
    const repository = new DesignTaskRepository({
      storage: memory.storage,
      clock: { now: () => now },
      maxEvents: 2,
    });
    await repository.recordSubmitIntent("request-compact", "openai/gpt-image-2", 8);
    await repository.recordSubmitAccepted("request-compact", task("task-compact", "queued"));
    now = 2_000;

    await repository.recordTaskObserved(task("task-compact", "running"));

    expect(await repository.listTasks()).toEqual([
      expect.objectContaining({
        requestId: "request-compact",
        credentialEpoch: 8,
        taskId: "task-compact",
        state: "running",
        updatedAt: 2_000,
      }),
    ]);
    const stored = JSON.parse([...memory.values.values()].join("")) as {
      events: readonly unknown[];
    };
    expect(stored.events).toHaveLength(2);
  });

  it("fails closed on corrupt storage", async () => {
    const repository = new DesignTaskRepository({
      storage: {
        read: async () => "{bad",
        write: async () => undefined,
      },
    });
    await expect(repository.listTasks()).rejects.toMatchObject({
      code: "STORAGE_INVALID",
    });
  });

  it("fails closed when persisted task resources target a private host", async () => {
    const repository = new DesignTaskRepository({
      storage: {
        read: async () => JSON.stringify({
          version: 1,
          events: [
            {
              type: "submit-intent",
              sequence: 1,
              timestamp: 1,
              requestId: "request-private-resource",
              modelSlug: "openai/gpt-image-2",
              credentialEpoch: 1,
            },
            {
              type: "submit-accepted",
              sequence: 2,
              timestamp: 2,
              requestId: "request-private-resource",
              task: {
                ...task("task-private-resource", "succeeded"),
                resources: [{
                  kind: "image",
                  url: "https://127.0.0.1/private.png",
                  mimeType: "image/png",
                  expiresAt: null,
                }],
              },
            },
          ],
        }),
        write: async () => undefined,
      },
    });

    await expect(repository.listTasks()).rejects.toMatchObject({
      code: "STORAGE_INVALID",
    });
  });
});

describe("selectAvailableResults", () => {
  it("prefers resource expiry, then upstream task expiry, then seven days", () => {
    const base = 10_000;
    const records = [
      {
        requestId: "request-a",
        modelSlug: "openai/gpt-image-2",
        credentialEpoch: 1,
        taskId: "task-a",
        state: "succeeded" as const,
        createdAt: 1_000,
        updatedAt: base,
        completedAt: base,
        expiresAt: base + 50_000,
        pollAttempt: 0,
        nextPollAt: 0,
        pollBlocked: false,
        pollDiagnostic: null,
        resources: [
          {
            kind: "image" as const,
            url: "https://cdn.example/per-resource.png",
            mimeType: "image/png",
            expiresAt: base + 20_000,
          },
          {
            kind: "video" as const,
            url: "https://cdn.example/task.mp4",
            mimeType: "video/mp4",
            expiresAt: null,
          },
        ],
      },
      {
        requestId: "request-b",
        modelSlug: "acme/audio",
        credentialEpoch: 1,
        taskId: "task-b",
        state: "succeeded" as const,
        createdAt: 2_000,
        updatedAt: base,
        completedAt: base,
        expiresAt: null,
        pollAttempt: 0,
        nextPollAt: 0,
        pollBlocked: false,
        pollDiagnostic: null,
        resources: [
          {
            kind: "audio" as const,
            url: "https://cdn.example/default.mp3",
            mimeType: "audio/mpeg",
            expiresAt: null,
          },
        ],
      },
    ];

    expect(selectAvailableResults(records, base + 1).map((result) => result.expiresAt)).toEqual([
      base + 20_000,
      base + 50_000,
      base + DEFAULT_RESULT_TTL_MS,
    ]);
    expect(selectAvailableResults(records, base + 20_000).map((result) => result.url)).not.toContain(
      "https://cdn.example/per-resource.png",
    );
  });

  it("rejects non-contiguous WAL sequences", () => {
    expect(() =>
      replayDesignWal([
        {
          type: "submit-intent",
          sequence: 2,
          timestamp: 1,
          requestId: "request",
          modelSlug: "openai/model",
        },
      ]),
    ).toThrowError(DesignError);
  });

  it("rejects an unknown persisted WAL event type", () => {
    expect(() =>
      replayDesignWal([
        {
          type: "future-or-corrupt",
          sequence: 1,
          timestamp: 1,
        } as never,
      ]),
    ).toThrowError(DesignError);
  });
});

function task(
  taskId: string,
  status: PredictionTask["status"],
): PredictionTask {
  return {
    taskId,
    status,
    resources: [],
    createdAt: null,
    completedAt: null,
    expiresAt: null,
  };
}

function memoryStorage(): {
  readonly values: Map<string, string>;
  readonly storage: StoragePort;
  readonly writeCount: () => number;
} {
  const values = new Map<string, string>();
  let writes = 0;
  return {
    values,
    writeCount: () => writes,
    storage: {
      read: async (key) => values.get(key) ?? null,
      write: async (key, value) => {
        writes += 1;
        values.set(key, value);
      },
    },
  };
}
