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

    await repository.recordSubmitIntent("request-1", "openai/gpt-image-2");
    expect(await repository.listTasks()).toEqual([
      expect.objectContaining({
        requestId: "request-1",
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
    await repository.recordSubmitIntent("request-2", "openai/gpt-image-2");
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
    await repository.recordSubmitIntent("request-rejected", "openai/gpt-image-2");
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
    await repository.recordSubmitIntent("request-3", "openai/gpt-image-2");
    const serialized = [...memory.values.values()].join("");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("authorization");
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
});

describe("selectAvailableResults", () => {
  it("prefers resource expiry, then upstream task expiry, then seven days", () => {
    const base = 10_000;
    const records = [
      {
        requestId: "request-a",
        modelSlug: "openai/gpt-image-2",
        taskId: "task-a",
        state: "succeeded" as const,
        createdAt: 1_000,
        updatedAt: base,
        completedAt: base,
        expiresAt: base + 50_000,
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
        taskId: "task-b",
        state: "succeeded" as const,
        createdAt: 2_000,
        updatedAt: base,
        completedAt: base,
        expiresAt: null,
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
} {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      read: async (key) => values.get(key) ?? null,
      write: async (key, value) => {
        values.set(key, value);
      },
    },
  };
}
