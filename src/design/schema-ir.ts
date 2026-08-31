import { createHash } from "node:crypto";

import { inspectJsonBudget } from "../shared/json-budget.js";
import { DesignError } from "./errors.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type UiFieldKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "media"
  | "unknown";

export type UiMediaKind = "image" | "video" | "audio";

export interface UiConstraints {
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly exclusiveMinimum: number | null;
  readonly exclusiveMaximum: number | null;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  readonly minItems: number | null;
  readonly maxItems: number | null;
  readonly pattern: string | null;
}

export interface UiVariant {
  readonly combinator: "oneOf" | "anyOf";
  readonly title: string;
  readonly field: UiField;
}

export interface UiField {
  /** RFC 6901 pointer relative to the JSON request body. */
  readonly path: string;
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly kind: UiFieldKind;
  readonly required: boolean;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly defaultValue: JsonValue | undefined;
  readonly enumValues: readonly JsonValue[];
  readonly hasConst: boolean;
  readonly constValue: JsonValue | undefined;
  readonly constraints: UiConstraints;
  readonly mediaKind: UiMediaKind | null;
  readonly properties: readonly UiField[];
  readonly item: UiField | null;
  readonly variants: readonly UiVariant[];
}

export interface SchemaDiagnostic {
  readonly code:
    | "BODY_NOT_FOUND"
    | "MULTIPLE_POST_OPERATIONS"
    | "REF_INVALID"
    | "REF_NOT_FOUND"
    | "REF_CYCLE"
    | "BUDGET_EXCEEDED"
    | "SCHEMA_CONFLICT"
    | "UNSUPPORTED_KEYWORD"
    | "INVALID_KEYWORD";
  readonly path: string;
  readonly keyword: string | null;
  readonly blocking: boolean;
  readonly message: string;
}

export interface DesignSchemaIR {
  readonly version: 1;
  readonly method: "POST";
  readonly operationPath: string | null;
  readonly fields: readonly UiField[];
  readonly primaryPromptPath: string | null;
  readonly schemaHash: string;
  readonly diagnostics: readonly SchemaDiagnostic[];
  readonly supported: boolean;
}

export interface SchemaParserLimits {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxRefDepth?: number;
}

const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 24,
  maxNodes: 4_096,
  maxRefDepth: 64,
});

// Parsing walks the Schema graph more than once (cycle detection, reference
// expansion, then field compilation). Keeping this proportional to maxNodes
// allows ordinary schemas to complete while bounding compact shared-reference
// DAGs whose expanded walk would otherwise grow exponentially.
const MAX_TRAVERSAL_OPERATIONS_PER_NODE = 8;

const ANNOTATION_KEYS = new Set([
  "$id",
  "$schema",
  "$defs",
  "definitions",
  "title",
  "description",
  "examples",
  "example",
  "deprecated",
  "readOnly",
  "writeOnly",
  "format",
  "contentMediaType",
  "contentEncoding",
]);

const SUPPORTED_KEYS = new Set([
  "$ref",
  "type",
  "properties",
  "required",
  "items",
  "default",
  "enum",
  "const",
  "nullable",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "allOf",
  "oneOf",
  "anyOf",
  "additionalProperties",
]);

const BLOCKING_UNSUPPORTED_KEYS = new Set([
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "minContains",
  "maxContains",
  "uniqueItems",
  "propertyNames",
]);

/** Object keys with special JavaScript prototype semantics never enter the IR. */
const UNSAFE_PROPERTY_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

interface ParserContext {
  readonly document: Readonly<Record<string, unknown>>;
  readonly diagnostics: SchemaDiagnostic[];
  readonly limits: Required<SchemaParserLimits>;
  readonly blockedRefs: Set<string>;
  nodes: number;
  traversalOperations: number;
  traversalBudgetExceeded: boolean;
}

interface DiscoveredBody {
  readonly schema: Readonly<Record<string, unknown>>;
  readonly operationPath: string | null;
}

