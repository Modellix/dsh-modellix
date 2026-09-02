import type { Context } from "@deepseek-ai/cordis";
import {
  defineTool,
  type ToolDefinition,
  type ToolResult,
  type WebFetchResultView,
  type WebSearchResultView,
  type WebSource,
} from "@deepseek-ai/dsh-tools";
import type {
  WebFetchResult,
  WebSearchResult,
  WebSearchSource,
} from "@deepseek-ai/dsh-web";
import type { JsonValue } from "../shared/json-value.js";

import {
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  MAX_WEB_SEARCH_RESULTS,
  MODELLIX_WEB_FETCH_ENDPOINT,
  MODELLIX_WEB_SEARCH_ENDPOINT,
  type ModellixWebProviders,
} from "../web/index.js";

export const MODELLIX_WEB_SEARCH_TOOL = "modellix_web_search";
export const MODELLIX_WEB_FETCH_TOOL = "modellix_web_fetch";

const WEB_TOOL_TIMEOUT_MS = 30_000;
const MAX_FETCH_OUTPUT_CHARS = 200_000;

interface ModellixWebSearchToolResult {
  readonly version: 1;
  readonly service: "web";
  readonly provider: "modellix";
  readonly operation: "search";
  readonly endpoint: typeof MODELLIX_WEB_SEARCH_ENDPOINT;
  readonly query: string;
  readonly content?: string;
  readonly sources: WebSearchSource[];
  readonly truncated: boolean;
  readonly noAutomaticRetry: true;
}

interface ModellixWebFetchToolResult {
  readonly version: 1;
  readonly service: "web";
  readonly provider: "modellix";
  readonly operation: "fetch";
  readonly endpoint: typeof MODELLIX_WEB_FETCH_ENDPOINT;
  readonly requestedUrl: string;
  readonly url: string;
  readonly statusCode: number;
  readonly body: WebFetchResult["body"];
  readonly truncated: boolean;
  readonly noAutomaticRetry: true;
}

/** Build the two explicit Modellix Web tools over the concrete Modellix providers. */
export function createModellixWebToolDefinitions(
  providers: ModellixWebProviders,
): readonly ToolDefinition[] {
  return [
    createSearchTool(providers),
    createFetchTool(providers),
  ];
}

/** Register the explicit tools and roll back atomically if either name conflicts. */
export function registerModellixWebTools(
  ctx: Context,
  providers: ModellixWebProviders,
): () => void {
  const disposers: (() => unknown)[] = [];
  try {
    for (const definition of createModellixWebToolDefinitions(providers)) {
      disposers.push(ctx.tools.register(definition));
    }
  } catch (error) {
    disposeAll(disposers);
    throw error;
  }
  return () => disposeAll(disposers);
}

