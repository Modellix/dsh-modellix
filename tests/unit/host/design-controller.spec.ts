import { describe, expect, it, vi } from "vitest";

import type { StoragePort } from "../../../src/design/ports.js";
import {
  DesignHostController,
  type DesignSnapshotWire,
} from "../../../src/host/design-controller.js";

const MODEL_ID = "openai/gpt-image-2";
const SCHEMA_URL = "https://www.modellix.ai/models/openai/gpt-image-2/api_schema";
const SUBMIT_URL = "https://api.modellix.ai/api/v1/openai/gpt-image-2";
const CATALOG_URL = "https://api.modellix.ai/api/v1/models";
const PLANNER_URL = "https://llm.modellix.ai/v1/chat/completions";
const API_KEY_SENTINEL = "SENTINEL_MODELLIX_API_KEY";

describe("DesignHostController", () => {
  it("uses one explicit planner call to propose a visible diff without generating media", async () => {
    let plannerPosts = 0;
    let paidPosts = 0;
    let plannerBody: unknown;
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === PLANNER_URL && init?.method === "POST") {
        plannerPosts += 1;
        plannerBody = JSON.parse(String(init.body));
        return jsonResponse({
          choices: [{
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                set: [{ path: "/quality", value: "high" }],
                unset: [],
                needsClarification: null,
              }),
            },
          }],
        });
      }
      if (url === SUBMIT_URL && init?.method === "POST") {
        paidPosts += 1;
        return jsonResponse({ task_id: "unexpected", status: "queued" });
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    });
    const selected = await selectDefaultModel(harness.controller, "session-plan");
    const draft = requireDraft(selected);

    const proposed = await harness.controller.handle("design/propose", {
      version: 1,
      sessionId: "session-plan",
      modelId: MODEL_ID,
      instruction: "Use high quality",
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
    });

    expect(plannerPosts).toBe(1);
    expect(paidPosts).toBe(0);
    expect(plannerBody).toMatchObject({
      model: "openai/gpt-5.6-luna",
      stream: false,
    });
    expect(proposed.draft?.parameters).toEqual({
      "/prompt": undefined,
      "/quality": "standard",
    });
    expect(proposed.proposal).toMatchObject({
      changes: [{ path: "/quality", before: "standard", after: "high" }],
      conflicts: [],
    });

    const applied = await harness.controller.handle("design/proposal/apply", {
      version: 1,
      sessionId: "session-plan",
      proposalId: proposed.proposal?.proposalId,
    });
    expect(applied.draft?.parameters["/quality"]).toBe("high");
    assertNoSecretOnWire(applied, harness.values);
  });

  it("fails closed when the authoritative schema hash or draft revision changes", async () => {
    let activeSchema = modelSchema();
    let schemaReads = 0;
    let paidPosts = 0;
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) {
        schemaReads += 1;
        return jsonResponse(activeSchema);
      }
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === SUBMIT_URL && init?.method === "POST") {
        paidPosts += 1;
        return jsonResponse({ task_id: "task-should-not-run", status: "queued" });
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    });

    const selected = await selectDefaultModel(harness.controller);
    const draft = requireDraft(selected);

    await expect(harness.controller.handle("design/submit", {
      version: 1,
      sessionId: "session-hash",
      modelId: MODEL_ID,
      draftRevision: draft.draftRevision + 1,
      irContractHash: draft.irContractHash,
      parameters: { "/prompt": "A stale revision" },
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(schemaReads).toBe(1);
    expect(paidPosts).toBe(0);

    activeSchema = modelSchema({
      quality: { type: "string", enum: ["standard", "high"], default: "standard" },
      seed: { type: "integer", minimum: 0, default: 0 },
    });
    await expect(harness.controller.handle("design/submit", {
      version: 1,
      sessionId: "session-hash",
      modelId: MODEL_ID,
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
      parameters: { "/prompt": "A changed contract" },
    })).rejects.toMatchObject({ code: "SCHEMA_INVALID" });

    expect(schemaReads).toBe(2);
    expect(paidPosts).toBe(0);
    expect(harness.values.size).toBe(0);
  });

  it("durably records intent before one exact paid POST and keeps the Secret out of RPC and WAL", async () => {
    const trace: string[] = [];
    let signalIntentWrite!: () => void;
    let releaseIntentWrite!: () => void;
    const intentWriteReached = new Promise<void>((resolve) => {
      signalIntentWrite = resolve;
    });
    const intentWriteGate = new Promise<void>((resolve) => {
      releaseIntentWrite = resolve;
    });
    let postBody: unknown;
    let postHeaders = new Headers();
    let paidPosts = 0;
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === SUBMIT_URL && init?.method === "POST") {
        paidPosts += 1;
        trace.push("paid-post");
        postBody = JSON.parse(String(init.body));
        postHeaders = new Headers(init.headers);
        return jsonResponse({ task_id: "task-accepted", status: "queued" });
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    }, {
      onStorageWrite: async (value) => {
        const document = JSON.parse(value) as {
          readonly events: readonly { readonly type: string }[];
        };
        const eventType = document.events.at(-1)?.type ?? "missing";
        if (eventType === "submit-intent") {
          signalIntentWrite();
          await intentWriteGate;
        }
        trace.push(`wal:${eventType}`);
      },
    });

    const selected = await selectDefaultModel(harness.controller, "session-submit");
    const draft = requireDraft(selected);
    const submission = harness.controller.handle("design/submit", {
      version: 1,
      sessionId: "session-submit",
      modelId: MODEL_ID,
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
      parameters: {
        "/prompt": "A paper city",
        "/quality": "high",
      },
    });
    await intentWriteReached;
    expect(paidPosts).toBe(0);
    releaseIntentWrite();
    const snapshot = await submission;

    expect(trace).toEqual([
      "wal:submit-intent",
      "paid-post",
      "wal:submit-accepted",
    ]);
    expect(paidPosts).toBe(1);
    expect(postBody).toEqual({ prompt: "A paper city", quality: "high" });
    expect(postHeaders.get("authorization")).toBe(`Bearer ${API_KEY_SENTINEL}`);
    expect(postHeaders.get("x-request-id")).toMatch(/^request_[a-f0-9]{32}$/u);
    expect(snapshot.jobs).toEqual([
      expect.objectContaining({ jobId: "task-accepted", status: "running" }),
    ]);
    expect(requireDraft(snapshot).draftRevision).toBe(draft.draftRevision + 1);

    assertNoSecretOnWire(snapshot, harness.values);
  });

  it("persists submit-unknown and refuses to replay the stale request, including after restart", async () => {
    let paidPosts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === SUBMIT_URL && init?.method === "POST") {
        paidPosts += 1;
        throw new Error("connection outcome is ambiguous");
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    });
    const harness = controllerHarness(fetchMock);
    const selected = await selectDefaultModel(harness.controller, "session-unknown");
    const draft = requireDraft(selected);
    const submit = {
      version: 1,
      sessionId: "session-unknown",
      modelId: MODEL_ID,
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
      parameters: { "/prompt": "Never replay this paid request" },
    } as const;

    await expect(harness.controller.handle("design/submit", submit)).rejects.toMatchObject({
      code: "SUBMIT_UNKNOWN",
    });
    await expect(harness.controller.handle("design/submit", submit)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(paidPosts).toBe(1);

    const sameProcess = await harness.controller.handle("design/read", {
      version: 1,
      sessionId: "session-unknown",
    });
    expect(sameProcess.jobs).toEqual([
      expect.objectContaining({
        status: "submit-unknown",
        diagnostic: {
          code: "submit-unknown",
          message: "The generation outcome is unknown.",
          retryable: false,
        },
      }),
    ]);

    const restarted = controllerHarness(fetchMock, { values: harness.values });
    const recovered = await restarted.controller.handle("design/read", {
      version: 1,
      sessionId: "session-after-restart",
    });
    expect(recovered.jobs).toEqual([
      expect.objectContaining({ status: "submit-unknown" }),
    ]);
    expect(paidPosts).toBe(1);
    assertNoSecretOnWire(recovered, restarted.values);
  });

  it("polls queued tasks once, exposes only safe unexpired resources, then expires them", async () => {
    const completedAt = Date.parse("2026-08-25T01:00:00.000Z");
    const expiresAt = Date.parse("2026-08-25T02:00:00.000Z");
    let now = Date.parse("2026-08-25T01:30:00.000Z");
    let taskReads = 0;
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === SUBMIT_URL && init?.method === "POST") {
        return jsonResponse({ task_id: "task-poll", status: "queued" });
      }
      if (url === "https://api.modellix.ai/api/v1/tasks/task-poll" && init?.method === "GET") {
        taskReads += 1;
        return jsonResponse({
          data: {
            task_id: "task-poll",
            status: "completed",
            completed_at: new Date(completedAt).toISOString(),
            result_expires_at: new Date(expiresAt).toISOString(),
            resources: [
              { type: "image", url: "https://cdn.example/result.png" },
              { type: "image", url: "http://cdn.example/insecure.png" },
              { type: "image", url: "https://user:password@cdn.example/credential.png" },
              { type: "video", url: "javascript:alert(1)" },
            ],
          },
        });
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    }, { now: () => now });

    const selected = await selectDefaultModel(harness.controller, "session-poll");
    const draft = requireDraft(selected);
    await harness.controller.handle("design/submit", {
      version: 1,
      sessionId: "session-poll",
      modelId: MODEL_ID,
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
      parameters: { "/prompt": "A safe result" },
    });

    const completed = await harness.controller.handle("design/read", {
      version: 1,
      sessionId: "session-poll",
    });
    expect(taskReads).toBe(1);
    expect(completed.jobs).toEqual([
      expect.objectContaining({
        jobId: "task-poll",
        status: "succeeded",
        resources: [{
          id: expect.stringMatching(/^resource_0_[a-f0-9]{16}$/u),
          kind: "image",
          url: "https://cdn.example/result.png",
          downloadUrl: "https://cdn.example/result.png",
          expiresAt: new Date(expiresAt).toISOString(),
        }],
      }),
    ]);

    now = expiresAt;
    const expired = await harness.controller.handle("design/read", {
      version: 1,
      sessionId: "session-poll",
    });
    expect(taskReads).toBe(1);
    expect(expired.jobs).toEqual([
      expect.objectContaining({ status: "expired", resources: [] }),
    ]);
    assertNoSecretOnWire(expired, harness.values);
  });
});