export function parseDesignSchema(
  input: unknown,
  limits: SchemaParserLimits = {},
): DesignSchemaIR {
  const document = asRecord(input);
  if (document === null) {
    throw new DesignError("SCHEMA_INVALID", "Schema input must be an object");
  }
  const normalizedLimits = normalizeLimits(limits);
  // The full OpenAPI wrapper receives a generous non-recursive safety bound;
  // the configured schema depth/node limits are applied to the discovered
  // request body below, so wrapper metadata does not consume model capacity.
  switch (inspectJsonBudget(document, {
    maxBytes: normalizedLimits.maxBytes,
    maxDepth: normalizedLimits.maxDepth + normalizedLimits.maxRefDepth,
    maxNodes: 100_000,
  })) {
    case "bytes":
      throw new DesignError(
        "SCHEMA_INVALID",
        `Schema input exceeds the ${normalizedLimits.maxBytes}-byte limit`,
      );
    case "depth":
      throw new DesignError(
        "SCHEMA_INVALID",
        "Schema document exceeds the structural depth safety limit",
      );
    case "nodes":
      throw new DesignError(
        "SCHEMA_INVALID",
        "Schema document exceeds the structural node safety limit",
      );
    case "cycle":
      throw new DesignError("SCHEMA_INVALID", "Schema input contains a cycle");
    case "non-json":
      throw new DesignError("SCHEMA_INVALID", "Schema input is not JSON-compatible");
    case null:
      break;
  }
  const diagnostics: SchemaDiagnostic[] = [];
  const discovered = discoverPostBody(document, diagnostics);
  if (discovered === null) {
    diagnostics.push({
      code: "BODY_NOT_FOUND",
      path: "#",
      keyword: null,
      blocking: true,
      message: "No JSON request body schema was found for POST",
    });
    return {
      version: 1,
      method: "POST",
      operationPath: null,
      fields: [],
      primaryPromptPath: null,
      schemaHash: sha256(stableStringify({})),
      diagnostics,
      supported: false,
    };
  }

  const context: ParserContext = {
    document,
    diagnostics,
    limits: normalizedLimits,
    blockedRefs: new Set(),
    nodes: 0,
    traversalOperations: 0,
    traversalBudgetExceeded: false,
  };
  switch (inspectJsonBudget(discovered.schema, normalizedLimits)) {
    case "depth":
      throw new DesignError(
        "SCHEMA_INVALID",
        `Schema input exceeds the ${normalizedLimits.maxDepth}-level depth limit`,
      );
    case "nodes":
      throw new DesignError(
        "SCHEMA_INVALID",
        `Schema input exceeds the ${normalizedLimits.maxNodes}-node limit`,
      );
    case "bytes":
      throw new DesignError(
        "SCHEMA_INVALID",
        `Schema input exceeds the ${normalizedLimits.maxBytes}-byte limit`,
      );
    case "cycle":
      throw new DesignError("SCHEMA_INVALID", "Schema input contains a cycle");
    case "non-json":
      throw new DesignError("SCHEMA_INVALID", "Schema input is not JSON-compatible");
    case null:
      break;
  }
  detectReferenceCycles(discovered.schema, "#", context, [], 0);
  const root = expandSchema(discovered.schema, "#", context, [], 0);
  const required = stringSet(root.required);
  const properties = asRecord(root.properties);
  let fields: UiField[];
  if (properties === null) {
    const rootField = compileField("body", "", root, true, context, 0);
    fields = rootField === null ? [] : [rootField];
  } else {
    fields = Object.entries(properties)
      .map(([key, schema], index) => {
        const object = asRecord(schema);
        return object === null
          ? invalidProperty(key, index, context)
          : compileField(
              key,
              `/${escapePointerToken(key)}`,
              object,
              required.has(key),
              context,
              1,
              index,
            );
      })
      .filter((field): field is UiField => field !== null);
    fields = sortFields(fields);
  }
  const primaryPromptPath = findPrimaryPrompt(fields);
  const expandedForHash = jsonCompatible(root) ?? {};
  return {
    version: 1,
    method: "POST",
    operationPath: discovered.operationPath,
    fields,
    primaryPromptPath,
    schemaHash: sha256(stableStringify(expandedForHash)),
    diagnostics,
    supported: !diagnostics.some((diagnostic) => diagnostic.blocking),
  };
}

