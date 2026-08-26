import { describe, expect, it } from "vitest";

import { inspectJsonBudget } from "../../../src/shared/json-budget.js";

const GENEROUS_STRUCTURE = {
  maxDepth: 10,
  maxNodes: 100,
};

describe("iterative JSON budget", () => {
  it("accepts the exact escaped UTF-8 byte boundary and rejects one byte less", () => {
    const value = { text: 'quote: " emoji: 😀 newline:\n' };
    const exactBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;

    expect(inspectJsonBudget(value, {
      ...GENEROUS_STRUCTURE,
      maxBytes: exactBytes,
    })).toBeNull();
    expect(inspectJsonBudget(value, {
      ...GENEROUS_STRUCTURE,
      maxBytes: exactBytes - 1,
    })).toBe("bytes");
  });

  it("accepts exact depth/node boundaries and rejects the next child", () => {
    const value = { nested: [null] };
    expect(inspectJsonBudget(value, {
      maxBytes: 1_024,
      maxDepth: 2,
      maxNodes: 3,
    })).toBeNull();
    expect(inspectJsonBudget(value, {
      maxBytes: 1_024,
      maxDepth: 1,
      maxNodes: 3,
    })).toBe("depth");
    expect(inspectJsonBudget(value, {
      maxBytes: 1_024,
      maxDepth: 2,
      maxNodes: 2,
    })).toBe("nodes");
  });

  it("allows shared acyclic objects but rejects cycles and non-JSON values", () => {
    const child = { value: true };
    expect(inspectJsonBudget({ left: child, right: child }, {
      ...GENEROUS_STRUCTURE,
      maxBytes: 1_024,
    })).toBeNull();

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(inspectJsonBudget(cycle, {
      ...GENEROUS_STRUCTURE,
      maxBytes: 1_024,
    })).toBe("cycle");
    expect(inspectJsonBudget({ value: 1n }, {
      ...GENEROUS_STRUCTURE,
      maxBytes: 1_024,
    })).toBe("non-json");
  });
});
