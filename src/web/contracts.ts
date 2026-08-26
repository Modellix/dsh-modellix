import type {
  WebFetchResult,
  WebSearchResult,
  WebSearchSource,
} from "@deepseek-ai/dsh-web";

import { isPublicHostname } from "../core/http.js";

export const MODELLIX_WEB_SEARCH_ENDPOINT =
  "https://tool.modellix.ai/v1/web-search" as const;
export const MODELLIX_WEB_FETCH_ENDPOINT =
  "https://tool.modellix.ai/v1/web-fetch" as const;

export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;
export const MAX_WEB_SEARCH_RESULTS = 20;
export const MAX_WEB_QUERY_CHARS = 32_000;
export const MAX_WEB_URL_CHARS = 8_192;
export const DEFAULT_WEB_RESPONSE_BYTES = 2 * 1024 * 1024;

const MAX_TITLE_CHARS = 4_096;
const MAX_SEARCH_TEXT_CHARS = 128 * 1024;
const MAX_ANSWER_CHARS = 128 * 1024;
const MAX_WARNING_COUNT = 64;
const MAX_WARNING_CHARS = 4_096;
const MAX_FAILURE_REASON_CHARS = 16 * 1024;
const MAX_REQUEST_ID_CHARS = 256;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export class ModellixWebContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModellixWebContractError";
  }
}

export interface ParsedSearchResponse {
  readonly result: WebSearchResult;
  readonly requestId: string;
}

export interface ParsedFetchSuccess {
  readonly kind: "success";
  readonly result: WebFetchResult;
  readonly requestId: string;
}

export interface ParsedFetchFailure {
  readonly kind: "failure";
  readonly requestId: string;
}

export type ParsedFetchResponse = ParsedFetchSuccess | ParsedFetchFailure;

export function buildSearchRequest(
  query: string,
  maxResults: number | undefined,
): {
  readonly query: string;
  readonly depth: "standard";
  readonly max_results: number;
} {
  assertReadableString(query, "query", MAX_WEB_QUERY_CHARS);
  if (query.trim().length === 0) {
    throw new ModellixWebContractError("query must contain non-whitespace text");
  }

  const resultLimit = maxResults ?? DEFAULT_WEB_SEARCH_MAX_RESULTS;
  if (
    !Number.isInteger(resultLimit) ||
    resultLimit < 1 ||
    resultLimit > MAX_WEB_SEARCH_RESULTS
  ) {
    throw new ModellixWebContractError(
      `maxResults must be an integer from 1 through ${MAX_WEB_SEARCH_RESULTS}`,
    );
  }

  return {
    query,
    depth: "standard",
    max_results: resultLimit,
  };
}

export function buildFetchRequest(url: string): { readonly urls: readonly [string] } {
  return { urls: [validatePublicHttpUrl(url, "url")] };
}

export function parseSearchResponse(
  input: string,
  maxResults: number,
): ParsedSearchResponse {
  const root = parseJsonObject(input, "Web Search response");
  assertReadableString(root.query, "query", MAX_WEB_QUERY_CHARS);
  if (root.depth !== "standard") {
    throw new ModellixWebContractError(
      "Web Search response depth does not match the requested depth",
    );
  }

  const answer = nullableReadableString(root.answer, "answer", MAX_ANSWER_CHARS);
  const rawResults = requiredArray(root.results, "results", MAX_WEB_SEARCH_RESULTS);
  const warnings = requiredArray(root.warnings, "warnings", MAX_WARNING_COUNT);
  for (const warning of warnings) {
    assertReadableString(warning, "warning", MAX_WARNING_CHARS);
  }
  validateSearchBilling(root.billing);
  const requestId = validateRequestId(root.request_id);

  const sources = rawResults.map(parseSearchSource);
  const truncated = sources.length > maxResults;
  const result: WebSearchResult = {
    ...(answer !== null && answer.length > 0 ? { content: answer } : {}),
    sources: truncated ? sources.slice(0, maxResults) : sources,
    truncated,
  };
  return { result, requestId };
}

export function parseFetchResponse(input: string): ParsedFetchResponse {
  const root = parseJsonObject(input, "Web Fetch response");
  const results = requiredArray(root.results, "results", MAX_WEB_SEARCH_RESULTS);
  const failures = requiredArray(
    root.failed_results,
    "failed_results",
    MAX_WEB_SEARCH_RESULTS,
  );
  const requestId = validateRequestId(root.request_id);
  const successCount = validateFetchBilling(root.billing);

  if (results.length + failures.length !== 1) {
    throw new ModellixWebContractError(
      "Single-URL Web Fetch must return exactly one URL-level outcome",
    );
  }
  if (successCount !== results.length) {
    throw new ModellixWebContractError(
      "Web Fetch billing success_count disagrees with the result envelope",
    );
  }

  if (failures.length === 1) {
    validateFetchFailure(failures[0]);
    return { kind: "failure", requestId };
  }

  const result = requiredObject(results[0], "result");
  const url = validatePublicHttpUrl(requiredString(result.url, "result.url"), "result.url");
  nullableReadableString(result.title, "result.title", MAX_TITLE_CHARS);
  const content = requiredReadableString(
    result.content,
    "result.content",
    DEFAULT_WEB_RESPONSE_BYTES,
  );

  return {
    kind: "success",
    requestId,
    result: {
      url,
      // Modellix's batch envelope calls entries in `results` successful but
      // does not expose per-page HTTP status or a truncation flag. Harness
      // requires both fields, so this adapter uses 200 for that provider-level
      // success and false because the plugin did not trim `content`. Entries
      // in `failed_results` take the failure path above and are never disguised
      // as successful fetches.
      statusCode: 200,
      body: { kind: "text", content },
      truncated: false,
    },
  };
}