function discoverPostBody(
  document: Readonly<Record<string, unknown>>,
  diagnostics: SchemaDiagnostic[],
): DiscoveredBody | null {
  const rootPost = asRecord(document.post);
  if (rootPost !== null) {
    const schema = requestBodySchema(rootPost);
    if (schema !== null) {
      return { schema, operationPath: null };
    }
    if (looksLikeJsonSchema(rootPost)) {
      return { schema: rootPost, operationPath: null };
    }
  }

  const paths = asRecord(document.paths);
  if (paths !== null) {
    const candidates: DiscoveredBody[] = [];
    for (const path of Object.keys(paths).sort()) {
      const pathItem = asRecord(paths[path]);
      const post = asRecord(pathItem?.post);
      if (post === null) {
        continue;
      }
      const schema = requestBodySchema(post);
      if (schema !== null) {
        candidates.push({ schema, operationPath: path });
      }
    }
    if (candidates.length > 1) {
      diagnostics.push({
        code: "MULTIPLE_POST_OPERATIONS",
        path: "#/paths",
        keyword: "post",
        blocking: true,
        message: "Multiple POST bodies were found; Design cannot safely select a submission operation",
      });
    }
    if (candidates[0] !== undefined) {
      return candidates[0];
    }
  }

  const direct = requestBodySchema(document);
  if (direct !== null) {
    return { schema: direct, operationPath: null };
  }
  if (looksLikeJsonSchema(document)) {
    return { schema: document, operationPath: null };
  }
  return null;
}

function requestBodySchema(
  operation: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  const requestBody = asRecord(operation.requestBody);
  const content = asRecord(requestBody?.content);
  const media =
    asRecord(content?.["application/json"]) ??
    asRecord(content?.["application/*+json"]);
  return asRecord(media?.schema);
}

function looksLikeJsonSchema(value: Readonly<Record<string, unknown>>): boolean {
  return [
    "$ref",
    "type",
    "properties",
    "items",
    "allOf",
    "oneOf",
    "anyOf",
    "enum",
    "const",
  ].some((key) => key in value);
}

function compileField(
  key: string,
  path: string,
  rawSchema: Readonly<Record<string, unknown>>,
  required: boolean,
  context: ParserContext,
  depth: number,
  _sourceIndex = 0,
): UiField | null {
  if (UNSAFE_PROPERTY_NAMES.has(key)) {
    context.diagnostics.push({
      code: "INVALID_KEYWORD",
      path: `#${path}`,
      keyword: "properties",
      blocking: true,
      message: "Schema property name is unsafe for a model parameter object",
    });
    return null;
  }
  if (depth > context.limits.maxDepth) {
    addBudgetDiagnostic(path, "maximum schema depth", context);
    return null;
  }
  context.nodes += 1;
  if (context.nodes > context.limits.maxNodes) {
    addBudgetDiagnostic(path, "maximum schema node count", context);
    return null;
  }

  const schema = expandSchema(rawSchema, `#${path}`, context, [], depth);
  reportUnsupportedKeywords(schema, path, context);
  const nullable = schema.nullable === true || schemaTypes(schema).includes("null");
  const kind = inferKind(schema, key);
  const nestedProperties = asRecord(schema.properties);
  const nestedRequired = stringSet(schema.required);
  const properties =
    nestedProperties === null
      ? []
      : sortFields(
          Object.entries(nestedProperties)
            .map(([childKey, childSchema], index) => {
              const object = asRecord(childSchema);
              if (object === null) {
                return invalidProperty(childKey, index, context, path);
              }
              return compileField(
                childKey,
                `${path}/${escapePointerToken(childKey)}`,
                object,
                nestedRequired.has(childKey),
                context,
                depth + 1,
                index,
              );
            })
            .filter((field): field is UiField => field !== null),
        );
  const itemSchema = asRecord(schema.items);
  const item =
    itemSchema === null
      ? null
      : compileField(
          "items",
          `${path}/*`,
          itemSchema,
          false,
          context,
          depth + 1,
        );
  const variants = compileVariants(
    key,
    path,
    schema,
    required,
    context,
    depth,
  );
  const defaultValue = jsonCompatible(schema.default);
  const constValue = jsonCompatible(schema.const);
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum
        .map(jsonCompatible)
        .filter((value): value is JsonValue => value !== undefined)
    : [];

  return {
    path,
    key,
    title: boundedText(schema.title) ?? humanize(key),
    description: boundedText(schema.description),
    kind,
    required,
    nullable,
    hasDefault: Object.hasOwn(schema, "default") && defaultValue !== undefined,
    defaultValue,
    enumValues,
    hasConst: Object.hasOwn(schema, "const") && constValue !== undefined,
    constValue,
    constraints: readConstraints(schema, path, context),
    mediaKind: detectMediaKind(schema),
    properties,
    item,
    variants,
  };
}

