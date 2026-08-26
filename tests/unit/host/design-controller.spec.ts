import { describe, expect, it, vi } from "vitest";

import type { StoragePort } from "../../../src/design/ports.js";
import {
  DesignHostController,
  type DesignSnapshotWire,
} from "../../../src/host/design-controller.js";
import { DESIGN_WIRE_LIMITS } from "../../../src/shared/design-wire-limits.js";

const MODEL_ID = "openai/gpt-image-2";
const SCHEMA_URL = "https://www.modellix.ai/models/openai/gpt-image-2/api_schema";
const SUBMIT_URL = "https://api.modellix.ai/api/v1/openai/gpt-image-2";
const CATALOG_URL = "https://api.modellix.ai/api/v1/models";
const PLANNER_URL = "https://llm.modellix.ai/v1/chat/completions";
const API_KEY_SENTINEL = "SENTINEL_MODELLIX_API_KEY";
const TTS_MODEL_ID = "xai/grok-voice-tts";
const TTS_SCHEMA_URL = "https://www.modellix.ai/models/xai/grok-voice-tts/api_schema";
const TTS_SUBMIT_URL = "https://api.modellix.ai/api/v1/xai/grok-voice-tts";
const ASR_MODEL_ID = "openai/gpt-audio-transcribe";
const ASR_SCHEMA_URL = "https://www.modellix.ai/models/openai/gpt-audio-transcribe/api_schema";

