export type JsonBudgetViolation =
  | "bytes"
  | "depth"
  | "nodes"
  | "cycle"
  | "non-json";

export interface JsonBudgetLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

/**
 * Inspects an untrusted JSON-shaped value without recursive calls or a second
 * serialized buffer. A null result means JSON.stringify would stay within the
 * supplied byte, depth, and node budgets.
 */
export function inspectJsonBudget(
  value: unknown,
  limits: JsonBudgetLimits,
): JsonBudgetViolation | null {
  type Frame =
    | { readonly kind: "value"; readonly value: unknown; readonly depth: number }
    | { readonly kind: "leave"; readonly value: object };
  const stack: Frame[] = [{ kind: "value", value, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;

  const addBytes = (count: number): boolean => {
    bytes += count;
    return bytes <= limits.maxBytes;
  };

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (frame.kind === "leave") {
      ancestors.delete(frame.value);
      continue;
    }
    nodes += 1;
    if (nodes > limits.maxNodes) return "nodes";
    if (frame.depth > limits.maxDepth) return "depth";

    const candidate = frame.value;
    if (candidate === null) {
      if (!addBytes(4)) return "bytes";
      continue;
    }
    if (typeof candidate === "boolean") {
      if (!addBytes(candidate ? 4 : 5)) return "bytes";
      continue;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) return "non-json";
      if (!addBytes(Object.is(candidate, -0) ? 1 : String(candidate).length)) return "bytes";
      continue;
    }
    if (typeof candidate === "string") {
      if (!addBytes(jsonStringBytes(candidate, limits.maxBytes))) return "bytes";
      continue;
    }
    if (typeof candidate !== "object") return "non-json";
    if (ancestors.has(candidate)) return "cycle";
    ancestors.add(candidate);
    stack.push({ kind: "leave", value: candidate });

    if (Array.isArray(candidate)) {
      if (candidate.length > 0 && frame.depth >= limits.maxDepth) return "depth";
      if (nodes + candidate.length > limits.maxNodes) return "nodes";
      if (!addBytes(2 + Math.max(0, candidate.length - 1))) return "bytes";
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "value", value: candidate[index], depth: frame.depth + 1 });
      }
      continue;
    }

    const keys = Object.keys(candidate);
    if (keys.length > 0 && frame.depth >= limits.maxDepth) return "depth";
    if (nodes + keys.length > limits.maxNodes) return "nodes";
    if (!addBytes(2 + Math.max(0, keys.length - 1))) return "bytes";
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index] as string;
      if (!addBytes(jsonStringBytes(key, limits.maxBytes) + 1)) return "bytes";
      stack.push({
        kind: "value",
        value: (candidate as Record<string, unknown>)[key],
        depth: frame.depth + 1,
      });
    }
  }
  return null;
}

/** Exact UTF-8 byte count of a JSON string literal without materializing it. */
function jsonStringBytes(value: string, stopAfter: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code <= 0x1f || (code >= 0xd800 && code <= 0xdfff)) {
      if (code <= 0x1f) {
        bytes += 6;
      } else if (
        code <= 0xdbff &&
        index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 &&
        value.charCodeAt(index + 1) <= 0xdfff
      ) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}