function compileVariants(
  key: string,
  path: string,
  schema: Readonly<Record<string, unknown>>,
  required: boolean,
  context: ParserContext,
  depth: number,
): UiVariant[] {
  const variants: UiVariant[] = [];
  for (const combinator of ["oneOf", "anyOf"] as const) {
    const candidates = schema[combinator];
    if (!Array.isArray(candidates)) {
      continue;
    }
    candidates.forEach((candidate, index) => {
      const branch = asRecord(candidate);
      if (branch === null) {
        context.diagnostics.push({
          code: "INVALID_KEYWORD",
          path: `#${path}/${combinator}/${index}`,
          keyword: combinator,
          blocking: true,
          message: `${combinator} entries must be schema objects`,
        });
        return;
      }
      const common = omitKeys(schema, ["oneOf", "anyOf"]);
      const merged = mergeSchemas(common, branch, `#${path}`, context);
      const field = compileField(
        key,
        path,
        merged,
        required,
        context,
        depth + 1,
      );
      if (field !== null) {
        variants.push({
          combinator,
          title: boundedText(branch.title) ?? `${humanize(key)} ${index + 1}`,
          field,
        });
      }
    });
  }
  return variants;
}

function expandSchema(
  rawSchema: Readonly<Record<string, unknown>>,
  path: string,
  context: ParserContext,
  refStack: readonly string[],
  depth: number,
): Readonly<Record<string, unknown>> {
  if (!consumeTraversalOperation(path, context)) {
    return {};
  }
  if (depth > context.limits.maxDepth) {
    addBudgetDiagnostic(path, "maximum schema depth", context);
    return {};
  }
  let schema = rawSchema;
  if (typeof schema.$ref === "string") {
    const reference = schema.$ref;
    if (!reference.startsWith("#")) {
      context.diagnostics.push({
        code: "REF_INVALID",
        path,
        keyword: "$ref",
        blocking: true,
        message: "Only same-document JSON Pointer references are supported",
      });
      return omitKeys(schema, ["$ref"]);
    }
    if (context.blockedRefs.has(reference)) {
      return omitKeys(schema, ["$ref"]);
    }
    if (refStack.includes(reference)) {
      context.diagnostics.push({
        code: "REF_CYCLE",
        path,
        keyword: "$ref",
        blocking: true,
        message: "A cyclic schema reference was stopped",
      });
      return omitKeys(schema, ["$ref"]);
    }
    if (refStack.length >= context.limits.maxRefDepth) {
      addBudgetDiagnostic(path, "maximum reference depth", context);
      return omitKeys(schema, ["$ref"]);
    }
    const target = resolvePointer(context.document, reference);
    if (target === null) {
      context.diagnostics.push({
        code: "REF_NOT_FOUND",
        path,
        keyword: "$ref",
        blocking: true,
        message: "A local schema reference could not be resolved",
      });
      return omitKeys(schema, ["$ref"]);
    }
    const expandedTarget = expandSchema(
      target,
      reference,
      context,
      [...refStack, reference],
      depth + 1,
    );
    schema = mergeSchemas(
      expandedTarget,
      omitKeys(schema, ["$ref"]),
      path,
      context,
    );
  }

  if (Array.isArray(schema.allOf)) {
    let merged = omitKeys(schema, ["allOf"]);
    schema.allOf.forEach((candidate, index) => {
      const branch = asRecord(candidate);
      if (branch === null) {
        context.diagnostics.push({
          code: "INVALID_KEYWORD",
          path: `${path}/allOf/${index}`,
          keyword: "allOf",
          blocking: true,
          message: "allOf entries must be schema objects",
        });
        return;
      }
      merged = mergeSchemas(
        merged,
        expandSchema(branch, `${path}/allOf/${index}`, context, refStack, depth + 1),
        path,
        context,
      );
    });
    schema = merged;
  }
  return schema;
}

