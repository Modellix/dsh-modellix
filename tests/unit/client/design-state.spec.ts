import { describe, expect, it } from "vitest";

import type {
  DesignFieldWire,
  DesignSnapshotWire,
} from "../../../src/client/contracts.js";
import {
  canGenerateDesign,
  designOutcomeTransition,
  isDesignFieldValueValid,
  selectedDesignModel,
} from "../../../src/client/design-state.js";

function field(overrides: Partial<DesignFieldWire> = {}): DesignFieldWire {
  return {
    path: "/count",
    label: "Count",
    description: null,
    kind: "integer",
    widget: "input",
    required: false,
    options: [],
    minimum: 1,
    maximum: 4,
    step: 1,
    maxLength: null,
    disabledReason: null,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<DesignSnapshotWire> = {},
): DesignSnapshotWire {
  return {
    version: 1,
    enabled: true,
    credentialReady: true,
    models: [
      {
        id: "openai/gpt-image-2",
        label: "GPT Image 2",
        kind: "image",
        featured: true,
        available: true,
        unavailableReason: null,
      },
    ],
    selectedModelId: "openai/gpt-image-2",
    draft: {
      modelId: "openai/gpt-image-2",
      draftRevision: 1,
      irContractHash: "schemahash1234",
      primaryInputPath: "/prompt",
      fields: [field({
        path: "/prompt",
        label: "Prompt",
        kind: "string",
        widget: "textarea",
        required: true,
        minimum: null,
        maximum: null,
        step: null,
      })],
      parameters: { "/prompt": "A test" },
    },
    proposal: null,
    jobs: [],
    notice: null,
    ...overrides,
  };
}

describe("Modellix Design Client state", () => {
  it("blocks billed generation when the selected model is unavailable", () => {
    const unavailable = snapshot({
      models: [{
        ...snapshot().models[0]!,
        available: false,
        unavailableReason: "removed-from-catalog",
      }],
    });
    expect(selectedDesignModel(unavailable)?.available).toBe(false);
    expect(canGenerateDesign({
      snapshot: unavailable,
      draft: unavailable.draft,
      invalidFieldCount: 0,
      missingRequired: false,
      interactionBusy: false,
    })).toBe(false);
  });

  it("validates numeric bounds, integer semantics, and step", () => {
    const count = field();
    expect(isDesignFieldValueValid(count, undefined)).toBe(true);
    expect(isDesignFieldValueValid(count, 1)).toBe(true);
    expect(isDesignFieldValueValid(count, 0)).toBe(false);
    expect(isDesignFieldValueValid(count, 5)).toBe(false);
    expect(isDesignFieldValueValid(count, 1.5)).toBe(false);
    expect(
      isDesignFieldValueValid(
        field({ kind: "number", minimum: 0.5, maximum: 2.5, step: 0.5 }),
        2,
      ),
    ).toBe(true);
  });

  it("detects proposal and job status transitions without announcing initial history", () => {
    const initial = snapshot();
    expect(designOutcomeTransition(null, initial)).toEqual({
      proposalReady: false,
      running: 0,
      succeeded: 0,
      failed: 0,
      expired: 0,
    });
    const running = snapshot({
      jobs: [{
        jobId: "job_1",
        modelId: "openai/gpt-image-2",
        status: "running",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
        resources: [],
        diagnostic: null,
      }],
    });
    expect(designOutcomeTransition(initial, running).running).toBe(1);
    const succeeded = snapshot({
      ...running,
      jobs: [{ ...running.jobs[0]!, status: "succeeded" }],
    });
    expect(designOutcomeTransition(running, succeeded).succeeded).toBe(1);
  });
});