function parseSearchSource(value: unknown): WebSearchSource {
  const item = requiredObject(value, "result");
  const title = requiredReadableString(item.title, "result.title", MAX_TITLE_CHARS);
  const url = validatePublicHttpUrl(requiredString(item.url, "result.url"), "result.url");
  const content = requiredReadableString(
    item.content,
    "result.content",
    MAX_SEARCH_TEXT_CHARS,
  );
  const summary = nullableReadableString(
    item.summary,
    "result.summary",
    MAX_SEARCH_TEXT_CHARS,
  );
  const score = item.score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new ModellixWebContractError("result.score must be a finite number");
  }
  const publishedAt = nullableReadableString(
    item.published_at,
    "result.published_at",
    MAX_TITLE_CHARS,
  );
  nullableReadableString(item.favicon, "result.favicon", MAX_WEB_URL_CHARS);

  const snippet = summary !== null && summary.length > 0 ? summary : content;
  return {
    url,
    ...(title.length > 0 ? { title } : {}),
    ...(snippet.length > 0 ? { snippet } : {}),
    ...(publishedAt !== null && publishedAt.length > 0
      ? { publishedAt }
      : {}),
  };
}

function validateSearchBilling(value: unknown): void {
  const billing = requiredObject(value, "billing");
  if (billing.sku !== "web-search.standard") {
    throw new ModellixWebContractError(
      "Web Search billing sku does not match standard depth",
    );
  }
  assertNonNegativeFiniteNumber(billing.amount_usd, "billing.amount_usd");
}

function validateFetchBilling(value: unknown): number {
  const billing = requiredObject(value, "billing");
  if (billing.sku !== "web-fetch") {
    throw new ModellixWebContractError("Web Fetch billing sku is invalid");
  }
  if (
    typeof billing.success_count !== "number" ||
    !Number.isInteger(billing.success_count) ||
    billing.success_count < 0 ||
    billing.success_count > MAX_WEB_SEARCH_RESULTS
  ) {
    throw new ModellixWebContractError(
      "billing.success_count must be a bounded non-negative integer",
    );
  }
  assertNonNegativeFiniteNumber(billing.amount_usd, "billing.amount_usd");
  return billing.success_count;
}

function validateFetchFailure(value: unknown): void {
  const failure = requiredObject(value, "failed_result");
  validatePublicHttpUrl(
    requiredString(failure.url, "failed_result.url"),
    "failed_result.url",
  );
  requiredReadableString(
    failure.error,
    "failed_result.error",
    MAX_FAILURE_REASON_CHARS,
  );
}

function parseJsonObject(input: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new ModellixWebContractError(`${label} is not valid JSON`);
  }
  return requiredObject(parsed, label);
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModellixWebContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(
  value: unknown,
  label: string,
  maximumItems: number,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new ModellixWebContractError(
      `${label} must be an array with at most ${maximumItems} items`,
    );
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ModellixWebContractError(`${label} must be a string`);
  }
  return value;
}

function requiredReadableString(
  value: unknown,
  label: string,
  maximumChars: number,
): string {
  const text = requiredString(value, label);
  assertReadableString(text, label, maximumChars);
  return text;
}

function nullableReadableString(
  value: unknown,
  label: string,
  maximumChars: number,
): string | null {
  if (value === null) {
    return null;
  }
  return requiredReadableString(value, label, maximumChars);
}

function assertReadableString(
  value: unknown,
  label: string,
  maximumChars: number,
): asserts value is string {
  if (typeof value !== "string" || value.length > maximumChars) {
    throw new ModellixWebContractError(
      `${label} must be a string no longer than ${maximumChars} characters`,
    );
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 && character !== "\n" && character !== "\r" && character !== "\t") {
      throw new ModellixWebContractError(`${label} contains a control character`);
    }
    if (codePoint === 127) {
      throw new ModellixWebContractError(`${label} contains a control character`);
    }
  }
}

function assertNonNegativeFiniteNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ModellixWebContractError(
      `${label} must be a non-negative finite number`,
    );
  }
}

function validateRequestId(value: unknown): string {
  const requestId = requiredString(value, "request_id");
  if (
    requestId.length < 1 ||
    requestId.length > MAX_REQUEST_ID_CHARS ||
    !REQUEST_ID_PATTERN.test(requestId)
  ) {
    throw new ModellixWebContractError("request_id is malformed");
  }
  return requestId;
}

export function validatePublicHttpUrl(value: string, label: string): string {
  if (value.length < 1 || value.length > MAX_WEB_URL_CHARS || /\s/u.test(value)) {
    throw new ModellixWebContractError(`${label} is not a bounded public URL`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ModellixWebContractError(`${label} must be an absolute HTTP URL`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname.length === 0 ||
    !isPublicHostname(url.hostname)
  ) {
    throw new ModellixWebContractError(
      `${label} must be public HTTP(S) without user information`,
    );
  }
  return url.href;
}