function detectReferenceCycles(
  schema: Readonly<Record<string, unknown>>,
  path: string,
  context: ParserContext,
  refStack: readonly string[],
  depth: number,
): void {
  if (!consumeTraversalOperation(path, context)) {
    return;
  }
  if (depth > context.limits.maxDepth + context.limits.maxRefDepth) {
    return;
  }
  const reference = typeof schema.$ref === "string" ? schema.$ref : null;
  if (reference !== null && reference.startsWith("#")) {
    if (refStack.includes(reference)) {
      context.blockedRefs.add(reference);
      context.diagnostics.push({
        code: "REF_CYCLE",
        path,
        keyword: "$ref",
        blocking: true,
        message: "A cyclic schema reference was stopped",
      });
      return;
    }
    if (refStack.length < context.limits.maxRefDepth) {
      const target = resolvePointer(context.document, reference);
      if (target !== null) {
        detectReferenceCycles(
          target,
          reference,
          context,
          [...refStack, reference],
          depth + 1,
        );
      }
    }
  }
  const properties = asRecord(schema.properties);
  for (const [key, value] of Object.entries(properties ?? {})) {
    const child = asRecord(value);
    if (child !== null) {
      detectReferenceCycles(
        child,
        `${path}/properties/${escapePointerToken(key)}`,
        context,
        refStack,
        depth + 1,
      );
    }
  }
  const item = asRecord(schema.items);
  if (item !== null) {
    detectReferenceCycles(item, `${path}/items`, context, refStack, depth + 1);
  }
  for (const combinator of ["allOf", "oneOf", "anyOf"] as const) {
    const candidates = schema[combinator];
    if (!Array.isArray(candidates)) {
      continue;
    }
    candidates.forEach((candidate, index) => {
      const child = asRecord(candidate);
      if (child !== null) {
        detectReferenceCycles(
          child,
          `${path}/${combinator}/${index}`,
          context,
          refStack,
          depth + 1,
        );
      }
    });
  }
}

function consumeTraversalOperation(path: string, context: ParserContext): boolean {
  if (context.traversalBudgetExceeded) return false;
  context.traversalOperations += 1;
  const maximum = context.limits.maxNodes * MAX_TRAVERSAL_OPERATIONS_PER_NODE;
  if (context.traversalOperations <= maximum) return true;
  context.traversalBudgetExceeded = true;
  addBudgetDiagnostic(path, "maximum schema traversal operation count", context);
  return false;
}

function mergeSchemas(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  path: string,
  context: ParserContext,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = { ...left, ...right };
  const leftProperties = asRecord(left.properties);
  const rightProperties = asRecord(right.properties);
  if (leftProperties !== null || rightProperties !== null) {
    const properties = Object.assign(
      Object.create(null) as Record<string, unknown>,
      leftProperties ?? {},
    );
    for (const [key, value] of Object.entries(rightProperties ?? {})) {
      const existing = asRecord(properties[key]);
      const incoming = asRecord(value);
      properties[key] =
        existing !== null && incoming !== null
          ? { allOf: [existing, incoming] }
          : value;
    }
    result.properties = properties;
  }

  const required = new Set([...stringSet(left.required), ...stringSet(right.required)]);
  if (required.size > 0) {
    result.required = [...required];
  }
  const leftEnum = jsonArray(left.enum);
  const rightEnum = jsonArray(right.enum);
  if (leftEnum !== null && rightEnum !== null) {
    result.enum = leftEnum.filter((value) =>
      rightEnum.some((candidate) => stableStringify(candidate) === stableStringify(value)),
    );
    if ((result.enum as readonly unknown[]).length === 0) {
      addConflict(path, "enum", context);
    }
  }

  const leftTypes = schemaTypes(left);
  const rightTypes = schemaTypes(right);
  if (leftTypes.length > 0 && rightTypes.length > 0) {
    const intersection = leftTypes.filter((type) => rightTypes.includes(type));
    if (intersection.length === 0) {
      addConflict(path, "type", context);
    } else {
      result.type = intersection.length === 1 ? intersection[0] : intersection;
    }
  }

  mergeLowerBound(result, left, right, "minimum");
  mergeLowerBound(result, left, right, "exclusiveMinimum");
  mergeLowerBound(result, left, right, "minLength");
  mergeLowerBound(result, left, right, "minItems");
  mergeUpperBound(result, left, right, "maximum");
  mergeUpperBound(result, left, right, "exclusiveMaximum");
  mergeUpperBound(result, left, right, "maxLength");
  mergeUpperBound(result, left, right, "maxItems");
  for (const key of ["default", "const"] as const) {
    if (
      Object.hasOwn(left, key) &&
      Object.hasOwn(right, key) &&
      stableStringify(left[key]) !== stableStringify(right[key])
    ) {
      addConflict(path, key, context);
    }
  }
  const minimum = numberValue(result.minimum);
  const maximum = numberValue(result.maximum);
  if (minimum !== null && maximum !== null && minimum > maximum) {
    addConflict(path, "minimum/maximum", context);
  }
  return result;
}

