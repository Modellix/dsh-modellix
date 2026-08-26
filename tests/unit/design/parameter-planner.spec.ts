import { describe, expect, it } from "vitest";

import { DesignError } from "../../../src/design/errors.js";
import {
  applyExactPatch,
  applyNaturalLanguage,
  buildInvocationBody,
  materializeDefaults,
} from "../../../src/design/parameter-planner.js";
import { parseDesignSchema } from "../../../src/design/schema-ir.js";
import type { DesignSchemaIR } from "../../../src/design/schema-ir.js";

const schema = parseDesignSchema({
  type: "object",
  required: ["prompt"],
  properties: {
    prompt: { type: "string", minLength: 1 },
    count: { type: "integer", minimum: 1, maximum: 4, default: 1 },
    safe: { type: "boolean", default: false },
    size: {
      type: "string",
      enum: ["1024x1024", "1536x1024"],
      default: "1024x1024",
    },
    advanced: {
      type: "object",
      properties: {
        seed: { type: "integer", minimum: 0, default: 0 },
      },
    },
  },
});

describe("parameter planner", () => {
  it("materializes false, zero, and nested defaults without inventing prompt", () => {
    expect(materializeDefaults(schema)).toEqual({
      count: 1,
      safe: false,
      size: "1024x1024",
      advanced: { seed: 0 },
    });
  });

  it("applies exact nested patches and rejects unknown model fields", () => {
    const current = materializeDefaults(schema);
    expect(
      applyExactPatch(schema, current, {
        set: { "/prompt": "A red fox", "/advanced/seed": 42 },
      }),
    ).toEqual({
      prompt: "A red fox",
      count: 1,
      safe: false,
      size: "1024x1024",
      advanced: { seed: 42 },
    });
    expect(() =>
      applyExactPatch(schema, current, { set: { "/steps": 99 } }),
    ).toThrowError(DesignError);
    expect(() =>
      applyExactPatch(schema, current, { set: { "/count": 99 } }),
    ).toThrowError("above maximum");
  });

  it("updates prompt from plain language but does not infer fuzzy parameters", () => {
    const plan = applyNaturalLanguage(
      schema,
      materializeDefaults(schema),
      "Make four cinematic foxes",
    );
    expect(plan.parameters).toMatchObject({
      prompt: "Make four cinematic foxes",
      count: 1,
    });
    expect(plan.appliedPaths).toEqual(["/prompt"]);

    const punctuation = applyNaturalLanguage(
      schema,
      materializeDefaults(schema),
      "Portrait: a fox at dusk",
    );
    expect(punctuation.parameters.prompt).toBe("Portrait: a fox at dusk");
  });

  it("accepts only explicit deterministic assignments and reports unknown ones", () => {
    const plan = applyNaturalLanguage(
      schema,
      materializeDefaults(schema),
      "A fox at dusk; count=4; safe=yes; size:1536x1024; imaginary=on",
    );
    expect(plan.parameters).toMatchObject({
      prompt: "A fox at dusk",
      count: 4,
      safe: true,
      size: "1536x1024",
    });
    expect(plan.appliedPaths).toEqual([
      "/count",
      "/safe",
      "/size",
      "/prompt",
    ]);
    expect(plan.ignoredAssignments).toEqual(["imaginary=on"]);
    expect(plan.parameters).not.toHaveProperty("imaginary");
  });

  it("builds the final call body and validates required fields immediately", () => {
    expect(
      buildInvocationBody(schema, {
        prompt: "A glass city",
        count: 2,
      }),
    ).toEqual({
      prompt: "A glass city",
      count: 2,
      safe: false,
      size: "1024x1024",
      advanced: { seed: 0 },
    });
    expect(() => buildInvocationBody(schema)).toThrowError("Required model field");
    expect(() =>
      buildInvocationBody(schema, { prompt: "ok", invented: true }),
    ).toThrowError("Unknown model field");
  });

  it("submits a scalar default when the upstream schema omits its type", () => {
    const tts = parseDesignSchema({
      type: "object",
      required: ["text", "language"],
      properties: {
        text: { type: "string", minLength: 1 },
        language: { type: "string", enum: ["en", "zh"] },
        voice_id: { default: "eve" },
      },
    });

    expect(buildInvocationBody(tts, { text: "Test.", language: "en" })).toEqual({
      text: "Test.",
      language: "en",
      voice_id: "eve",
    });
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects unsafe JSON Pointer token %s even for a forged IR",
    (token) => {
      const safe = parseDesignSchema({
        type: "object",
        properties: {
          container: {
            type: "object",
            properties: { prompt: { type: "string" } },
          },
        },
      });
      const container = safe.fields[0]!;
      const prompt = container.properties[0]!;
      const unsafe: DesignSchemaIR = {
        ...safe,
        supported: true,
        fields: [{
          ...container,
          key: token,
          path: `/${token}`,
          properties: [{ ...prompt, path: `/${token}/prompt` }],
        }],
        primaryPromptPath: `/${token}/prompt`,
      };
      const prototype = Object.prototype as Record<string, unknown>;
      delete prototype.polluted;
      try {
        expect(() => applyExactPatch(unsafe, {}, {
          set: { [`/${token}/prompt`]: "polluted" },
        })).toThrowError("Unsafe model field path");
        expect(prototype.polluted).toBeUndefined();
      } finally {
        delete prototype.polluted;
      }
    },
  );
});
