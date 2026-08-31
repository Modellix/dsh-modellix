import { DesignError } from "./errors.js";
import { readBoundedResponseJson, requestDeadline } from "../core/http.js";
import type { CachePort, ClockPort, FetchPort } from "./ports.js";
import { systemClock } from "./ports.js";

export const AUTHENTICATED_CATALOG_URL =
  "https://api.modellix.ai/api/v1/models";
export const PUBLIC_PORTAL_CATALOG_URL =
  "https://www.modellix.ai/portal/v1/models";

export type DesignMediaCategory = "image" | "video" | "audio";

export interface ModelCatalogQuery {
  readonly category: DesignMediaCategory;
  readonly page?: number;
  readonly pageSize?: number;
  readonly featured?: boolean;
}

interface NormalizedModelCatalogQuery {
  readonly category: DesignMediaCategory;
  readonly page: number;
  readonly pageSize: number;
  readonly featured: boolean;
}

export interface DesignModelSummary {
  readonly provider: string;
  readonly modelId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly categories: readonly DesignMediaCategory[];
  /** Live catalog routing capability, for example text-to-image or image-to-video. */
  readonly taskType?: string;
  readonly description?: string;
  readonly thumbnailUrl?: string;
}

export interface ModelCatalogPage {
  readonly items: readonly DesignModelSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number | null;
  readonly hasMore: boolean;
  readonly source: "authenticated-api" | "public-portal";
}

export interface ModelCatalogClientOptions {
  readonly fetch: FetchPort;
  /** Resolved for each uncached primary request so credential rotation is seen. */
  readonly getApiKey?: () => string | null | Promise<string | null>;
  /** Public no-credential fallback is disabled unless explicitly enabled. */
  readonly allowPublicPortalFallback?: boolean;
  readonly cache?: CachePort;
  readonly cacheTtlMs?: number;
  readonly clock?: ClockPort;
  readonly requestTimeoutMs?: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const MAX_CATALOG_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export class ModelCatalogClient {
  readonly #fetch: FetchPort;
  readonly #getApiKey: ModelCatalogClientOptions["getApiKey"];
  readonly #allowPublicPortalFallback: boolean;
  readonly #cache: CachePort | undefined;
  readonly #cacheTtlMs: number;
  readonly #clock: ClockPort;
  readonly #requestTimeoutMs: number;

  constructor(options: ModelCatalogClientOptions) {
    this.#fetch = options.fetch;
    this.#getApiKey = options.getApiKey;
    this.#allowPublicPortalFallback =
      options.allowPublicPortalFallback === true;
    this.#cache = options.cache;
    this.#cacheTtlMs = boundedPositiveInteger(
      options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      60 * 60_000,
      "cacheTtlMs",
    );
    this.#clock = options.clock ?? systemClock;
    this.#requestTimeoutMs = boundedPositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      10 * 60_000,
      "requestTimeoutMs",
    );
  }

  async list(query: ModelCatalogQuery, signal?: AbortSignal): Promise<ModelCatalogPage> {
    const normalized = normalizeQuery(query);
    const cacheKey = `design:catalog:v1:${normalized.category}:${normalized.page}:${normalized.pageSize}:${normalized.featured ? "featured" : "all"}`;
    const cached = await this.#cache?.read<ModelCatalogPage>(cacheKey);
    if (cached !== undefined && cached !== null && cached.expiresAt > this.#clock.now()) {
      return cached.value;
    }

    const apiKey = await this.#getApiKey?.();
    let page: ModelCatalogPage;
    if (typeof apiKey === "string" && apiKey.trim() !== "") {
      try {
        page = await this.#requestCatalog(
          AUTHENTICATED_CATALOG_URL,
          normalized,
          apiKey,
          "authenticated-api",
          signal,
        );
      } catch (caught) {
        if (signal?.aborted === true) throw caught;
        if (!this.#allowPublicPortalFallback) {
          throw caught;
        }
        page = await this.#requestCatalog(
          PUBLIC_PORTAL_CATALOG_URL,
          normalized,
          null,
          "public-portal",
          signal,
        );
      }
    } else if (this.#allowPublicPortalFallback) {
      page = await this.#requestCatalog(
        PUBLIC_PORTAL_CATALOG_URL,
        normalized,
        null,
        "public-portal",
        signal,
      );
    } else {
      throw new DesignError(
        "MISSING_API_KEY",
        "An API key is required for the authenticated model catalog",
      );
    }

    await this.#cache?.write(cacheKey, {
      value: page,
      expiresAt: this.#clock.now() + this.#cacheTtlMs,
    });
    return page;
  }

  async #requestCatalog(
    baseUrl: string,
    query: NormalizedModelCatalogQuery,
    apiKey: string | null,
    source: ModelCatalogPage["source"],
    signal?: AbortSignal,
  ): Promise<ModelCatalogPage> {
    const url = new URL(baseUrl);
    url.searchParams.set("category", query.category);
    url.searchParams.set("page", String(query.page));
    url.searchParams.set("page_size", String(query.pageSize));
    if (query.featured) url.searchParams.set("featured", "true");
    const headers = new Headers({ accept: "application/json" });
    if (apiKey !== null) {
      headers.set("authorization", `Bearer ${apiKey}`);
    }

    let response: Response;
    const deadline = requestDeadline(signal, this.#requestTimeoutMs);
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: deadline.signal,
      });
    } catch (cause) {
      if (signal?.aborted === true) throw cause;
      throw new DesignError(
        "CATALOG_UNAVAILABLE",
        deadline.timedOut()
          ? "The model catalog request timed out"
          : "The model catalog request failed",
        { cause, ...(deadline.timedOut() ? { status: 408 } : {}) },
      );
    }
    if (!response.ok) {
      throw new DesignError(
        "CATALOG_UNAVAILABLE",
        `The model catalog returned HTTP ${response.status}`,
        { status: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = await readBoundedResponseJson(
        response,
        MAX_CATALOG_RESPONSE_BYTES,
        deadline.signal,
      );
    } catch (cause) {
      if (signal?.aborted === true) throw cause;
      if (deadline.timedOut()) {
        throw new DesignError(
          "CATALOG_UNAVAILABLE",
          "The model catalog response timed out",
          { cause, status: 408 },
        );
      }
      throw new DesignError(
        "UNEXPECTED_RESPONSE",
        "The model catalog response is not bounded valid JSON",
        { cause },
      );
    }
    return parseCatalogPage(payload, query, source);
  }
}