function resolvePointer(
  root: Readonly<Record<string, unknown>>,
  reference: string,
): Readonly<Record<string, unknown>> | null {
  if (reference === "#") {
    return root;
  }
  if (!reference.startsWith("#/")) {
    return null;
  }
  let current: unknown = root;
  for (const encoded of reference.slice(2).split("/")) {
    const token = decodePointerToken(encoded);
    if (token === null) {
      return null;
    }
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) {
        return null;
      }
      current = current[Number(token)];
    } else {
      const object = asRecord(current);
      if (object === null || !Object.hasOwn(object, token)) {
        return null;
      }
      current = object[token];
    }
  }
  return asRecord(current);
}

function decodePointerToken(value: string): string | null {
  if (/~(?:[^01]|$)/.test(value)) {
    return null;
  }
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function escapePointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function reportUnsupportedKeywords(
  schema: Readonly<Record<string, unknown>>,
  path: string,
  context: ParserContext,
): void {
  for (const key of Object.keys(schema)) {
    if (
      SUPPORTED_KEYS.has(key) ||
      ANNOTATION_KEYS.has(key) ||
      key.startsWith("x-")
    ) {
      continue;
    }
    // Unknown JSON Schema assertions/applicators fail closed. Only known
    // annotations and explicitly versioned vendor hints are non-blocking.
    const blocking = BLOCKING_UNSUPPORTED_KEYS.has(key) || !ANNOTATION_KEYS.has(key);
    context.diagnostics.push({
      code: "UNSUPPORTED_KEYWORD",
      path: `#${path}`,
      keyword: key,
      blocking,
      message: blocking
        ? `The ${key} constraint cannot be enforced by the Design form`
        : `The ${key} keyword is preserved as an unsupported hint`,
    });
  }
  if (
    schema.additionalProperties === true ||
    (schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== "boolean")
  ) {
    context.diagnostics.push({
      code: "UNSUPPORTED_KEYWORD",
      path: `#${path}`,
      keyword: "additionalProperties",
      blocking: true,
      message: "Schema-valued additionalProperties cannot be edited safely",
    });
  }
}

function inferKind(schema: Readonly<Record<string, unknown>>, key: string): UiFieldKind {
  if (detectMediaKind(schema) !== null) {
    return "media";
  }
  const types = schemaTypes(schema).filter((type) => type !== "null");
  const type = types[0];
  if (
    type === "string" ||
    type === "number" ||
    type === "integer" ||
    type === "boolean" ||
    type === "object" ||
    type === "array"
  ) {
    return type;
  }
  if (asRecord(schema.properties) !== null) {
    return "object";
  }
  if (asRecord(schema.items) !== null) {
    return "array";
  }
  // Some Modellix schemas omit `type` for a scalar field while still
  // publishing a concrete default (for example, Grok Voice `voice_id`).
  // Treating that field as wholly unknown makes the authoritative default
  // impossible to submit. Inferring only scalar defaults is conservative: the
  // UI accepts a strict subset of the unconstrained JSON Schema value space,
  // while objects and arrays without their own schema remain fail-closed.
  if (Object.hasOwn(schema, "default")) {
    const defaultKind = scalarKind(schema.default);
    if (defaultKind !== null) {
      return defaultKind;
    }
  }
  if (/prompt/iu.test(key)) {
    return "string";
  }
  return "unknown";
}

function scalarKind(value: unknown): UiFieldKind | null {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return null;
}

function detectMediaKind(
  schema: Readonly<Record<string, unknown>>,
): UiMediaKind | null {
  const hints = [
    schema.contentMediaType,
    schema["x-media-type"],
    schema["x-modellix-media-type"],
    schema.format,
  ];
  for (const hint of hints) {
    if (typeof hint !== "string") {
      continue;
    }
    const normalized = hint.toLowerCase();
    if (normalized.startsWith("image/") || normalized === "image") {
      return "image";
    }
    if (normalized.startsWith("video/") || normalized === "video") {
      return "video";
    }
    if (normalized.startsWith("audio/") || normalized === "audio") {
      return "audio";
    }
  }
  return null;
}

function readConstraints(
  schema: Readonly<Record<string, unknown>>,
  path: string,
  context: ParserContext,
): UiConstraints {
  const pattern = safePattern(schema.pattern);
  if (schema.pattern !== undefined && pattern === null) {
    context.diagnostics.push({
      code: "INVALID_KEYWORD",
      path: `#${path}`,
      keyword: "pattern",
      blocking: true,
      message: "pattern must be a bounded string",
    });
  } else if (pattern !== null && !isSafeRegularExpression(pattern)) {
    context.diagnostics.push({
      code: "INVALID_KEYWORD",
      path: `#${path}`,
      keyword: "pattern",
      blocking: true,
      message: "pattern exceeds the supported regular-expression safety subset",
    });
  }
  return {
    minimum: numberValue(schema.minimum),
    maximum: numberValue(schema.maximum),
    exclusiveMinimum: numberValue(schema.exclusiveMinimum),
    exclusiveMaximum: numberValue(schema.exclusiveMaximum),
    minLength: nonNegativeInteger(schema.minLength),
    maxLength: nonNegativeInteger(schema.maxLength),
    minItems: nonNegativeInteger(schema.minItems),
    maxItems: nonNegativeInteger(schema.maxItems),
    pattern,
  };
}

function safePattern(value: unknown): string | null {
  return typeof value === "string" && value.length <= 512 ? value : null;
}

function isSafeRegularExpression(pattern: string): boolean {
  // Modellix image schemas publish dimensions as, for example,
  // `^\d+\*\d+$`. Both variable-width digit runs are separated by a
  // mandatory literal `*`, so this exact closed form is linear-time even
  // though the generic conservative subset below permits only one variable
  // quantifier.
  if (pattern === "^\\d+\\*\\d+$") {
    return true;
  }
  // JavaScript RegExp has no execution deadline. Accept only an anchored,
  // group-free subset with at most one variable quantifier so an untrusted
  // Schema cannot introduce catastrophic or high-polynomial backtracking.
  if (!pattern.startsWith("^") || !pattern.endsWith("$") || pattern.length < 2) {
    return false;
  }
  let index = 1;
  let variableQuantifiers = 0;
  const end = pattern.length - 1;
  while (index < end) {
    const character = pattern[index]!;
    if ("()|^$*+?{}".includes(character)) return false;
    if (character === "[") {
      index = characterClassEnd(pattern, index + 1, end);
      if (index < 0) return false;
    } else if (character === "\\") {
      const escaped = pattern[index + 1];
      if (
        escaped === undefined ||
        /[0-9ckpPux]/u.test(escaped)
      ) return false;
      index += 2;
    } else {
      index += 1;
    }

    const quantifier = pattern[index];
    if (quantifier === "*" || quantifier === "+" || quantifier === "?") {
      variableQuantifiers += 1;
      index += 1;
    } else if (quantifier === "{") {
      const close = pattern.indexOf("}", index + 1);
      if (close < 0 || close >= end) return false;
      const body = pattern.slice(index + 1, close);
      const match = /^(\d+)(?:,(\d*))?$/u.exec(body);
      if (match === null) return false;
      if (body.includes(",")) variableQuantifiers += 1;
      index = close + 1;
    }
    if (variableQuantifiers > 1) return false;
  }
  try {
    void new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

function characterClassEnd(pattern: string, start: number, end: number): number {
  let index = start;
  if (pattern[index] === "^") index += 1;
  while (index < end) {
    if (pattern[index] === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined || /[0-9ckpPux]/u.test(escaped)) return -1;
      index += 2;
      continue;
    }
    if (pattern[index] === "]") return index + 1;
    index += 1;
  }
  return -1;
}

function schemaTypes(schema: Readonly<Record<string, unknown>>): string[] {
  if (typeof schema.type === "string") {
    return [schema.type];
  }
  if (Array.isArray(schema.type)) {
    return schema.type.filter((value): value is string => typeof value === "string");
  }
  const constValue = schema.const;
  if (constValue !== undefined) {
    return [jsonType(constValue)];
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return [...new Set(schema.enum.map(jsonType))];
  }
  return [];
}

function jsonType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return "integer";
  }
  return typeof value;
}

