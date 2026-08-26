import type { JsonValue, ToolDefinition } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";

import {
  MODELLIX_DESIGN_GENERATE_TOOL,
  MODELLIX_DESIGN_MODELS_TOOL,
  MODELLIX_DESIGN_PREPARE_TOOL,
  MODELLIX_DESIGN_TASK_TOOL,
  createModellixDesignToolDefinitions,
  type DesignToolController,
} from "../../../src/host/design-tool.js";

function tools(): ReadonlyMap<string, ToolDefinition> {
  const controller = { handle: vi.fn() } as unknown as DesignToolController;
  return new Map(
    createModellixDesignToolDefinitions(controller).map((definition) => [
      definition.name,
      definition,
    ]),
  );
}

function tool(definitions: ReadonlyMap<string, ToolDefinition>, name: string): ToolDefinition {
  const found = definitions.get(name);
  if (found === undefined) throw new Error(`missing tool ${name}`);
  return found;
}

function renderText(definition: ToolDefinition, value: JsonValue): string {
  const content = definition.output.render({}, value);
  const first = content[0];
  if (first?.type !== "text") throw new Error("tool did not render text");
  return first.text;
}

describe("Modellix Design tool presentation", () => {
  it("renders catalog availability, truncation, and compact schema context", () => {
    const models = tool(tools(), MODELLIX_DESIGN_MODELS_TOOL);
    const rich = renderText(models, {
      version: 1,
      service: "design",
      operation: "models",
      models: [
        {
          modelId: "openai/gpt-image-2",
          label: "GPT Image 2",
          kind: "image",
          featured: true,
          available: true,
        },
        {
          modelId: "retired/example",
          label: "Retired",
          kind: "video",
          featured: false,
          available: false,
          unavailableReason: "The selected model is no longer in the current catalog.",
        },
      ],
      truncated: true,
      selectedModelId: "openai/gpt-image-2",
      schema: {
        modelId: "openai/gpt-image-2",
        irContractHash: "a".repeat(64),
        primaryInputPath: "/prompt",
        fields: [
          {
            path: "/prompt",
            label: "Prompt",
            kind: "string",
            required: true,
            options: [],
          },
          {
            path: "/quality",
            label: "Quality",
            kind: "enum",
            required: false,
            options: ["low", "high"],
          },
        ],
        truncated: true,
      },
    });

    expect(rich).toContain("openai/gpt-image-2 (image)");
    expect(rich).toContain("retired/example (video) — unavailable");
    expect(rich).toContain("Results truncated; refine the query.");
    expect(rich).toContain("primary input /prompt");
    expect(rich).toContain("/prompt, /quality (truncated)");
    expect(renderText(models, {
      version: 1,
      service: "design",
      operation: "models",
      models: [],
      truncated: false,
    })).toBe("No matching Modellix Design models.");
  });

  it("renders proposal changes and conflicts while preserving the confirmation warning", () => {
    const prepare = tool(tools(), MODELLIX_DESIGN_PREPARE_TOOL);
    const changed = renderText(prepare, {
      version: 1,
      service: "design",
      operation: "prepare",
      modelId: "openai/gpt-image-2",
      irContractHash: "b".repeat(64),
      proposalId: `proposal_${"c".repeat(32)}`,
      baseDraftRevision: 7,
      summary: "Two fields reviewed.",
      changes: [
        { path: "/prompt", label: "Prompt", after: "a paper city" },
        { path: "/quality", label: "Quality", before: "low", after: "high" },
      ],
      conflicts: ["Duration needs clarification"],
      requiresConfirmation: true,
    });

    expect(changed).toContain("- /prompt (Prompt)");
    expect(changed).toContain("- /quality (Quality)");
    expect(changed).toContain("Conflicts: Duration needs clarification");
    expect(changed).toContain("explicitly confirm before generation");
    expect(renderText(prepare, {
      version: 1,
      service: "design",
      operation: "prepare",
      modelId: "openai/gpt-image-2",
      irContractHash: "d".repeat(64),
      proposalId: `proposal_${"e".repeat(32)}`,
      baseDraftRevision: 8,
      summary: "No changes.",
      changes: [],
      conflicts: [],
      requiresConfirmation: true,
    })).toContain("No parameter changes were proposed.");
  });

  it("renders generation resources and diagnostics without weakening the no-retry rule", () => {
    const generate = tool(tools(), MODELLIX_DESIGN_GENERATE_TOOL);
    const completed = renderText(generate, {
      version: 1,
      service: "design",
      operation: "generate",
      modelId: "openai/gpt-image-2",
      submitted: true,
      noAutomaticRetry: true,
      status: "succeeded",
      jobId: "task-123",
      resources: [
        {
          kind: "image",
          url: "https://cdn.example.test/result.png",
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      diagnostic: {
        code: "result-unavailable",
        message: "One optional result was unavailable.",
      },
    });

    expect(completed).toContain("succeeded (task-123)");
    expect(completed).toContain("One optional result was unavailable.");
    expect(completed).toContain("image: https://cdn.example.test/result.png");
    expect(completed).toContain("Do not automatically repeat this paid submission.");
    expect(renderText(generate, {
      version: 1,
      service: "design",
      operation: "generate",
      modelId: "openai/gpt-image-2",
      submitted: true,
      noAutomaticRetry: true,
      status: "submit-unknown",
      resources: [],
    })).toBe(
      "Modellix Design status: submit-unknown.\nDo not automatically repeat this paid submission.",
    );
  });

  it("renders missing and persisted task outcomes and all four pending call cards", () => {
    const definitions = tools();
    const task = tool(definitions, MODELLIX_DESIGN_TASK_TOOL);
    expect(renderText(task, {
      version: 1,
      service: "design",
      operation: "task",
      found: false,
    })).toBe("No persisted Modellix Design task matched that identifier.");
    expect(renderText(task, {
      version: 1,
      service: "design",
      operation: "task",
      found: true,
      job: {
        jobId: "task-456",
        modelId: "openai/gpt-image-2",
        status: "succeeded",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:01:00.000Z",
        resources: [{ kind: "video", url: "https://cdn.example.test/result.mp4" }],
      },
    })).toContain("task-456: succeeded.\n- video: https://cdn.example.test/result.mp4");

    const models = tool(definitions, MODELLIX_DESIGN_MODELS_TOOL);
    expect(models.presentCall?.({ query: "image" })).toMatchObject({
      card: "generic",
      title: "Browse Modellix Design models",
      kind: "search",
      rawInput: "image",
    });
    expect(models.presentCall?.({ model: "openai/gpt-image-2" })).toMatchObject({
      title: "Inspect openai/gpt-image-2",
    });
    expect(tool(definitions, MODELLIX_DESIGN_PREPARE_TOOL).presentCall?.({
      model: "openai/gpt-image-2",
      instruction: "make it square",
    })).toMatchObject({ title: "Prepare openai/gpt-image-2", kind: "execute" });
    expect(tool(definitions, MODELLIX_DESIGN_GENERATE_TOOL).presentCall?.({
      model: "openai/gpt-image-2",
    })).toMatchObject({ title: "Generate with openai/gpt-image-2", kind: "execute" });
    expect(task.presentCall?.({ task_id: "task-456" })).toMatchObject({
      title: "Inspect Design task task-456",
      kind: "read",
    });
  });
});
