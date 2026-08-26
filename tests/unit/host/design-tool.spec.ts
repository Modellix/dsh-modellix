import type { Context } from "@deepseek-ai/cordis";
import type {
  PreToolDecision,
  ToolDefinition,
  ToolExecution,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";

import { DesignError } from "../../../src/design/index.js";
import type { DesignSnapshotWire } from "../../../src/host/design-controller.js";
import {
  MODELLIX_DESIGN_GENERATE_TOOL,
  MODELLIX_DESIGN_MODELS_TOOL,
  MODELLIX_DESIGN_PREPARE_TOOL,
  MODELLIX_DESIGN_TASK_TOOL,
  createModellixDesignToolDefinitions,
  registerModellixDesignTools,
  type DesignToolController,
} from "../../../src/host/design-tool.js";
import { DESIGN_WIRE_LIMITS } from "../../../src/shared/design-wire-limits.js";

const MODEL_ID = "openai/gpt-image-2";
const HASH = "a".repeat(64);

function snapshot(
  overrides: Partial<DesignSnapshotWire> = {},
): DesignSnapshotWire {
  return {
    version: 1,
    enabled: true,
    credentialReady: true,
    models: [
      {
        id: MODEL_ID,
        label: "GPT Image 2",
        kind: "image",
        featured: true,
        available: true,
        unavailableReason: null,
      },
      {
        id: "bytedance/seedance-2.0-mini-t2v",
        label: "Seedance Mini",
        kind: "video",
        featured: false,
        available: true,
        unavailableReason: null,
      },
    ],
    selectedModelId: MODEL_ID,
    draft: {
      modelId: MODEL_ID,
      draftRevision: 4,
      irContractHash: HASH,
      primaryInputPath: "/prompt",
      fields: [
        {
          path: "/prompt",
          label: "Prompt",
          description: "Describe the image.",
          kind: "string",
          widget: "textarea",
          required: true,
          options: [],
          minimum: null,
          maximum: null,
          step: null,
          maxLength: 32_000,
          disabledReason: null,
        },
        {
          path: "/quality",
          label: "Quality",
          description: null,
          kind: "enum",
          widget: "select",
          required: false,
          options: [
            { label: "low", value: "low" },
            { label: "high", value: "high" },
          ],
          minimum: null,
          maximum: null,
          step: null,
          maxLength: null,
          disabledReason: null,
        },
      ],
      parameters: { "/quality": "low" },
    },
    proposal: null,
    jobs: [],
    notice: null,
    ...overrides,
  };
}

function execution(sessionId = "session-1", signal = new AbortController().signal): ToolRunContext {
  return {
    agent: { id: sessionId },
    signal,
  } as unknown as ToolRunContext;
}

function definition(
  controller: DesignToolController,
  name: string,
): ToolDefinition {
  const found = createModellixDesignToolDefinitions(controller).find(
    (candidate) => candidate.name === name,
  );
  if (found === undefined) throw new Error(`missing tool ${name}`);
  return found;
}

describe("Modellix Design tools", () => {
  it("publishes only the four fixed modellix_design names", () => {
    const controller = { handle: vi.fn() } as unknown as DesignToolController;
    expect(createModellixDesignToolDefinitions(controller).map((item) => item.name)).toEqual([
      MODELLIX_DESIGN_MODELS_TOOL,
      MODELLIX_DESIGN_PREPARE_TOOL,
      MODELLIX_DESIGN_GENERATE_TOOL,
      MODELLIX_DESIGN_TASK_TOOL,
    ]);
  });

  it("searches models, returns a compact schema, and injects a safe session id", async () => {
    const calls: { endpoint: string; payload: unknown }[] = [];
    const controller: DesignToolController = {
      async handle(endpoint, payload) {
        calls.push({ endpoint, payload });
        return snapshot();
      },
    };
    const tool = definition(controller, MODELLIX_DESIGN_MODELS_TOOL);
    const result = await tool.execute(
      { query: "image", model: MODEL_ID, limit: 10 },
      execution("unsafe/session id"),
    ) as {
      models: { modelId: string }[];
      schema?: { primaryInputPath: string; fields: { path: string }[] };
    };

    expect(result.models).toEqual([{ modelId: MODEL_ID, label: "GPT Image 2", kind: "image", featured: true, available: true }]);
    expect(result.schema).toMatchObject({
      primaryInputPath: "/prompt",
      fields: [{ path: "/prompt" }, { path: "/quality" }],
    });
    expect(calls.map((call) => call.endpoint)).toEqual(["design/read", "design/select-model"]);
    const firstPayload = calls[0]?.payload as { sessionId: string };
    expect(firstPayload.sessionId).toMatch(/^tool_[a-f0-9]{48}$/u);
    expect(firstPayload.sessionId).not.toContain("unsafe");
  });

  it("prepares a visible proposal without calling Design submit", async () => {
    const endpoints: string[] = [];
    const controller: DesignToolController = {
      async handle(endpoint) {
        endpoints.push(endpoint);
        if (endpoint !== "design/propose") return snapshot();
        return snapshot({
          proposal: {
            proposalId: `proposal_${"b".repeat(32)}`,
            baseDraftRevision: 4,
            summary: "1 parameter change proposed.",
            changes: [{ path: "/prompt", label: "Prompt", after: "a red fox" }],
            conflicts: [],
          },
        });
      },
    };
    const tool = definition(controller, MODELLIX_DESIGN_PREPARE_TOOL);
    const result = await tool.execute(
      { model: MODEL_ID, instruction: "a red fox" },
      execution(),
    ) as { proposalId: string; requiresConfirmation: boolean; changes: unknown[] };

    expect(result).toMatchObject({
      proposalId: `proposal_${"b".repeat(32)}`,
      requiresConfirmation: true,
    });
    expect(result.changes).toHaveLength(1);
    expect(endpoints).toEqual(["design/read", "design/select-model", "design/propose"]);
    expect(endpoints).not.toContain("design/submit");
  });

  it("maps prompt and named fields to schema pointers and submits exactly once", async () => {
    const calls: { endpoint: string; payload: unknown }[] = [];
    const job: DesignSnapshotWire["jobs"][number] = {
      jobId: "task-123",
      modelId: MODEL_ID,
      status: "running",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      resources: [],
      diagnostic: null,
    };
    const controller: DesignToolController = {
      async handle(endpoint, payload) {
        calls.push({ endpoint, payload });
        return endpoint === "design/submit" ? snapshot({ jobs: [job] }) : snapshot();
      },
    };
    const tool = definition(controller, MODELLIX_DESIGN_GENERATE_TOOL);
    const result = await tool.execute(
      { model: MODEL_ID, prompt: "a red fox", input: { quality: "high" } },
      execution(),
    ) as { status: string; jobId?: string; noAutomaticRetry: boolean };

    expect(result).toMatchObject({
      status: "running",
      jobId: "task-123",
      noAutomaticRetry: true,
    });
    expect(calls.filter((call) => call.endpoint === "design/submit")).toHaveLength(1);
    expect(calls.at(-1)?.payload).toMatchObject({
      modelId: MODEL_ID,
      draftRevision: 4,
      irContractHash: HASH,
      parameters: { "/prompt": "a red fox", "/quality": "high" },
    });
    expect(JSON.stringify(calls)).not.toMatch(/api.?key|authorization/iu);
  });

  it("rejects deeply nested Generate input before recursive normalization or paid submit", async () => {
    const endpoints: string[] = [];
    const controller: DesignToolController = {
      async handle(endpoint) {
        endpoints.push(endpoint);
        return snapshot();
      },
    };
    let nested: unknown = "value";
    for (let depth = 0; depth <= DESIGN_WIRE_LIMITS.maxJsonDepth; depth += 1) {
      nested = [nested];
    }
    const tool = definition(controller, MODELLIX_DESIGN_GENERATE_TOOL);

    await expect(tool.execute(
      { model: MODEL_ID, input: { prompt: nested } },
      execution(),
    )).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "input exceeds the Design JSON structural budget",
    });
    expect(endpoints).toEqual(["design/read", "design/select-model"]);
    expect(endpoints).not.toContain("design/submit");
  });

  it("normalizes an ambiguous paid POST to a non-retryable canonical result", async () => {
    let submits = 0;
    const controller: DesignToolController = {
      async handle(endpoint) {
        if (endpoint === "design/submit") {
          submits += 1;
          throw new DesignError(
            "SUBMIT_UNKNOWN",
            "The paid request outcome is unknown; do not retry automatically",
          );
        }
        return snapshot();
      },
    };
    const tool = definition(controller, MODELLIX_DESIGN_GENERATE_TOOL);
    const result = await tool.execute(
      { model: MODEL_ID, prompt: "a red fox" },
      execution(),
    ) as { status: string; noAutomaticRetry: boolean; diagnostic?: { code: string } };

    expect(submits).toBe(1);
    expect(result).toMatchObject({
      status: "submit-unknown",
      noAutomaticRetry: true,
      diagnostic: { code: "submit-unknown" },
    });
  });

  it("rejects unknown top-level arguments before any Host call", async () => {
    const handle = vi.fn();
    const tool = definition({ handle }, MODELLIX_DESIGN_GENERATE_TOOL);
    await expect(tool.execute(
      { model: MODEL_ID, prompt: "safe", apiKey: "must-not-be-accepted" },
      execution(),
    )).rejects.toThrow("Unknown tool argument");
    expect(handle).not.toHaveBeenCalled();
  });

  it("does not dispatch work when the Tool signal is already aborted", async () => {
    const handle = vi.fn();
    const tool = definition({ handle }, MODELLIX_DESIGN_MODELS_TOOL);
    const abort = new AbortController();
    abort.abort();
    await expect(tool.execute({}, execution("session-1", abort.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("requires the Host-provided agent session instead of accepting one in args", async () => {
    const handle = vi.fn();
    const tool = definition({ handle }, MODELLIX_DESIGN_MODELS_TOOL);
    await expect(tool.execute({}, { signal: new AbortController().signal } as ToolRunContext))
      .rejects.toThrow("requires an active Harness session");
    expect(handle).not.toHaveBeenCalled();
  });

  it("refreshes and returns only a persisted matching task", async () => {
    const job: DesignSnapshotWire["jobs"][number] = {
      jobId: "task-123",
      modelId: MODEL_ID,
      status: "succeeded",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:01:00.000Z",
      resources: [{
        id: "resource-1",
        kind: "image",
        url: "https://cdn.example.test/result.png",
        downloadUrl: "https://cdn.example.test/result.png",
        expiresAt: "2026-09-01T00:00:00.000Z",
      }],
      diagnostic: null,
    };
    const controller: DesignToolController = {
      handle: () => Promise.resolve(snapshot({ jobs: [job] })),
    };
    const tool = definition(controller, MODELLIX_DESIGN_TASK_TOOL);
    const result = await tool.execute({ task_id: "task-123" }, execution()) as {
      found: boolean;
      job?: { resources: { url: string }[] };
    };

    expect(result.found).toBe(true);
    expect(result.job?.resources).toEqual([{ kind: "image", url: "https://cdn.example.test/result.png", expiresAt: "2026-09-01T00:00:00.000Z" }]);
  });

  it("registers distinct one-shot approval gates for LLM prepare and paid generate", async () => {
    const definitions: ToolDefinition[] = [];
    let listener: ((
      exec: ToolExecution,
      next: () => Promise<PreToolDecision>,
    ) => Promise<PreToolDecision>) | undefined;
    const disposeListener = vi.fn();
    const disposeDefinitions = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const ctx = {
      on(name: string, callback: typeof listener) {
        expect(name).toBe("tools/pre-execute");
        listener = callback;
        return disposeListener;
      },
      tools: {
        register(item: ToolDefinition) {
          definitions.push(item);
          return disposeDefinitions[definitions.length - 1] as () => void;
        },
      },
    } as unknown as Context;
    const controller = { handle: vi.fn() } as unknown as DesignToolController;

    const dispose = registerModellixDesignTools(ctx, controller);
    expect(definitions).toHaveLength(4);
    if (listener === undefined) throw new Error("approval listener was not registered");
    const approved = await listener(
      { name: MODELLIX_DESIGN_GENERATE_TOOL } as ToolExecution,
      () => Promise.resolve({ kind: "allow" }),
    );
    const readOnly = await listener(
      { name: MODELLIX_DESIGN_MODELS_TOOL } as ToolExecution,
      () => Promise.resolve({ kind: "allow" }),
    );
    const prepared = await listener(
      { name: MODELLIX_DESIGN_PREPARE_TOOL } as ToolExecution,
      () => Promise.resolve({ kind: "allow" }),
    );
    expect(approved).toMatchObject({
      kind: "ask",
      reason: expect.stringContaining("paid Modellix Design generation"),
    });
    expect(prepared).toMatchObject({
      kind: "ask",
      reason: expect.stringContaining("Modellix LLM request"),
    });
    expect(readOnly).toEqual({ kind: "allow" });

    dispose();
    expect(disposeListener).toHaveBeenCalledOnce();
    disposeDefinitions.forEach((candidate) => expect(candidate).toHaveBeenCalledOnce());
  });
});