interface HarnessOptions {
  readonly values?: Map<string, string>;
  readonly now?: () => number;
  readonly onStorageWrite?: (value: string) => void | Promise<void>;
}

function controllerHarness(
  fetchPort: typeof fetch,
  options: HarnessOptions = {},
): {
  readonly controller: DesignHostController;
  readonly values: Map<string, string>;
} {
  const values = options.values ?? new Map<string, string>();
  const storage: StoragePort = {
    read: async (key) => values.get(key) ?? null,
    write: async (key, value) => {
      await options.onStorageWrite?.(value);
      values.set(key, value);
    },
  };
  return {
    values,
    controller: new DesignHostController({
      storage,
      resolveCredential: async () => ({
        value: API_KEY_SENTINEL,
        credentialEpoch: 7,
      }),
      isCredentialEpochCurrent: (epoch) => epoch === 7,
      onUnauthorized: vi.fn(async () => undefined),
      isEnabled: () => true,
      getLastModel: () => null,
      rememberModel: vi.fn(async () => undefined),
      fetch: fetchPort,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  };
}

async function selectDefaultModel(
  controller: DesignHostController,
  sessionId = "session-hash",
): Promise<DesignSnapshotWire> {
  return controller.handle("design/select-model", {
    version: 1,
    sessionId,
    modelId: MODEL_ID,
  });
}

function requireDraft(snapshot: DesignSnapshotWire): NonNullable<DesignSnapshotWire["draft"]> {
  expect(snapshot.draft).not.toBeNull();
  return snapshot.draft as NonNullable<DesignSnapshotWire["draft"]>;
}

function assertNoSecretOnWire(
  snapshot: DesignSnapshotWire,
  values: ReadonlyMap<string, string>,
): void {
  const rpc = JSON.stringify(snapshot);
  const persisted = [...values.values()].join("");
  for (const serialized of [rpc, persisted]) {
    expect(serialized).not.toContain(API_KEY_SENTINEL);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("Bearer ");
  }
}

function modelSchema(
  extraProperties: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    servers: [{ url: SUBMIT_URL }],
    post: {
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["prompt"],
              properties: {
                prompt: { type: "string", minLength: 1, maxLength: 4_000 },
                quality: {
                  type: "string",
                  enum: ["standard", "high"],
                  default: "standard",
                },
                ...extraProperties,
              },
            },
          },
        },
      },
    },
  };
}

function catalogResponse(): Response {
  return jsonResponse({
    data: {
      items: [{
        provider: "openai",
        model_id: "gpt-image-2",
        display_name: "GPT Image 2",
        category: "image",
      }],
      page: 1,
      page_size: 100,
      total: 1,
    },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
