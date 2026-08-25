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
                    pattern: ".+",
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

  it("discovers lexical-first OpenAPI POST and reports multiple operations", () => {
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
      expect.objectContaining({ code: "MULTIPLE_POST_OPERATIONS", blocking: false }),
    );
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

  it("detects reference cycles and node/depth budget exhaustion", () => {
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

    const budget = parseDesignSchema(
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 4 }, (_, index) => [`field_${index}`, { type: "string" }]),
        ),
      },
      { maxNodes: 2 },
    );
    expect(budget.diagnostics).toContainEqual(
      expect.objectContaining({ code: "BUDGET_EXCEEDED" }),
    );
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
});

function operationWith(schema: unknown): Record<string, unknown> {
  return {
    requestBody: {
      content: { "application/json": { schema } },
    },
  };
}