export function parseCatalogPage(
  payload: unknown,
  query: Required<Pick<ModelCatalogQuery, "category" | "page" | "pageSize">>,
  source: ModelCatalogPage["source"],
): ModelCatalogPage {
  const envelope = record(payload);
  const data = record(envelope?.data) ?? envelope;
  const rawItems = Array.isArray(payload)
    ? payload
    : firstArray(data?.items, data?.models, data?.list, envelope?.items, envelope?.models);
  if (rawItems === null) {
    throw new DesignError(
      "UNEXPECTED_RESPONSE",
      "The model catalog response does not contain a model list",
    );
  }

  const items = rawItems
    .map((item) => parseModel(item, query.category))
    .filter((item): item is DesignModelSummary =>
      item !== null && item.categories.includes(query.category));
  const total = finiteNonNegativeInteger(
    data?.total ?? data?.total_count ?? envelope?.total,
  );
  const responsePage = positiveInteger(data?.page) ?? query.page;
  const responsePageSize =
    positiveInteger(data?.page_size ?? data?.pageSize ?? data?.limit) ??
    query.pageSize;
  const explicitHasMore = data?.has_more ?? data?.hasMore;
  const hasMore =
    typeof explicitHasMore === "boolean"
      ? explicitHasMore
      : total === null
        ? items.length === responsePageSize
        : responsePage * responsePageSize < total;

  return {
    items,
    page: responsePage,
    pageSize: responsePageSize,
    total,
    hasMore,
    source,
  };
}

function parseModel(
  value: unknown,
  requestedCategory: DesignMediaCategory,
): DesignModelSummary | null {
  const item = record(value);
  if (item === null) {
    return null;
  }

  const provider = identifier(
    item.provider ?? item.provider_id ?? record(item.provider_info)?.slug,
  );
  let modelId = identifier(item.model_id ?? item.modelId ?? item.id ?? item.name);
  const rawSlug = stringValue(item.slug ?? item.model);
  let slugProvider: string | null = null;
  if (rawSlug !== null) {
    const parts = rawSlug.split("/");
    if (parts.length === 2) {
      slugProvider = identifier(parts[0]);
      modelId ??= identifier(parts[1]);
    }
  }
  const resolvedProvider = provider ?? slugProvider;
  if (resolvedProvider === null || modelId === null) {
    return null;
  }

  const rawTaskType = item.task_type ?? item.taskType ?? item.type;
  const categories = parseCategories(
    item.categories ?? item.category ?? rawTaskType,
    requestedCategory,
  );
  const displayName =
    stringValue(item.display_name ?? item.displayName ?? item.title) ?? modelId;
  const description = stringValue(item.description ?? item.summary);
  const taskType = routingType(rawTaskType);
  const thumbnailUrl = safeHttpsUrl(
    item.thumbnail_url ?? item.thumbnailUrl ?? item.cover_url ?? item.cover,
  );

  return {
    provider: resolvedProvider,
    modelId,
    slug: `${resolvedProvider}/${modelId}`,
    displayName,
    categories,
    ...(taskType === null ? {} : { taskType }),
    ...(description === null ? {} : { description }),
    ...(thumbnailUrl === null ? {} : { thumbnailUrl }),
  };
}

function routingType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/u.test(normalized)
    ? normalized.slice(0, 64)
    : null;
}

function parseCategories(
  value: unknown,
  fallback: DesignMediaCategory,
): readonly DesignMediaCategory[] {
  if (value === undefined || value === null) {
    return [fallback];
  }
  const candidates = Array.isArray(value) ? value : [value];
  const result = new Set<DesignMediaCategory>();
  for (const candidate of candidates) {
    const category = mediaCategory(candidate);
    if (category !== null) result.add(category);
  }
  return [...result];
}

function mediaCategory(value: unknown): DesignMediaCategory | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "image":
    case "text-to-image":
    case "image-to-image":
      return "image";
    case "video":
    case "text-to-video":
    case "image-to-video":
    case "video-to-video":
      return "video";
    case "audio":
    case "speech":
    case "text-to-speech":
    case "speech-to-text":
    case "speech-to-speech":
      return "audio";
    default:
      return null;
  }
}

function normalizeQuery(query: ModelCatalogQuery): NormalizedModelCatalogQuery {
  if (query.category !== "image" && query.category !== "video" && query.category !== "audio") {
    throw new DesignError("INVALID_ARGUMENT", "category must be image, video, or audio");
  }
  return {
    category: query.category,
    page: boundedPositiveInteger(query.page ?? 1, MAX_PAGE, "page"),
    pageSize: boundedPositiveInteger(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
      "pageSize",
    ),
    featured: query.featured === true,
  };
}

function boundedPositiveInteger(value: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new DesignError(
      "INVALID_ARGUMENT",
      `${field} must be an integer from 1 through ${maximum}`,
    );
  }
  return value;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim().slice(0, 512)
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstArray(...values: readonly unknown[]): readonly unknown[] | null {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return null;
}
