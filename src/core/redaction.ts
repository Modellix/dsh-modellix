export const REDACTED = "[REDACTED]" as const;

export type HeaderValue = string | readonly string[] | undefined;
export type HeaderRecord = Readonly<Record<string, HeaderValue>>;
export type RedactedValue =
  | null
  | boolean
  | number
  | string
  | readonly RedactedValue[]
  | { readonly [key: string]: RedactedValue };

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
]);

const SENSITIVE_FIELD = /^(?:api[-_]?key|authorization|cookie|password|secret|access[-_]?token|refresh[-_]?token|id[-_]?token)$/iu;

export function redactHeaders(headers: HeaderRecord): Record<string, string | string[]> {
  const redacted: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    defineEnumerableOwnProperty(redacted, name, SENSITIVE_HEADERS.has(name.toLowerCase())
      ? REDACTED
      : Array.isArray(value)
        ? value.map(redactPotentialUrl)
        : redactPotentialUrl(value as string));
  }
  return redacted;
}

/** Removes the complete query and fragment; signed media URLs are never logged. */
export function redactUrl(value: string | URL): string {
  try {
    const url = value instanceof URL ? new URL(value.href) : new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[INVALID_URL]";
  }
}

/**
 * Produces bounded log metadata. Secret-shaped fields are removed by name,
 * URL queries are stripped, Error messages/stacks are never copied, and cycles
 * are represented without traversing indefinitely.
 */
export function redactForLog(
  value: unknown,
  options: { readonly maxDepth?: number; readonly maxEntries?: number } = {},
): RedactedValue {
  const maxDepth = options.maxDepth ?? 8;
  const maxEntries = options.maxEntries ?? 512;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 32) {
    throw new TypeError("maxDepth must be an integer from 0 through 32");
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) {
    throw new TypeError("maxEntries must be an integer from 1 through 10000");
  }

  const seen = new WeakSet<object>();
  const budget = { remaining: maxEntries };
  return redactNode(value, 0, maxDepth, budget, seen);
}

function redactNode(
  value: unknown,
  depth: number,
  maxDepth: number,
  budget: { remaining: number },
  seen: WeakSet<object>,
): RedactedValue {
  if (budget.remaining <= 0) {
    return "[TRUNCATED]";
  }
  budget.remaining -= 1;

  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "string") {
    return redactPotentialUrl(value);
  }
  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return String(value);
  }
  if (value instanceof Error) {
    return {
      name: safeErrorName(value.name),
      message: REDACTED,
    };
  }
  if (value instanceof URL) {
    return redactUrl(value);
  }
  if (depth >= maxDepth) {
    return "[MAX_DEPTH]";
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) =>
      redactNode(item, depth + 1, maxDepth, budget, seen),
    );
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, RedactedValue> = {};
  for (const key of Object.keys(record).sort()) {
    if (budget.remaining <= 0) {
      defineEnumerableOwnProperty(result, "__truncated__", true);
      break;
    }
    defineEnumerableOwnProperty(result, key, isSensitiveField(key)
      ? REDACTED
      : key.toLowerCase() === "headers" && isPlainRecord(record[key])
        ? redactNode(
            redactHeaders(record[key] as HeaderRecord),
            depth + 1,
            maxDepth,
            budget,
            seen,
          )
        : redactNode(record[key], depth + 1, maxDepth, budget, seen));
  }
  return result;
}

function redactPotentialUrl(value: string): string {
  return /^https?:\/\//iu.test(value) ? redactUrl(value) : value;
}

function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELD.test(key) || SENSITIVE_HEADERS.has(key.toLowerCase());
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorName(value: string): string {
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value) ? value : "Error";
}

/** Avoids the legacy `__proto__` setter while retaining ordinary-object output. */
function defineEnumerableOwnProperty<T>(
  target: Record<string, T>,
  key: string,
  value: T,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
