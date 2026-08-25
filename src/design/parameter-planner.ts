import { DesignError } from "./errors.js";
import type { DesignSchemaIR, JsonValue, UiField } from "./schema-ir.js";

export interface ExactParameterPatch {
  readonly set?: Readonly<Record<string, unknown>>;
  readonly unset?: readonly string[];
}

export interface NaturalLanguagePlan {
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly appliedPaths: readonly string[];
  readonly ignoredAssignments: readonly string[];
}

/** Materializes only schema-declared defaults/const values and required objects. */
export function materializeDefaults(
  schema: DesignSchemaIR,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const field of schema.fields) {
    const value = defaultForField(field);
    if (value !== undefined) {
      result[field.key] = value;
    }
  }
  return result;
}

/**
 * Applies exact RFC 6901 field paths. Unknown paths and invalid values fail
 * closed; no field names are synthesized from the patch.
 */
export function applyExactPatch(
  schema: DesignSchemaIR,
  current: Readonly<Record<string, JsonValue>>,
  patch: ExactParameterPatch,
): Record<string, JsonValue> {
  const result = cloneObject(current);
  const fields = indexFields(schema.fields);
  for (const [path, value] of Object.entries(patch.set ?? {})) {
    const field = fields.get(path);
    if (field === undefined || path.includes("/*")) {
      throw parameterError(`Unknown or non-addressable model field: ${path}`);
    }
    const parsed = toJsonValue(value, path);
    validateFieldValue(field, parsed, path);
    setPointer(result, path, cloneJson(parsed));
  }
  for (const path of patch.unset ?? []) {
    const field = fields.get(path);
    if (field === undefined || path.includes("/*")) {
      throw parameterError(`Unknown or non-addressable model field: ${path}`);
    }
    if (field.required && !field.hasDefault && !field.hasConst) {
      throw parameterError(`Required model field cannot be removed: ${path}`);
    }
    deletePointer(result, path);
    const replacement = defaultForField(field);
    if (replacement !== undefined) {
      setPointer(result, path, replacement);
    }
  }
  return result;
}

/**
 * Natural language is deliberately conservative: plain text updates only the
 * primary prompt, while other fields require an exact `field=value` or
 * `field: value` assignment separated by a newline or semicolon.
 */
export function applyNaturalLanguage(
  schema: DesignSchemaIR,
  current: Readonly<Record<string, JsonValue>>,
  instruction: string,
): NaturalLanguagePlan {
  if (instruction.length > 64 * 1024) {
    throw parameterError("Natural-language input exceeds 65536 characters");
  }
  const trimmed = instruction.trim();
  if (trimmed === "") {
    return { parameters: cloneObject(current), appliedPaths: [], ignoredAssignments: [] };
  }

  const addressable = [...indexFields(schema.fields).values()].filter(
    (field) => !field.path.includes("/*"),
  );
  const names = uniqueFieldNames(addressable);
  const segments = trimmed
    .split(/[;\n]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  const set: Record<string, unknown> = {};
  const ignoredAssignments: string[] = [];
  const promptSegments: string[] = [];
  let sawKnownAssignment = false;

  for (const segment of segments) {
    const match = /^([A-Za-z0-9_.\-/~ ]{1,128})\s*(?:=|:)\s*(.+)$/u.exec(segment);
    if (match === null) {
      promptSegments.push(segment);
      continue;
    }
    const name = match[1]?.trim().toLowerCase() ?? "";
    const rawValue = match[2]?.trim() ?? "";
    const field = names.get(name);
    if (field === undefined) {
      ignoredAssignments.push(segment.slice(0, 256));
      continue;
    }
    sawKnownAssignment = true;
    try {
      set[field.path] = parseExplicitValue(field, rawValue);
    } catch {
      ignoredAssignments.push(segment.slice(0, 256));
    }
  }

  const promptPath = schema.primaryPromptPath;
  if (promptPath !== null && !Object.hasOwn(set, promptPath)) {
    if (!sawKnownAssignment) {
      set[promptPath] = trimmed;
    } else if (promptSegments.length > 0) {
      set[promptPath] = promptSegments.join("; ");
    }
  }
  const parameters = applyExactPatch(schema, current, { set });
  return {
    parameters,
    appliedPaths: Object.keys(set),
    ignoredAssignments,
  };
}

/**
 * Builds the paid-call JSON body from schema defaults plus caller values and
 * verifies every required/nested field immediately before submission.
 */
export function buildInvocationBody(
  schema: DesignSchemaIR,
  values: Readonly<Record<string, unknown>> = {},
): Record<string, JsonValue> {
  if (!schema.supported) {
    throw parameterError("The model schema contains unsupported blocking constraints");
  }
  const result = materializeDefaults(schema);
  const rootFields = new Map(schema.fields.map((field) => [field.key, field]));
  for (const [key, rawValue] of Object.entries(values)) {
    const field = rootFields.get(key);
    if (field === undefined) {
      throw parameterError(`Unknown model field: ${key}`);
    }
    const value = toJsonValue(rawValue, field.path);
    validateFieldValue(field, value, field.path);
    result[key] = cloneJson(value);
  }
  for (const field of schema.fields) {
    if (!Object.hasOwn(result, field.key)) {
      if (field.required) {
        throw parameterError(`Required model field is missing: ${field.path}`);
      }
      continue;
    }
    const value = result[field.key];
    if (value !== undefined) {
      validateFieldValue(field, value, field.path);
    }
  }
  return result;
}

function defaultForField(field: UiField): JsonValue | undefined {
  if (field.hasConst && field.constValue !== undefined) {
    return cloneJson(field.constValue);
  }
  if (field.hasDefault && field.defaultValue !== undefined) {
    return cloneJson(field.defaultValue);
  }
  if (field.kind === "object") {
    const object: Record<string, JsonValue> = {};
    for (const child of field.properties) {
      const value = defaultForField(child);
      if (value !== undefined) {
        object[child.key] = value;
      }
    }
    if (field.required || Object.keys(object).length > 0) {
      return object;
    }
  }
  return undefined;
}

function validateFieldValue(field: UiField, value: JsonValue, path: string): void {
  if (value === null) {
    if (!field.nullable) {
      throw parameterError(`Model field is not nullable: ${path}`);
    }
    return;
  }
  if (field.hasConst && !sameJson(value, field.constValue)) {
    throw parameterError(`Model field must equal its const value: ${path}`);
  }
  if (
    field.enumValues.length > 0 &&
    !field.enumValues.some((candidate) => sameJson(value, candidate))
  ) {
    throw parameterError(`Model field is not one of its enum values: ${path}`);
  }

  switch (field.kind) {
    case "string":
    case "media":
      validateString(field, value, path);
      break;
    case "number":
      if (typeof value !== "number") {
        throw parameterError(`Model field must be a number: ${path}`);
      }
      validateNumber(field, value, path);
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw parameterError(`Model field must be an integer: ${path}`);
      }
      validateNumber(field, value, path);
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        throw parameterError(`Model field must be a boolean: ${path}`);
      }
      break;
    case "object":
      validateObject(field, value, path);
      break;
    case "array":
      validateArray(field, value, path);
      break;
    case "unknown":
      if (field.enumValues.length === 0 && !field.hasConst) {
        throw parameterError(`Model field has no safely editable type: ${path}`);
      }
      break;
  }
  validateVariants(field, value, path);
}