describe("DesignHostController", () => {
  it("exposes stable localizable notice codes instead of Host prose", async () => {
    const catalogUnavailable = controllerHarness(async (input) => {
      const url = String(input);
      if (url.startsWith(CATALOG_URL)) return jsonResponse({ error: "offline" }, 503);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const unavailable = await catalogUnavailable.controller.handle("design/read", {
      version: 1,
      sessionId: "session-catalog-unavailable",
    });
    expect(unavailable.notice).toBe("catalog-unavailable");

    const schemaInvalid = controllerHarness(async (input) => {
      const url = String(input);
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === SCHEMA_URL) return jsonResponse({});
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const invalid = await schemaInvalid.controller.handle("design/read", {
      version: 1,
      sessionId: "session-schema-invalid",
    });
    expect(invalid.notice).toBe("schema-invalid");
    expect(invalid.draft).toBeNull();
  });

  it("uses required exact text for TTS while keeping ASR without generation text unavailable", async () => {
    const tts = controllerHarness(async (input) => {
      const url = String(input);
      if (url.startsWith(CATALOG_URL)) return catalogResponseFor(TTS_MODEL_ID, "audio");
      if (url === TTS_SCHEMA_URL) {
        return jsonResponse({
          servers: [{ url: TTS_SUBMIT_URL }],
          post: operationWithSchema({
            type: "object",
            required: ["voice_prompt", "text"],
            properties: {
              voice_prompt: { type: "string" },
              text: { type: "string", minLength: 1, maxLength: 4_000 },
            },
          }),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const selected = await tts.controller.handle("design/select-model", {
      version: 1,
      sessionId: "session-tts",
      modelId: TTS_MODEL_ID,
    });
    expect(selected.models.find((model) => model.id === TTS_MODEL_ID)).toMatchObject({
      kind: "audio",
      available: true,
    });
    expect(requireDraft(selected).primaryInputPath).toBe("/text");

    const asr = controllerHarness(async (input) => {
      const url = String(input);
      if (url.startsWith(CATALOG_URL)) return catalogResponseFor(ASR_MODEL_ID, "audio");
      if (url === ASR_SCHEMA_URL) {
        return jsonResponse({
          servers: [{ url: "https://api.modellix.ai/api/v1/openai/gpt-audio-transcribe" }],
          post: operationWithSchema({
            type: "object",
            required: ["audio", "language"],
            properties: {
              audio: { type: "string", contentMediaType: "audio/wav" },
              language: { type: "string" },
              text: { type: "string" },
            },
          }),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await expect(asr.controller.handle("design/select-model", {
      version: 1,
      sessionId: "session-asr",
      modelId: ASR_MODEL_ID,
    })).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

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
      parameters: {
        "/prompt": "A paper city",
        "/quality": "standard",
      },
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

    await expect(harness.controller.handle("design/proposal/apply", {
      version: 1,
      sessionId: "session-plan",
      proposalId: proposed.proposal?.proposalId,
      parameters: {
        "/prompt": "A paper city edited after proposal",
        "/quality": "standard",
      },
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const applied = await harness.controller.handle("design/proposal/apply", {
      version: 1,
      sessionId: "session-plan",
      proposalId: proposed.proposal?.proposalId,
      parameters: {
        "/prompt": "A paper city",
        "/quality": "standard",
      },
    });
    expect(applied.draft?.parameters["/quality"]).toBe("high");
    expect(applied.draft?.parameters["/prompt"]).toBe("A paper city");
    assertNoSecretOnWire(applied, harness.values);
  });

  it("fences concurrent and queued duplicate planner requests for one draft", async () => {
    let plannerPosts = 0;
    let plannerStarted!: () => void;
    let resolvePlanner!: (response: Response) => void;
    const started = new Promise<void>((resolve) => {
      plannerStarted = resolve;
    });
    const plannerResponse = new Promise<Response>((resolve) => {
      resolvePlanner = resolve;
    });
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === PLANNER_URL && init?.method === "POST") {
        plannerPosts += 1;
        plannerStarted();
        return plannerResponse;
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    });
    const selected = await selectDefaultModel(harness.controller, "session-plan-fence");
    const draft = requireDraft(selected);
    const payload = {
      version: 1,
      sessionId: "session-plan-fence",
      modelId: MODEL_ID,
      instruction: "Use high quality",
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
      parameters: { "/prompt": "A paper city", "/quality": "standard" },
    };

    const first = harness.controller.handle("design/propose", payload);
    await started;
    await expect(harness.controller.handle("design/propose", payload)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "A Design proposal is already pending review",
    });
    expect(plannerPosts).toBe(1);

    resolvePlanner(jsonResponse({
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
    }));
    await expect(first).resolves.toMatchObject({ proposal: { baseDraftRevision: draft.draftRevision } });

    await expect(harness.controller.handle("design/propose", payload)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "A Design proposal is already pending review",
    });
    expect(plannerPosts).toBe(1);
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

  it("retries only the local accepted-task commit after a successful paid POST", async () => {
    let paidPosts = 0;
    let acceptedWrites = 0;
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === SUBMIT_URL && init?.method === "POST") {
        paidPosts += 1;
        return jsonResponse({ task_id: "task-local-retry", status: "queued" });
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    }, {
      onStorageWrite: (value) => {
        const document = JSON.parse(value) as {
          readonly events: readonly { readonly type: string }[];
        };
        if (document.events.at(-1)?.type === "submit-accepted" && acceptedWrites++ === 0) {
          throw new Error("transient local commit failure");
        }
      },
    });
    const selected = await selectDefaultModel(harness.controller, "session-local-retry");
    const draft = requireDraft(selected);

    const result = await harness.controller.handle("design/submit", {
      version: 1,
      sessionId: "session-local-retry",
      modelId: MODEL_ID,
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
      parameters: { "/prompt": "Persist this task once" },
    });

    expect(paidPosts).toBe(1);
    expect(acceptedWrites).toBe(2);
    expect(result.jobs).toEqual([
      expect.objectContaining({ jobId: "task-local-retry", status: "running" }),
    ]);
  });

  it("never marks a successful paid POST as rejected when its task core cannot be stored", async () => {
    let paidPosts = 0;
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === SUBMIT_URL && init?.method === "POST") {
        paidPosts += 1;
        return jsonResponse({ task_id: "task-storage-down", status: "queued" });
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    }, {
      onStorageWrite: (value) => {
        const document = JSON.parse(value) as {
          readonly events: readonly { readonly type: string }[];
        };
        if (document.events.at(-1)?.type === "submit-accepted") {
          throw new Error("accepted task core cannot be stored");
        }
      },
    });
    const selected = await selectDefaultModel(harness.controller, "session-storage-down");
    const draft = requireDraft(selected);

    await expect(harness.controller.handle("design/submit", {
      version: 1,
      sessionId: "session-storage-down",
      modelId: MODEL_ID,
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
      parameters: { "/prompt": "Do not report this as rejected" },
    })).rejects.toMatchObject({ code: "SUBMIT_UNKNOWN" });

    const recovered = await harness.controller.handle("design/read", {
      version: 1,
      sessionId: "session-storage-down",
    });
    expect(paidPosts).toBe(1);
    expect(recovered.jobs).toEqual([
      expect.objectContaining({ status: "submit-unknown" }),
    ]);
  });

  it("preserves submit-unknown when its WAL annotation cannot be stored", async () => {
    let paidPosts = 0;
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === SUBMIT_URL && init?.method === "POST") {
        paidPosts += 1;
        throw new Error("ambiguous paid transport outcome");
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    }, {
      onStorageWrite: (value) => {
        const document = JSON.parse(value) as {
          readonly events: readonly { readonly type: string }[];
        };
        if (document.events.at(-1)?.type === "submit-unknown") {
          throw new Error("submit-unknown annotation cannot be stored");
        }
      },
    });
    const selected = await selectDefaultModel(harness.controller, "session-unknown-storage");
    const draft = requireDraft(selected);

    await expect(harness.controller.handle("design/submit", {
      version: 1,
      sessionId: "session-unknown-storage",
      modelId: MODEL_ID,
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
      parameters: { "/prompt": "Keep the intent replay fence" },
    })).rejects.toMatchObject({ code: "SUBMIT_UNKNOWN" });

    const recovered = await harness.controller.handle("design/read", {
      version: 1,
      sessionId: "session-unknown-storage",
    });
    expect(paidPosts).toBe(1);
    expect(recovered.jobs).toEqual([
      expect.objectContaining({ status: "submit-unknown" }),
    ]);
  });

  it("does not poll a running task with a different credential generation", async () => {
    let credentialEpoch = 7;
    let paidPosts = 0;
    let taskReads = 0;
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === SUBMIT_URL && init?.method === "POST") {
        paidPosts += 1;
        return jsonResponse({ task_id: "task-old-credential", status: "queued" });
      }
      if (url.endsWith("/tasks/task-old-credential")) {
        taskReads += 1;
        return new Response(null, { status: 401 });
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    }, { credentialEpoch: () => credentialEpoch });
    const selected = await selectDefaultModel(harness.controller, "session-old-credential");
    const draft = requireDraft(selected);
    await harness.controller.handle("design/submit", {
      version: 1,
      sessionId: "session-old-credential",
      modelId: MODEL_ID,
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
      parameters: { "/prompt": "Bound to credential generation seven" },
    });

    credentialEpoch = 8;
    const snapshot = await harness.controller.handle("design/read", {
      version: 1,
      sessionId: "session-old-credential",
    });

    expect(paidPosts).toBe(1);
    expect(taskReads).toBe(0);
    expect(harness.onUnauthorized).not.toHaveBeenCalled();
    expect(snapshot.jobs).toEqual([
      expect.objectContaining({
        status: "running",
        diagnostic: expect.objectContaining({ code: "credential-changed" }),
      }),
    ]);
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

  it("polls a task-id-only submit response instead of leaving an unknown task stuck", async () => {
    let taskReads = 0;
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === SUBMIT_URL && init?.method === "POST") {
        return jsonResponse({ task_id: "task-status-unknown" });
      }
      if (url === "https://api.modellix.ai/api/v1/tasks/task-status-unknown") {
        taskReads += 1;
        return jsonResponse({
          task_id: "task-status-unknown",
          status: "completed",
          resources: [{ type: "image", url: "https://cdn.example/unknown-finished.png" }],
        });
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    });
    const selected = await selectDefaultModel(harness.controller, "session-unknown-status");
    const draft = requireDraft(selected);
    await harness.controller.handle("design/submit", {
      version: 1,
      sessionId: "session-unknown-status",
      modelId: MODEL_ID,
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
      parameters: { "/prompt": "Finish after a status read" },
    });

    const completed = await harness.controller.handle("design/read", {
      version: 1,
      sessionId: "session-unknown-status",
    });

    expect(taskReads).toBe(1);
    expect(completed.jobs[0]).toMatchObject({
      jobId: "task-status-unknown",
      status: "succeeded",
    });
  });

  it("polls more than five active tasks fairly across bounded batches", async () => {
    let nextTask = 0;
    const taskReads: string[] = [];
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === SUBMIT_URL && init?.method === "POST") {
        nextTask += 1;
        return jsonResponse({ task_id: `task-fair-${String(nextTask)}`, status: "queued" });
      }
      if (url.startsWith("https://api.modellix.ai/api/v1/tasks/task-fair-")) {
        taskReads.push(url);
        return jsonResponse({ task_id: url.split("/").at(-1), status: "running" });
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    });
    let snapshot = await selectDefaultModel(harness.controller, "session-fair");
    for (let index = 0; index < 6; index += 1) {
      const draft = requireDraft(snapshot);
      snapshot = await harness.controller.handle("design/submit", {
        version: 1,
        sessionId: "session-fair",
        modelId: MODEL_ID,
        draftRevision: draft.draftRevision,
        irContractHash: draft.irContractHash,
        parameters: { "/prompt": `Fair task ${String(index + 1)}` },
      });
    }

    await harness.controller.pollRunning();
    expect(taskReads).toHaveLength(5);
    await harness.controller.pollRunning();

    expect(new Set(taskReads.map((url) => url.split("/").at(-1)))).toEqual(new Set([
      "task-fair-1",
      "task-fair-2",
      "task-fair-3",
      "task-fair-4",
      "task-fair-5",
      "task-fair-6",
    ]));
  });

  it("persists an inaccessible-task diagnostic and never polls that task again", async () => {
    let taskReads = 0;
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === SUBMIT_URL && init?.method === "POST") {
        return jsonResponse({ task_id: "task-gone", status: "queued" });
      }
      if (url.endsWith("/tasks/task-gone")) {
        taskReads += 1;
        return jsonResponse({ error: "not found" }, 404);
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    });
    const selected = await selectDefaultModel(harness.controller, "session-gone");
    const draft = requireDraft(selected);
    await harness.controller.handle("design/submit", {
      version: 1,
      sessionId: "session-gone",
      modelId: MODEL_ID,
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
      parameters: { "/prompt": "A task that disappeared" },
    });

    const first = await harness.controller.handle("design/read", {
      version: 1,
      sessionId: "session-gone",
    });
    const second = await harness.controller.handle("design/read", {
      version: 1,
      sessionId: "session-gone",
    });

    expect(taskReads).toBe(1);
    expect(first.jobs[0]?.diagnostic).toEqual({
      code: "task-inaccessible",
      retryable: false,
    });
    expect(second.jobs[0]?.diagnostic).toEqual(first.jobs[0]?.diagnostic);
  });

  it("persists Retry-After and suppresses task reads until the deadline", async () => {
    let now = 10_000;
    let taskReads = 0;
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      if (url === SUBMIT_URL && init?.method === "POST") {
        return jsonResponse({ task_id: "task-rate-limited", status: "queued" });
      }
      if (url.endsWith("/tasks/task-rate-limited")) {
        taskReads += 1;
        if (taskReads === 1) {
          return new Response(JSON.stringify({ error: "slow down" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "60" },
          });
        }
        return jsonResponse({ task_id: "task-rate-limited", status: "running" });
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    }, { now: () => now });
    const selected = await selectDefaultModel(harness.controller, "session-rate-limited");
    const draft = requireDraft(selected);
    await harness.controller.handle("design/submit", {
      version: 1,
      sessionId: "session-rate-limited",
      modelId: MODEL_ID,
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
      parameters: { "/prompt": "Wait for the rate limit" },
    });

    const limited = await harness.controller.handle("design/read", {
      version: 1,
      sessionId: "session-rate-limited",
    });
    now += 59_999;
    await harness.controller.handle("design/read", {
      version: 1,
      sessionId: "session-rate-limited",
    });
    expect(taskReads).toBe(1);
    expect(limited.jobs[0]?.diagnostic).toMatchObject({
      code: "rate-limited",
      retryable: true,
    });

    now += 1;
    const resumed = await harness.controller.handle("design/read", {
      version: 1,
      sessionId: "session-rate-limited",
    });
    expect(taskReads).toBe(2);
    expect(resumed.jobs[0]?.diagnostic).toBeNull();
  });

  it("re-reads the catalog and rejects the prior draft after a credential epoch change", async () => {
    let epoch = 7;
    let catalogReads = 0;
    const harness = controllerHarness(async (input) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) {
        catalogReads += 1;
        return catalogResponse();
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, { credentialEpoch: () => epoch });
    const selected = await selectDefaultModel(harness.controller, "session-rotated");
    const oldDraft = requireDraft(selected);
    const readsWithFirstCredential = catalogReads;
    epoch = 8;

    const rotated = await harness.controller.handle("design/read", {
      version: 1,
      sessionId: "session-rotated",
    });

    expect(catalogReads).toBeGreaterThan(readsWithFirstCredential);
    expect(requireDraft(rotated).draftRevision).toBeGreaterThan(oldDraft.draftRevision);
    await expect(harness.controller.handle("design/submit", {
      version: 1,
      sessionId: "session-rotated",
      modelId: MODEL_ID,
      draftRevision: oldDraft.draftRevision,
      irContractHash: oldDraft.irContractHash,
      parameters: { "/prompt": "A stale credential draft" },
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("fails closed before a paid POST when the selected model leaves the live catalog", async () => {
    let catalogContainsModel = true;
    let paidPosts = 0;
    const harness = controllerHarness(async (input, init) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.startsWith(CATALOG_URL)) {
        return catalogContainsModel ? catalogResponse() : emptyCatalogResponse();
      }
      if (url === SUBMIT_URL && init?.method === "POST") {
        paidPosts += 1;
        return jsonResponse({ task_id: "must-not-submit", status: "queued" });
      }
      throw new Error(`Unexpected fetch: ${String(init?.method)} ${url}`);
    });
    const selected = await selectDefaultModel(harness.controller, "session-unavailable");
    const draft = requireDraft(selected);
    catalogContainsModel = false;
    const refreshed = await harness.controller.handle("design/refresh", {
      version: 1,
      sessionId: "session-unavailable",
    });
    expect(refreshed.models.find((model) => model.id === MODEL_ID)?.available).toBe(false);

    await expect(harness.controller.handle("design/submit", {
      version: 1,
      sessionId: "session-unavailable",
      modelId: MODEL_ID,
      draftRevision: draft.draftRevision,
      irContractHash: draft.irContractHash,
      parameters: { "/prompt": "Do not charge" },
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(paidPosts).toBe(0);
  });

  it("rejects schemas that cannot fit the closed Client field budget", async () => {
    const tooManyFields = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`extra_${String(index)}`, { type: "string" }]),
    );
    const harness = controllerHarness(async (input) => {
      const url = String(input);
      if (url === SCHEMA_URL) return jsonResponse(modelSchema(tooManyFields));
      if (url.startsWith(CATALOG_URL)) return catalogResponse();
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(selectDefaultModel(harness.controller, "session-field-budget")).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
  });

  it.each([
    ["design/propose", {
      version: 1,
      sessionId: "session-budget-propose",
      modelId: MODEL_ID,
      instruction: "Do not dispatch",
      draftRevision: 0,
      irContractHash: "a".repeat(64),
    }],
    ["design/proposal/apply", {
      version: 1,
      sessionId: "session-budget-apply",
      proposalId: `proposal_${"a".repeat(32)}`,
    }],
    ["design/submit", {
      version: 1,
      sessionId: "session-budget-submit",
      modelId: MODEL_ID,
      draftRevision: 0,
      irContractHash: "a".repeat(64),
    }],
  ] as const)("rejects deeply nested parameters at the %s boundary before network I/O", async (
    endpoint,
    payload,
  ) => {
    let networkCalls = 0;
    const harness = controllerHarness(async () => {
      networkCalls += 1;
      throw new Error("must not reach network");
    });
    let nested: unknown = "value";
    for (let depth = 0; depth <= DESIGN_WIRE_LIMITS.maxJsonDepth; depth += 1) {
      nested = [nested];
    }

    await expect(harness.controller.handle(endpoint, {
      ...payload,
      parameters: { "/prompt": nested },
    })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "Design parameters exceed the JSON structural budget",
    });
    expect(networkCalls).toBe(0);
  });

  it("rejects parameter node, byte, and cycle violations before network I/O", async () => {
    let networkCalls = 0;
    const harness = controllerHarness(async () => {
      networkCalls += 1;
      throw new Error("must not reach network");
    });
    const base = {
      version: 1,
      sessionId: "session-budget-values",
      modelId: MODEL_ID,
      instruction: "Do not dispatch",
      draftRevision: 0,
      irContractHash: "a".repeat(64),
    };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const cases = [
      {
        parameters: {
          "/prompt": Array.from(
            { length: DESIGN_WIRE_LIMITS.maxJsonNodes },
            () => null,
          ),
        },
        message: "Design parameters exceed the JSON structural budget",
      },
      {
        parameters: { "/prompt": "x".repeat(DESIGN_WIRE_LIMITS.maxJsonBytes) },
        message: "Design parameters exceed the JSON byte budget",
      },
      {
        parameters: { "/prompt": cycle },
        message: "Design parameters must not contain cycles",
      },
    ] as const;

    for (const testCase of cases) {
      await expect(harness.controller.handle("design/propose", {
        ...base,
        parameters: testCase.parameters,
      })).rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: testCase.message });
    }
    expect(networkCalls).toBe(0);
  });

  it("derives featured membership only from the featured catalog query", async () => {
    const harness = controllerHarness(async (input) => {
      const url = new URL(String(input));
      if (url.href === SCHEMA_URL) return jsonResponse(modelSchema());
      if (url.origin + url.pathname === CATALOG_URL) {
        return url.searchParams.get("featured") === "true"
          ? emptyCatalogResponse()
          : catalogResponse();
      }
      throw new Error(`Unexpected fetch: ${url.href}`);
    }, { lastModel: () => MODEL_ID });

    const selected = await selectDefaultModel(harness.controller, "session-featured");

    expect(selected.selectedModelId).toBe(MODEL_ID);
    expect(selected.models.find((model) => model.id === MODEL_ID)?.featured).toBe(false);
  });
});

interface HarnessOptions {
  readonly values?: Map<string, string>;
  readonly now?: () => number;
  readonly onStorageWrite?: (value: string) => void | Promise<void>;
  readonly credentialEpoch?: () => number;
  readonly lastModel?: () => string | null;
}

function controllerHarness(
  fetchPort: typeof fetch,
  options: HarnessOptions = {},
): {
  readonly controller: DesignHostController;
  readonly values: Map<string, string>;
  readonly onUnauthorized: ReturnType<typeof vi.fn>;
} {
  const values = options.values ?? new Map<string, string>();
  const currentCredentialEpoch = options.credentialEpoch ?? (() => 7);
  const onUnauthorized = vi.fn(async () => undefined);
  const storage: StoragePort = {
    read: async (key) => values.get(key) ?? null,
    write: async (key, value) => {
      await options.onStorageWrite?.(value);
      values.set(key, value);
    },
  };
  return {
    values,
    onUnauthorized,
    controller: new DesignHostController({
      storage,
      resolveCredential: async () => ({
        value: API_KEY_SENTINEL,
        credentialEpoch: currentCredentialEpoch(),
      }),
      isCredentialEpochCurrent: (epoch) => epoch === currentCredentialEpoch(),
      onUnauthorized,
      isEnabled: () => true,
      getLastModel: options.lastModel ?? (() => null),
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

function operationWithSchema(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    requestBody: {
      content: {
        "application/json": { schema },
      },
    },
  };
}

function catalogResponseFor(modelId: string, category: "image" | "video" | "audio"): Response {
  const [provider, modelIdPart] = modelId.split("/");
  return jsonResponse({
    data: {
      items: [{
        provider,
        model_id: modelIdPart,
        display_name: modelId,
        category,
      }],
      page: 1,
      page_size: 100,
      total: 1,
    },
  });
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

function emptyCatalogResponse(): Response {
  return jsonResponse({
    data: { items: [], page: 1, page_size: 100, total: 0 },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
