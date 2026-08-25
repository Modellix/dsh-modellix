import { describe, expect, it, vi } from "vitest";

import { DesignError } from "../../../src/design/errors.js";
import type {
  DesignLogEvent,
  FetchPort,
  LoggerPort,
} from "../../../src/design/ports.js";
import {
  PredictionClient,
  parsePredictionTask,
  validateSubmitEndpoint,
} from "../../../src/design/prediction-client.js";

const endpoint = "https://api.modellix.ai/api/v1/openai/gpt-image-2";

describe("PredictionClient", () => {
  it("submits once to the exact schema endpoint without an async alias", async () => {
    const fetchMock = vi.fn<FetchPort>().mockResolvedValue(
      jsonResponse({
        task_id: "task-1",
        status: "queued",
      }),
    );
    const client = new PredictionClient({ fetch: fetchMock });
    const body = { prompt: "A paper city", count: 1 } as const;

    await expect(
      client.submit({
        endpoint,
        modelSlug: "openai/gpt-image-2",
        apiKey: "key-secret",
        body,
        requestId: "request-1",
      }),
    ).resolves.toMatchObject({ taskId: "task-1", status: "queued" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe(endpoint);
    expect(String(call?.[0])).not.toContain("/async");
    expect(call?.[1]?.method).toBe("POST");
    expect(call?.[1]?.redirect).toBe("error");
    expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(
      "Bearer key-secret",
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual(body);
  });

  it.each([
    `${endpoint}/async`,
    "https://api.modellix.ai/api/v1/openai/another",
    "https://evil.example/api/v1/openai/gpt-image-2",
  ])("rejects endpoints not exactly bound to the model: %s", (value) => {
    expect(() =>
      validateSubmitEndpoint(value, "openai/gpt-image-2"),
    ).toThrowError(DesignError);
  });

  it("maps a transport ambiguity to SUBMIT_UNKNOWN with zero retry", async () => {
    const fetchMock = vi
      .fn<FetchPort>()
      .mockRejectedValue(new Error("connection reset"));
    const client = new PredictionClient({ fetch: fetchMock });
    await expect(
      client.submit({
        endpoint,
        modelSlug: "openai/gpt-image-2",
        apiKey: "key-secret",
        body: { prompt: "do not retry me" },
      }),
    ).rejects.toMatchObject({ code: "SUBMIT_UNKNOWN" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("treats retryable HTTP POST status as unknown without retry", async () => {
    const fetchMock = vi
      .fn<FetchPort>()
      .mockResolvedValue(jsonResponse({ error: "busy" }, 503));
    const client = new PredictionClient({ fetch: fetchMock });
    await expect(
      client.submit({
        endpoint,
        modelSlug: "openai/gpt-image-2",
        apiKey: "key-secret",
        body: { prompt: "once" },
      }),
    ).rejects.toMatchObject({ code: "SUBMIT_UNKNOWN", status: 503 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries bounded task GETs and parses image/video/audio resources", async () => {
    const fetchMock = vi
      .fn<FetchPort>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "busy" },
          503,
          { "retry-after": "2" },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            task_id: "task-2",
            status: "completed",
            completed_at: "2026-08-25T00:00:00.000Z",
            result: {
              result_expires_at: "2026-09-01T00:00:00.000Z",
              resources: [
                { type: "image", url: "https://cdn.example/a.png" },
                { mime_type: "video/mp4", url: "https://cdn.example/b" },
                { audio_url: "https://cdn.example/c.mp3" },
              ],
            },
          },
        }),
      );
    const sleep = vi.fn<(delay: number) => Promise<void>>().mockResolvedValue();
    const client = new PredictionClient({
      fetch: fetchMock,
      sleep: { sleep },
      clock: { now: () => Date.parse("2026-08-25T00:00:00.000Z") },
    });

    const task = await client.readTask({
      taskId: "task-2",
      apiKey: "key-secret",
      maxAttempts: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(task.status).toBe("succeeded");
    expect(task.resources.map((resource) => resource.kind)).toEqual([
      "image",
      "video",
      "audio",
    ]);
    expect(task.resources.every((resource) => resource.expiresAt === Date.parse("2026-09-01T00:00:00.000Z"))).toBe(true);
    const call = fetchMock.mock.calls[1];
    expect(String(call?.[0])).toBe("https://api.modellix.ai/api/v1/tasks/task-2");
    expect(call?.[1]?.method).toBe("GET");
  });

  it("never places API keys or prompts in logger events", async () => {
    const events: DesignLogEvent[] = [];
    const logger: LoggerPort = { write: (event) => events.push(event) };
    const client = new PredictionClient({
      fetch: vi.fn<FetchPort>().mockResolvedValue(
        jsonResponse({ task_id: "task-3", status: "queued" }),
      ),
      logger,
    });
    await client.submit({
      endpoint,
      modelSlug: "openai/gpt-image-2",
      apiKey: "SENTINEL_API_KEY",
      body: { prompt: "SENTINEL_PRIVATE_PROMPT" },
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("SENTINEL_API_KEY");
    expect(serialized).not.toContain("SENTINEL_PRIVATE_PROMPT");
    expect(serialized).not.toContain("authorization");
  });
});

describe("parsePredictionTask", () => {
  it("rejects a mismatched task identifier", () => {
    expect(() =>
      parsePredictionTask({ task_id: "other", status: "running" }, "expected"),
    ).toThrowError(DesignError);
  });

  it("accepts nested task envelopes and grouped resource collections", () => {
    expect(
      parsePredictionTask({
        data: {
          task: {
            id: "nested-task",
            state: "success",
            result: {
              images: ["https://cdn.example/image.webp"],
              videos: [{ url: "https://cdn.example/video.bin" }],
              audios: ["https://cdn.example/audio.wav"],
            },
          },
        },
      }),
    ).toMatchObject({
      taskId: "nested-task",
      status: "succeeded",
      resources: [
        { kind: "image" },
        { kind: "video" },
        { kind: "audio" },
      ],
    });
  });
});

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