function sortFields(fields: readonly UiField[]): UiField[] {
  return [...fields].sort((left, right) => {
    const leftPriority = primaryInputPriority(left) ?? Number.POSITIVE_INFINITY;
    const rightPriority = primaryInputPriority(right) ?? Number.POSITIVE_INFINITY;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    const requiredDelta = Number(right.required) - Number(left.required);
    return requiredDelta;
  });
}

function primaryInputPriority(field: UiField): number | null {
  if (field.kind !== "string") return null;
  const normalized = field.key.toLowerCase();
  if (normalized === "prompt" && !field.hasConst) return 0;
  // These fallbacks are accepted only as explicit, required, non-null text
  // inputs. This supports TTS/script generation without promoting arbitrary
  // strings (or optional ASR metadata) to the primary generation input.
  if (field.required && !field.nullable && !field.hasConst) {
    if (normalized === "text") return 1;
    if (normalized === "input_text") return 2;
    if (normalized === "script") return 3;
  }
  if (
    normalized.endsWith("_prompt") &&
    !field.hasConst &&
    !NON_PRIMARY_PROMPT_KEYS.has(normalized)
  ) return 4;
  return null;
}

const NON_PRIMARY_PROMPT_KEYS = new Set([
  "negative_prompt",
  "reference_prompt",
  "speaker_prompt",
  "system_prompt",
  "voice_prompt",
]);

