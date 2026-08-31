import { describe, expect, it } from "vitest";

import { DesignError } from "../../../src/design/errors.js";
import { parseDesignSchema } from "../../../src/design/schema-ir.js";

describe("parseDesignSchema", () => {
  it("discovers a root POST body and preserves rich nested field metadata", () => {
    const ir = parseDesignSchema({
      servers: [{ url: "https://api.modellix.ai/api/v1/openai/gpt-image-2" }],
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["size", "prompt"],
                properties: {
                  optional_note: { type: "string" },
                  size: {
                    type: "string",
                    enum: ["1024x1024", "1536x1024"],
                    default: "1024x1024",
                  },
                  prompt: {
                    type: ["string", "null"],
                    minLength: 1,
                    maxLength: 4_000,
                    pattern: "^.+$",
                  },
                  count: {
                    type: "integer",
                    default: 1,
                    minimum: 1,
                    maximum: 4,
                  },
                  safe: { type: "boolean", default: false },
                  source: {
                    type: "object",
                    required: ["images"],
                    properties: {
                      images: {
                        type: "array",
                        minItems: 1,
                        maxItems: 3,
                        items: {
                          type: "string",
                          contentMediaType: "image/png",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(ir.supported).toBe(true);
    expect(ir.primaryPromptPath).toBe("/prompt");
    expect(ir.fields.map((field) => field.key)).toEqual([
      "prompt",
      "size",
      "optional_note",
      "count",
      "safe",
      "source",
    ]);
    const count = ir.fields.find((field) => field.key === "count");
    expect(count).toMatchObject({
      kind: "integer",
      hasDefault: true,
      defaultValue: 1,
      constraints: { minimum: 1, maximum: 4 },
    });
    const safe = ir.fields.find((field) => field.key === "safe");
    expect(safe).toMatchObject({ hasDefault: true, defaultValue: false });
    const images = ir.fields
      .find((field) => field.key === "source")
      ?.properties.find((field) => field.key === "images");
    expect(images?.item).toMatchObject({
      path: "/source/images/*",
      kind: "media",
      mediaKind: "image",
    });
  });

  it("selects explicit generation text fields by a closed priority", () => {
    const promptFirst = parseDesignSchema({
      type: "object",
      required: ["text", "prompt"],
      properties: {
        text: { type: "string" },
        negative_prompt: { type: "string" },
        prompt: { type: "string" },
      },
    });
    expect(promptFirst.primaryPromptPath).toBe("/prompt");

    const tts = parseDesignSchema({
      type: "object",
      required: ["voice_prompt", "text"],
      properties: {
        voice_prompt: { type: "string" },
        text: { type: "string", minLength: 1 },
      },
    });
    expect(tts.primaryPromptPath).toBe("/text");
    expect(tts.fields[0]?.key).toBe("text");

    const inputTextBeforeScript = parseDesignSchema({
      type: "object",
      required: ["script", "input_text"],
      properties: {
        script: { type: "string" },
        input_text: { type: "string" },
      },
    });
    expect(inputTextBeforeScript.primaryPromptPath).toBe("/input_text");

    const positivePromptFallback = parseDesignSchema({
      type: "object",
      required: ["positive_prompt"],
      properties: {
        positive_prompt: { type: "string" },
        negative_prompt: { type: "string" },
      },
    });
    expect(positivePromptFallback.primaryPromptPath).toBe("/positive_prompt");
  });

  it("conservatively infers scalar fields from authoritative defaults", () => {
    const ir = parseDesignSchema({
      type: "object",
      required: ["text", "language"],
      properties: {
        text: { type: "string" },
        language: { type: "string", enum: ["en", "zh"] },
        voice_id: { default: "eve" },
        structured: { default: { unsafeToInfer: true } },
      },
    });

    expect(ir.fields.find((field) => field.key === "voice_id")).toMatchObject({
      kind: "string",
      hasDefault: true,
      defaultValue: "eve",
    });
    expect(ir.fields.find((field) => field.key === "structured")?.kind).toBe("unknown");
  });

  it("does not promote optional ASR text metadata or arbitrary required strings", () => {
    const asr = parseDesignSchema({
      type: "object",
      required: ["audio", "language"],
      properties: {
        audio: { type: "string", contentMediaType: "audio/wav" },
        language: { type: "string" },
        text: { type: "string" },
      },
    });
    expect(asr.primaryPromptPath).toBeNull();

    const modifierOnly = parseDesignSchema({
      type: "object",
      required: ["voice_prompt", "prompt"],
      properties: {
        voice_prompt: { type: "string" },
        prompt: { type: "string", const: "fixed" },
      },
    });
    expect(modifierOnly.primaryPromptPath).toBeNull();
  });

  it("fails closed when OpenAPI exposes multiple paid POST operations", () => {
    const ir = parseDesignSchema({
      openapi: "3.1.0",
      paths: {
        "/z": { post: operationWith({ type: "object", properties: { z: { type: "string" } } }) },
        "/a": { post: operationWith({ type: "object", properties: { a: { type: "string" } } }) },
      },
    });
    expect(ir.operationPath).toBe("/a");
    expect(ir.fields.map((field) => field.key)).toEqual(["a"]);
    expect(ir.diagnostics).toContainEqual(
      expect.objectContaining({ code: "MULTIPLE_POST_OPERATIONS", blocking: true }),
    );
    expect(ir.supported).toBe(false);
  });

  it("accepts api_schema variants whose root post is already the body schema", () => {
    const ir = parseDesignSchema({
      servers: [{ url: "https://api.modellix.ai/api/v1/acme/model" }],
      post: {
        type: "object",
        required: ["prompt"],
        properties: { prompt: { type: "string" } },
      },
    });
    expect(ir.supported).toBe(true);
    expect(ir.primaryPromptPath).toBe("/prompt");
  });

  it("accepts the linear Modellix width*height pattern used by image models", () => {
    const ir = parseDesignSchema({
      servers: [{ url: "https://api.modellix.ai/api/v1/alibaba/qwen-image-3.0-pro" }],
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["prompt"],
                properties: {
                  prompt: { type: "string" },
                  size: {
                    type: "string",
                    pattern: "^\\d+\\*\\d+$",
                    example: "1024*1024",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(ir.supported).toBe(true);
    expect(ir.diagnostics).toEqual([]);
    expect(ir.fields.find((field) => field.key === "size")?.constraints.pattern)
      .toBe("^\\d+\\*\\d+$");
  });

  it("decodes RFC 6901 references and merges allOf constraints", () => {
    const ir = parseDesignSchema({
      $defs: {
        "shared/type": {
          type: "string",
          minLength: 2,
          enum: ["small", "large"],
        },
      },
      type: "object",
      required: ["quality"],
      properties: {
        quality: {
          allOf: [
            { $ref: "#/$defs/shared~1type" },
            { minLength: 4, default: "large" },
          ],
        },
      },
    });
    expect(ir.supported).toBe(true);
    expect(ir.fields[0]).toMatchObject({
      key: "quality",
      required: true,
      kind: "string",
      enumValues: ["small", "large"],
      hasDefault: true,
      defaultValue: "large",
      constraints: { minLength: 4 },
    });
  });

  it("retains oneOf/anyOf variants and unsupported diagnostics", () => {
    const ir = parseDesignSchema({
      type: "object",
      properties: {
        output: {
          oneOf: [
            { title: "Image", type: "string", "x-media-type": "image" },
            { title: "Video", type: "string", "x-media-type": "video" },
          ],
        },
        guarded: { type: "string", if: { minLength: 1 } },
        hinted: { type: "string", multipleOf: 2 },
      },
    });
    expect(ir.fields.find((field) => field.key === "output")?.variants).toEqual([
      expect.objectContaining({ combinator: "oneOf", title: "Image" }),
      expect.objectContaining({ combinator: "oneOf", title: "Video" }),
    ]);
    expect(ir.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "if", blocking: true }),
        expect.objectContaining({ keyword: "multipleOf", blocking: true }),
      ]),
    );
    expect(ir.supported).toBe(false);
  });

  it("detects reference cycles and rejects raw budget exhaustion before hashing", () => {
    const cycle = parseDesignSchema({
      $defs: {
        node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/node" } },
        },
      },
      type: "object",
      properties: { root: { $ref: "#/$defs/node" } },
    });
    expect(cycle.supported).toBe(false);
    expect(cycle.diagnostics).toContainEqual(
      expect.objectContaining({ code: "REF_CYCLE", blocking: true }),
    );

    expect(() => parseDesignSchema(
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 4 }, (_, index) => [`field_${index}`, { type: "string" }]),
        ),
      },
      { maxNodes: 2 },
    )).toThrowError(DesignError);

    let deeplyNested: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 10_000; depth += 1) {
      deeplyNested = { nested: deeplyNested };
    }
    expect(() => parseDesignSchema(deeplyNested)).toThrowError(DesignError);
  });

  it("bounds acyclic shared-reference DAG traversal before exponential expansion", () => {
    const definitions: Record<string, unknown> = {
      level_0: { type: "string" },
    };
    for (let level = 1; level <= 20; level += 1) {
      const previous = `#/$defs/level_${String(level - 1)}`;
      definitions[`level_${String(level)}`] = {
        allOf: [{ $ref: previous }, { $ref: previous }],
      };
    }

    const ir = parseDesignSchema({
      $defs: definitions,
      type: "object",
      required: ["prompt"],
      properties: { prompt: { $ref: "#/$defs/level_20" } },
    });

    expect(ir.supported).toBe(false);
    expect(ir.diagnostics).toContainEqual(expect.objectContaining({
      code: "BUDGET_EXCEEDED",
      blocking: true,
      message: "Schema parsing stopped at the maximum schema traversal operation count",
    }));
  });

  it("accepts the exact raw structural boundary and rejects one step beyond it", () => {
    const boundary = {
      type: "object",
      properties: { prompt: { type: "string" } },
    };
    expect(parseDesignSchema(boundary, { maxDepth: 3, maxNodes: 5 }).supported).toBe(true);
    expect(() => parseDesignSchema(boundary, { maxDepth: 2, maxNodes: 5 }))
      .toThrowError("depth limit");
    expect(() => parseDesignSchema(boundary, { maxDepth: 3, maxNodes: 4 }))
      .toThrowError("node limit");
  });

  it("produces a stable SHA-256 hash independent of object key insertion order", () => {
    const left = parseDesignSchema({
      type: "object",
      properties: { prompt: { type: "string", default: "x" } },
    });
    const right = parseDesignSchema({
      properties: { prompt: { default: "x", type: "string" } },
      type: "object",
    });
    expect(left.schemaHash).toBe(right.schemaHash);
    expect(left.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects oversized schema documents before traversal", () => {
    expect(() =>
      parseDesignSchema(
        { type: "string", description: "x".repeat(2_000) },
        { maxBytes: 1_024 },
      ),
    ).toThrowError(DesignError);
  });

  it.each([
    "^(a|aa)+$",
    "^(a+)+$",
    "^a*a*b$",
    ".+",
  ])("blocks untrusted regular expression %s before runtime validation", (pattern) => {
    const ir = parseDesignSchema({
      type: "object",
      properties: { prompt: { type: "string", pattern } },
    });

    expect(ir.supported).toBe(false);
    expect(ir.diagnostics).toContainEqual(expect.objectContaining({
      keyword: "pattern",
      blocking: true,
    }));
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects unsafe property name %s before it enters the Schema IR",
    (propertyName) => {
      const ir = parseDesignSchema({
        type: "object",
        properties: Object.fromEntries([
          [propertyName, {
            type: "object",
            properties: { prompt: { type: "string" } },
          }],
        ]),
      });

      expect(ir.supported).toBe(false);
      expect(ir.fields).toEqual([]);
      expect(ir.diagnostics).toContainEqual(expect.objectContaining({
        code: "INVALID_KEYWORD",
        keyword: "properties",
        blocking: true,
        message: expect.stringContaining("unsafe"),
      }));
    },
  );
});

function operationWith(schema: unknown): Record<string, unknown> {
  return {
    requestBody: {
      content: { "application/json": { schema } },
    },
  };
}