function createSearchTool(providers: ModellixWebProviders): ToolDefinition {
  return defineTool({
    name: MODELLIX_WEB_SEARCH_TOOL,
    description: "Search current public web information through the Modellix Web Search API. Use automatically when current or externally verified information is needed, even when the user did not name a tool. One invocation sends exactly one Modellix search request and never retries it automatically.",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "One non-empty web search query.",
      },
      max_results: {
        type: "integer",
        description: `Maximum sources to return (default ${String(DEFAULT_WEB_SEARCH_MAX_RESULTS)}, maximum ${String(MAX_WEB_SEARCH_RESULTS)}).`,
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: "integer", const: 1, required: true },
          service: { type: "string", const: "web", required: true },
          provider: { type: "string", const: "modellix", required: true },
          operation: { type: "string", const: "search", required: true },
          endpoint: {
            type: "string",
            const: MODELLIX_WEB_SEARCH_ENDPOINT,
            required: true,
          },
          query: { type: "string", required: true },
          content: { type: "string" },
          sources: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                url: { type: "string", required: true },
                title: { type: "string" },
                snippet: { type: "string" },
                publishedAt: { type: "string" },
              },
            },
          },
          truncated: { type: "boolean", required: true },
          noAutomaticRetry: { type: "boolean", const: true, required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: formatSearchOutput(value),
      }],
      presentationMeta: (_args, value) => searchPresentationMeta(value),
    },
    timeoutMs: WEB_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      assertOnlyKeys(args, ["query", "max_results"]);
      const query = requireNonBlank(args.query, "query");
      const maxResults = boundedResultCount(args.max_results);
      const result = await providers.search.search(
        { query, maxResults },
        exec.signal,
      );
      return projectSearchResult(query, result);
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Modellix Web Search · ${args.query}`,
      kind: "search",
      rawInput: args.query,
    }),
    presentResult: (args, result) => presentSearchResult(args.query, result),
  });
}

function createFetchTool(providers: ModellixWebProviders): ToolDefinition {
  return defineTool({
    name: MODELLIX_WEB_FETCH_TOOL,
    description: "Fetch one specific public HTTP(S) page through the Modellix Web Fetch API. Use automatically for a user-supplied URL or when a Modellix search source needs full-page reading. One invocation sends exactly one Modellix fetch request and never retries it automatically.",
    parameters: {
      url: {
        type: "string",
        required: true,
        description: "The public HTTP(S) URL to retrieve.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: "integer", const: 1, required: true },
          service: { type: "string", const: "web", required: true },
          provider: { type: "string", const: "modellix", required: true },
          operation: { type: "string", const: "fetch", required: true },
          endpoint: {
            type: "string",
            const: MODELLIX_WEB_FETCH_ENDPOINT,
            required: true,
          },
          requestedUrl: { type: "string", required: true },
          url: { type: "string", required: true },
          statusCode: { type: "integer", required: true },
          body: {
            required: true,
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", const: "html", required: true },
                  content: { type: "string", required: true },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", const: "text", required: true },
                  content: { type: "string", required: true },
                },
              },
            ],
          },
          truncated: { type: "boolean", required: true },
          noAutomaticRetry: { type: "boolean", const: true, required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: formatFetchOutput(value),
      }],
      presentationMeta: (_args, value) => fetchPresentationMeta(value),
    },
    timeoutMs: WEB_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      assertOnlyKeys(args, ["url"]);
      const requestedUrl = requireNonBlank(args.url, "url");
      const result = await providers.fetch.fetch({ url: requestedUrl }, exec.signal);
      return projectFetchResult(requestedUrl, result);
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Modellix Web Fetch · ${args.url}`,
      kind: "fetch",
      rawInput: args.url,
    }),
    presentResult: (args, result) => presentFetchResult(args.url, result),
  });
}

function projectSearchResult(
  query: string,
  result: WebSearchResult,
): ModellixWebSearchToolResult {
  return {
    version: 1,
    service: "web",
    provider: "modellix",
    operation: "search",
    endpoint: MODELLIX_WEB_SEARCH_ENDPOINT,
    query,
    ...(result.content === undefined ? {} : { content: result.content }),
    sources: result.sources.map(projectSource),
    truncated: result.truncated,
    noAutomaticRetry: true,
  };
}

function projectFetchResult(
  requestedUrl: string,
  result: WebFetchResult,
): ModellixWebFetchToolResult {
  const content = result.body.content.slice(0, MAX_FETCH_OUTPUT_CHARS);
  return {
    version: 1,
    service: "web",
    provider: "modellix",
    operation: "fetch",
    endpoint: MODELLIX_WEB_FETCH_ENDPOINT,
    requestedUrl,
    url: result.url,
    statusCode: result.statusCode,
    body: { kind: result.body.kind, content },
    truncated: result.truncated || content.length !== result.body.content.length,
    noAutomaticRetry: true,
  };
}

function projectSource(source: WebSearchSource): WebSearchSource {
  return {
    url: source.url,
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.snippet === undefined ? {} : { snippet: source.snippet }),
    ...(source.publishedAt === undefined
      ? {}
      : { publishedAt: source.publishedAt }),
  };
}

function formatSearchOutput(value: ModellixWebSearchToolResult): string {
  const parts = [
    `Modellix Web Search completed for: ${value.query}`,
    `Provider endpoint: ${value.endpoint}`,
  ];
  if (value.content !== undefined && value.content.length > 0) {
    parts.push(value.content);
  }
  if (value.sources.length === 0) {
    parts.push("No sources found.");
  } else {
    parts.push(`Sources:\n${value.sources.map(formatSource).join("\n")}`);
  }
  if (value.truncated) {
    parts.push("The source list was truncated; refine the query if needed.");
  }
  parts.push("Cite the relevant source URLs as markdown links in the answer.");
  return parts.join("\n\n");
}