function findPrimaryPrompt(fields: readonly UiField[]): string | null {
  let selectedPath: string | null = null;
  let selectedPriority = Number.POSITIVE_INFINITY;
  const visit = (field: UiField): void => {
    const priority = primaryInputPriority(field);
    if (priority !== null && priority < selectedPriority) {
      selectedPath = field.path;
      selectedPriority = priority;
    }
    field.properties.forEach(visit);
  };
  fields.forEach(visit);
  return selectedPath;
}

function invalidProperty(
  key: string,
  _index: number,
  context: ParserContext,
  parentPath = "",
): null {
  context.diagnostics.push({
    code: "INVALID_KEYWORD",
    path: `#${parentPath}/properties/${escapePointerToken(key)}`,
    keyword: "properties",
    blocking: true,
    message: "A property schema must be an object",
  });
  return null;
}

function addBudgetDiagnostic(
  path: string,
  budget: string,
  context: ParserContext,
): void {
  context.diagnostics.push({
    code: "BUDGET_EXCEEDED",
    path,
    keyword: null,
    blocking: true,
    message: `Schema parsing stopped at the ${budget}`,
  });
}

function addConflict(path: string, keyword: string, context: ParserContext): void {
  context.diagnostics.push({
    code: "SCHEMA_CONFLICT",
    path,
    keyword,
    blocking: true,
    message: `allOf contains incompatible ${keyword} constraints`,
  });
}

function normalizeLimits(limits: SchemaParserLimits): Required<SchemaParserLimits> {
  return {
    maxBytes: boundedLimit(limits.maxBytes ?? DEFAULT_LIMITS.maxBytes, 1_024, 16 * 1024 * 1024, "maxBytes"),
    maxDepth: boundedLimit(limits.maxDepth ?? DEFAULT_LIMITS.maxDepth, 1, 128, "maxDepth"),
    maxNodes: boundedLimit(limits.maxNodes ?? DEFAULT_LIMITS.maxNodes, 1, 100_000, "maxNodes"),
    maxRefDepth: boundedLimit(limits.maxRefDepth ?? DEFAULT_LIMITS.maxRefDepth, 1, 512, "maxRefDepth"),
  };
}

function boundedLimit(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new DesignError(
      "INVALID_ARGUMENT",
      `${name} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

function mergeLowerBound(
  target: Record<string, unknown>,
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  key: string,
): void {
  const values = [numberValue(left[key]), numberValue(right[key])].filter(
    (value): value is number => value !== null,
  );
  if (values.length > 0) {
    target[key] = Math.max(...values);
  }
}

function mergeUpperBound(
  target: Record<string, unknown>,
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  key: string,
): void {
  const values = [numberValue(left[key]), numberValue(right[key])].filter(
    (value): value is number => value !== null,
  );
  if (values.length > 0) {
    target[key] = Math.min(...values);
  }
}

function omitKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keys.includes(key)) {
      result[key] = item;
    }
  }
  return result;
}

function stringSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [],
  );
}

function jsonArray(value: unknown): readonly JsonValue[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const result = value
    .map(jsonCompatible)
    .filter((item): item is JsonValue => item !== undefined);
  return result.length === value.length ? result : null;
}

function jsonCompatible(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map(jsonCompatible);
    return items.every((item) => item !== undefined)
      ? (items as readonly JsonValue[])
      : undefined;
  }
  const object = asRecord(value);
  if (object === null) {
    return undefined;
  }
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const [key, item] of Object.entries(object)) {
    const parsed = jsonCompatible(item);
    if (parsed === undefined) {
      return undefined;
    }
    result[key] = parsed;
  }
  return result;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  const object = asRecord(value);
  if (object === null) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return value;
    }
    throw new TypeError("Value is not JSON-compatible");
  }
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, sortJson(object[key])]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= 16_384
    ? value.trim()
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function humanize(value: string): string {
  const result = value.replaceAll(/[_-]+/g, " ").trim();
  return result === ""
    ? "Value"
    : `${result[0]?.toUpperCase() ?? ""}${result.slice(1)}`;
}