function validateString(field: UiField, value: JsonValue, path: string): void {
  if (typeof value !== "string") {
    throw parameterError(`Model field must be a string: ${path}`);
  }
  const { minLength, maxLength, pattern } = field.constraints;
  if (minLength !== null && value.length < minLength) {
    throw parameterError(`Model field is shorter than minLength: ${path}`);
  }
  if (maxLength !== null && value.length > maxLength) {
    throw parameterError(`Model field is longer than maxLength: ${path}`);
  }
  if (pattern !== null && !new RegExp(pattern, "u").test(value)) {
    throw parameterError(`Model field does not match pattern: ${path}`);
  }
}

function validateNumber(field: UiField, value: number, path: string): void {
  const constraints = field.constraints;
  if (constraints.minimum !== null && value < constraints.minimum) {
    throw parameterError(`Model field is below minimum: ${path}`);
  }
  if (constraints.maximum !== null && value > constraints.maximum) {
    throw parameterError(`Model field is above maximum: ${path}`);
  }
  if (constraints.exclusiveMinimum !== null && value <= constraints.exclusiveMinimum) {
    throw parameterError(`Model field is below exclusiveMinimum: ${path}`);
  }
  if (constraints.exclusiveMaximum !== null && value >= constraints.exclusiveMaximum) {
    throw parameterError(`Model field is above exclusiveMaximum: ${path}`);
  }
}

function validateObject(field: UiField, value: JsonValue, path: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw parameterError(`Model field must be an object: ${path}`);
  }
  const fields = new Map(field.properties.map((child) => [child.key, child]));
  for (const [key, item] of Object.entries(value)) {
    const child = fields.get(key);
    if (child === undefined) {
      throw parameterError(`Unknown nested model field: ${path}/${key}`);
    }
    validateFieldValue(child, item, `${path}/${key}`);
  }
  for (const child of field.properties) {
    if (child.required && !Object.hasOwn(value, child.key)) {
      throw parameterError(`Required nested model field is missing: ${child.path}`);
    }
  }
}

function validateArray(field: UiField, value: JsonValue, path: string): void {
  if (!Array.isArray(value)) {
    throw parameterError(`Model field must be an array: ${path}`);
  }
  const { minItems, maxItems } = field.constraints;
  if (minItems !== null && value.length < minItems) {
    throw parameterError(`Model field has fewer than minItems: ${path}`);
  }
  if (maxItems !== null && value.length > maxItems) {
    throw parameterError(`Model field has more than maxItems: ${path}`);
  }
  if (field.item !== null) {
    value.forEach((item, index) => validateFieldValue(field.item!, item, `${path}/${index}`));
  }
}