function formatSource(source: WebSearchSource): string {
  const label = source.title === undefined || source.title.length === 0
    ? source.url
    : source.title;
  const details = [source.snippet, source.publishedAt]
    .filter((value): value is string => value !== undefined && value.length > 0);
  return `- ${label}\n  URL: ${source.url}${details.length === 0 ? "" : `\n  ${details.join(" · ")}`}`;
}

function formatFetchOutput(value: ModellixWebFetchToolResult): string {
  const header = [
    `Modellix Web Fetch completed: ${value.url} (HTTP ${String(value.statusCode)})`,
    `Provider endpoint: ${value.endpoint}`,
  ].join("\n");
  const footer = value.truncated
    ? "\n\n(Content truncated. Fetch a more specific public URL if more detail is required.)"
    : "";
  return `${header}\n\n${value.body.content}${footer}`;
}

function searchPresentationMeta(value: ModellixWebSearchToolResult): JsonValue {
  return {
    sources: value.sources.map((source) => ({
      url: source.url,
      ...(source.title === undefined ? {} : { title: source.title }),
      ...(source.snippet === undefined ? {} : { snippet: source.snippet }),
      ...(source.publishedAt === undefined
        ? {}
        : { publishedAt: source.publishedAt }),
    })),
    truncated: value.truncated,
    ...(value.content === undefined ? {} : { answer: value.content }),
  };
}

function fetchPresentationMeta(value: ModellixWebFetchToolResult): JsonValue {
  return {
    url: value.url,
    statusCode: value.statusCode,
    truncated: value.truncated,
  };
}

function presentSearchResult(
  query: string,
  result: ToolResult,
): WebSearchResultView | undefined {
  if (result.isError) return undefined;
  const meta = asRecord(result.meta);
  if (meta === undefined || !Array.isArray(meta.sources) ||
    typeof meta.truncated !== "boolean") return undefined;
  const sources: WebSource[] = [];
  for (const candidate of meta.sources) {
    const source = asRecord(candidate);
    if (source === undefined || typeof source.url !== "string" ||
      !optionalStrings(source, ["title", "snippet", "publishedAt"])) return undefined;
    sources.push({
      url: source.url,
      ...(typeof source.title === "string" ? { title: source.title } : {}),
      ...(typeof source.snippet === "string" ? { snippet: source.snippet } : {}),
      ...(typeof source.publishedAt === "string"
        ? { publishedAt: source.publishedAt }
        : {}),
    });
  }
  if (meta.answer !== undefined && typeof meta.answer !== "string") return undefined;
  return {
    card: "web",
    kind: "search",
    title: `Modellix Web Search · ${query}`,
    sources,
    truncated: meta.truncated,
    ...(typeof meta.answer === "string" ? { answer: meta.answer } : {}),
  };
}

function presentFetchResult(
  requestedUrl: string,
  result: ToolResult,
): WebFetchResultView | undefined {
  if (result.isError) return undefined;
  const meta = asRecord(result.meta);
  if (meta === undefined || typeof meta.url !== "string" ||
    typeof meta.statusCode !== "number" || !Number.isInteger(meta.statusCode) ||
    typeof meta.truncated !== "boolean") return undefined;
  return {
    card: "web",
    kind: "fetch",
    title: `Modellix Web Fetch · ${requestedUrl}`,
    url: meta.url,
    statusCode: meta.statusCode,
    truncated: meta.truncated,
  };
}

function boundedResultCount(value: number | undefined): number {
  const resolved = value ?? DEFAULT_WEB_SEARCH_MAX_RESULTS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 ||
    resolved > MAX_WEB_SEARCH_RESULTS) {
    throw new TypeError(
      `max_results must be an integer from 1 through ${String(MAX_WEB_SEARCH_RESULTS)}`,
    );
  }
  return resolved;
}

function requireNonBlank(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must contain non-whitespace text`);
  }
  return value;
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const accepted = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !accepted.has(key));
  if (unexpected !== undefined) {
    throw new TypeError(`Unexpected tool argument: ${unexpected}`);
  }
}

function optionalStrings(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === "string");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function disposeAll(disposers: readonly (() => unknown)[]): void {
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose();
    } catch {
      // Best-effort rollback/disposal must not keep later registrations alive.
    }
  }
}