function validateVariants(field: UiField, value: JsonValue, path: string): void {
  const oneOf = field.variants.filter((variant) => variant.combinator === "oneOf");
  const anyOf = field.variants.filter((variant) => variant.combinator === "anyOf");
  if (oneOf.length > 0) {
    const matches = oneOf.filter((variant) => safelyValid(variant.field, value, path));
    if (matches.length !== 1) {
      throw parameterError(`Model field must match exactly one oneOf variant: ${path}`);
    }
  }
  if (anyOf.length > 0 && !anyOf.some((variant) => safelyValid(variant.field, value, path))) {
    throw parameterError(`Model field must match an anyOf variant: ${path}`);
  }
}

function safelyValid(field: UiField, value: JsonValue, path: string): boolean {
  try {
    validateFieldValue(field, value, path);
    return true;
  } catch {
    return false;
  }
}

function parseExplicitValue(field: UiField, raw: string): JsonValue {
  if (field.enumValues.length > 0) {
    const normalized = raw.toLowerCase();
    const match = field.enumValues.find(
      (value) =>
        (typeof value === "string" && value.toLowerCase() === normalized) ||
        String(value) === raw,
    );
    if (match !== undefined) {
      return cloneJson(match);
    }
  }
  let value: JsonValue;
  switch (field.kind) {
    case "string":
    case "media":
      value = raw;
      break;
    case "number":
    case "integer": {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(raw)) {
        throw parameterError(`Invalid numeric assignment for ${field.path}`);
      }
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) {
        throw parameterError(`Invalid numeric assignment for ${field.path}`);
      }
      value = numeric;
      break;
    }
    case "boolean": {
      const normalized = raw.toLowerCase();
      if (["true", "on", "yes"].includes(normalized)) {
        value = true;
      } else if (["false", "off", "no"].includes(normalized)) {
        value = false;
      } else {
        throw parameterError(`Invalid boolean assignment for ${field.path}`);
      }
      break;
    }
    case "object":
    case "array":
    case "unknown": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw parameterError(`Structured assignment must be JSON for ${field.path}`);
      }
      value = toJsonValue(parsed, field.path);
      break;
    }
  }
  validateFieldValue(field, value, field.path);
  return value;
}

function uniqueFieldNames(fields: readonly UiField[]): Map<string, UiField> {
  const candidates = new Map<string, UiField | null>();
  for (const field of fields) {
    for (const name of [field.key.toLowerCase(), field.path.toLowerCase()]) {
      candidates.set(name, candidates.has(name) ? null : field);
    }
  }
  return new Map(
    [...candidates.entries()].filter(
      (entry): entry is [string, UiField] => entry[1] !== null,
    ),
  );
}

function indexFields(fields: readonly UiField[]): Map<string, UiField> {
  const result = new Map<string, UiField>();
  const visit = (field: UiField): void => {
    result.set(field.path, field);
    field.properties.forEach(visit);
  };
  fields.forEach(visit);
  return result;
}

function setPointer(root: Record<string, JsonValue>, path: string, value: JsonValue): void {
  const tokens = pointerTokens(path);
  if (tokens.length === 0) {
    throw parameterError("The request body root cannot be replaced");
  }
  let current = root;
  for (const token of tokens.slice(0, -1)) {
    const next = current[token];
    if (next === undefined) {
      const created: Record<string, JsonValue> = {};
      current[token] = created;
      current = created;
      continue;
    }
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw parameterError(`Cannot address nested field through ${token}`);
    }
    current = next as Record<string, JsonValue>;
  }
  const finalToken = tokens.at(-1);
  if (finalToken === undefined) {
    throw parameterError("Invalid empty model field path");
  }
  current[finalToken] = value;
}

function deletePointer(root: Record<string, JsonValue>, path: string): void {
  const tokens = pointerTokens(path);
  let current: Record<string, JsonValue> = root;
  for (const token of tokens.slice(0, -1)) {
    const next = current[token];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return;
    }
    current = next as Record<string, JsonValue>;
  }
  const finalToken = tokens.at(-1);
  if (finalToken !== undefined) {
    delete current[finalToken];
  }
}

function pointerTokens(path: string): string[] {
  if (!path.startsWith("/") || path.includes("/*")) {
    throw parameterError(`Invalid model field path: ${path}`);
  }
  return path
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~(?:[^01]|$)/.test(token)) {
        throw parameterError(`Invalid JSON Pointer escape in ${path}`);
      }
      return token.replaceAll("~1", "/").replaceAll("~0", "~");
    });
}

function toJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toJsonValue(item, `${path}/${index}`));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = toJsonValue(item, `${path}/${key}`);
    }
    return result;
  }
  throw parameterError(`Model field is not JSON-compatible: ${path}`);
}

function cloneObject(
  value: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
  );
}

function cloneJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
    ) as T;
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function parameterError(message: string): DesignError {
  return new DesignError("PARAMETER_INVALID", message);
}
