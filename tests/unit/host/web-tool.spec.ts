import type { Context } from "@deepseek-ai/cordis";
import type {
  ToolDefinition,
  ToolResult,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";

import {
  MODELLIX_WEB_FETCH_ENDPOINT,
  MODELLIX_WEB_SEARCH_ENDPOINT,
  type ModellixWebProviders,
} from "../../../src/web/index.js";
import {
  MODELLIX_WEB_FETCH_TOOL,
  MODELLIX_WEB_SEARCH_TOOL,
  createModellixWebToolDefinitions,
  registerModellixWebTools,
} from "../../../src/host/web-tool.js";
import type { JsonValue } from "../../../src/shared/json-value.js";

function providerHarness(): {
  readonly providers: ModellixWebProviders;
  readonly search: ReturnType<typeof vi.fn>;
  readonly fetch: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(async () => ({
    content: "A current answer.",
    sources: [
      {
        url: "https://example.test/source",
        title: "Example source",
        snippet: "A useful excerpt.",
        publishedAt: "2026-08-31T00:00:00.000Z",
      },
      { url: "https://example.test/untitled" },
    ],
    truncated: false,
  }));
  const fetch = vi.fn(async () => ({
    url: "https://example.test/page",
    statusCode: 200,
    body: { kind: "text" as const, content: "Fetched page body." },
    truncated: false,
  }));
  return {
    providers: {
      search: {
        id: "modellix",
        available: () => true,
        search,
      },
      fetch: {
        id: "modellix",
        available: () => true,
        fetch,
      },
    } as unknown as ModellixWebProviders,
    search,
    fetch,
  };
}

function tool(
  providers: ModellixWebProviders,
  name: string,
): ToolDefinition {
  const found = createModellixWebToolDefinitions(providers)
    .find((definition) => definition.name === name);
  if (found === undefined) throw new Error(`Missing tool: ${name}`);
  return found;
}

function execution(signal = new AbortController().signal): ToolRunContext {
  return { signal, agent: { id: "web-tool-test" } } as unknown as ToolRunContext;
}

function renderedText(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  value: JsonValue,
): string {
  const block = definition.output.render(args, value)[0];
  if (block?.type !== "text") throw new Error("Expected a text output");
  return block.text;
}

function completed(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  value: JsonValue,
): ToolResult {
  return {
    isError: false,
    content: definition.output.render(args, value),
    ...(definition.output.presentationMeta === undefined
      ? {}
      : { meta: definition.output.presentationMeta(args, value) }),
  };
}

describe("explicit Modellix Web tools", () => {
  it("publishes two namespaced tools rather than impersonating Harness native tools", () => {
    const { providers } = providerHarness();
    expect(createModellixWebToolDefinitions(providers).map((item) => item.name))
      .toEqual([MODELLIX_WEB_SEARCH_TOOL, MODELLIX_WEB_FETCH_TOOL]);
  });

  it("executes one search directly through the Modellix provider with visible provenance", async () => {
    const harness = providerHarness();
    const definition = tool(harness.providers, MODELLIX_WEB_SEARCH_TOOL);
    const signal = new AbortController().signal;
    const value = await definition.execute(
      { query: "current Modellix docs", max_results: 3 },
      execution(signal),
    ) as JsonValue;

    expect(harness.search).toHaveBeenCalledOnce();
    expect(harness.search).toHaveBeenCalledWith({
      query: "current Modellix docs",
      maxResults: 3,
    }, signal);
    expect(value).toMatchObject({
      version: 1,
      service: "web",
      provider: "modellix",
      operation: "search",
      endpoint: MODELLIX_WEB_SEARCH_ENDPOINT,
      query: "current Modellix docs",
      noAutomaticRetry: true,
    });
    const text = renderedText(definition, {}, value);
    expect(text).toContain("Modellix Web Search completed");
    expect(text).toContain(MODELLIX_WEB_SEARCH_ENDPOINT);
    expect(text).toContain("Example source");
    expect(text).toContain("https://example.test/untitled");
    expect(text).toContain("Cite the relevant source URLs");

    expect(definition.presentCall?.({ query: "current Modellix docs" }))
      .toMatchObject({
        card: "generic",
        title: "Modellix Web Search · current Modellix docs",
        kind: "search",
      });
    expect(definition.presentResult?.(
      { query: "current Modellix docs" },
      completed(definition, {}, value),
    )).toMatchObject({
      card: "web",
      kind: "search",
      title: "Modellix Web Search · current Modellix docs",
      sources: [
        expect.objectContaining({ title: "Example source" }),
        expect.objectContaining({ url: "https://example.test/untitled" }),
      ],
      answer: "A current answer.",
      truncated: false,
    });
  });

  it("uses the fixed default result bound and describes empty or truncated searches", async () => {
    const harness = providerHarness();
    harness.search.mockResolvedValueOnce({ sources: [], truncated: true });
    const definition = tool(harness.providers, MODELLIX_WEB_SEARCH_TOOL);
    const value = await definition.execute(
      { query: "nothing here" },
      execution(),
    ) as JsonValue;

    expect(harness.search).toHaveBeenCalledWith({
      query: "nothing here",
      maxResults: 5,
    }, expect.any(AbortSignal));
    const text = renderedText(definition, {}, value);
    expect(text).toContain("No sources found.");
    expect(text).toContain("source list was truncated");
  });

  it.each([
    [{ query: " " }, "query must contain non-whitespace text"],
    [{ query: "valid", max_results: 0 }, "max_results must be an integer"],
    [{ query: "valid", max_results: 21 }, "max_results must be an integer"],
    [{ query: "valid", unexpected: true }, "Unexpected tool argument"],
  ])("rejects invalid search input before dispatch: %j", async (args, message) => {
    const harness = providerHarness();
    const definition = tool(harness.providers, MODELLIX_WEB_SEARCH_TOOL);
    await expect(definition.execute(args, execution())).rejects.toThrow(message);
    expect(harness.search).not.toHaveBeenCalled();
  });

  it("executes one fetch directly and caps oversized model context", async () => {
    const harness = providerHarness();
    harness.fetch.mockResolvedValueOnce({
      url: "https://example.test/final",
      statusCode: 206,
      body: { kind: "html", content: "x".repeat(200_001) },
      truncated: false,
    });
    const definition = tool(harness.providers, MODELLIX_WEB_FETCH_TOOL);
    const signal = new AbortController().signal;
    const value = await definition.execute(
      { url: "https://example.test/start" },
      execution(signal),
    ) as JsonValue;

    expect(harness.fetch).toHaveBeenCalledOnce();
    expect(harness.fetch).toHaveBeenCalledWith(
      { url: "https://example.test/start" },
      signal,
    );
    expect(value).toMatchObject({
      version: 1,
      service: "web",
      provider: "modellix",
      operation: "fetch",
      endpoint: MODELLIX_WEB_FETCH_ENDPOINT,
      requestedUrl: "https://example.test/start",
      url: "https://example.test/final",
      statusCode: 206,
      truncated: true,
      noAutomaticRetry: true,
    });
    expect((value as { body: { content: string } }).body.content).toHaveLength(200_000);
    const text = renderedText(definition, {}, value);
    expect(text).toContain("Modellix Web Fetch completed");
    expect(text).toContain(MODELLIX_WEB_FETCH_ENDPOINT);
    expect(text).toContain("Content truncated");

    expect(definition.presentCall?.({ url: "https://example.test/start" }))
      .toMatchObject({
        card: "generic",
        title: "Modellix Web Fetch · https://example.test/start",
        kind: "fetch",
      });
    expect(definition.presentResult?.(
      { url: "https://example.test/start" },
      completed(definition, {}, value),
    )).toEqual({
      card: "web",
      kind: "fetch",
      title: "Modellix Web Fetch · https://example.test/start",
      url: "https://example.test/final",
      statusCode: 206,
      truncated: true,
    });
  });

  it("preserves a provider-side fetch truncation marker and ordinary untruncated text", async () => {
    const harness = providerHarness();
    harness.fetch.mockResolvedValueOnce({
      url: "https://example.test/page",
      statusCode: 200,
      body: { kind: "text", content: "short body" },
      truncated: true,
    });
    const definition = tool(harness.providers, MODELLIX_WEB_FETCH_TOOL);
    const value = await definition.execute(
      { url: "https://example.test/page" },
      execution(),
    ) as JsonValue;
    expect(renderedText(definition, {}, value)).toContain("Content truncated");

    const ordinary = await definition.execute(
      { url: "https://example.test/page" },
      execution(),
    ) as JsonValue;
    expect(renderedText(definition, {}, ordinary)).not.toContain("Content truncated");
  });

  it.each([
    [{ url: " " }, "url must contain non-whitespace text"],
    [{ url: "https://example.test", extra: true }, "Unexpected tool argument"],
  ])("rejects invalid fetch input before dispatch: %j", async (args, message) => {
    const harness = providerHarness();
    const definition = tool(harness.providers, MODELLIX_WEB_FETCH_TOOL);
    await expect(definition.execute(args, execution())).rejects.toThrow(message);
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it("falls back safely when replayed presentation metadata is missing or malformed", () => {
    const harness = providerHarness();
    const search = tool(harness.providers, MODELLIX_WEB_SEARCH_TOOL);
    const fetch = tool(harness.providers, MODELLIX_WEB_FETCH_TOOL);
    const failure = { isError: true, content: [] } satisfies ToolResult;

    expect(search.presentResult?.({ query: "q" }, failure)).toBeUndefined();
    expect(fetch.presentResult?.({ url: "https://example.test" }, failure)).toBeUndefined();
    for (const meta of [
      undefined,
      { sources: "not-an-array", truncated: false },
      { sources: [], truncated: "no" },
      { sources: [null], truncated: false },
      { sources: [{ url: 1 }], truncated: false },
      { sources: [{ url: "https://example.test", title: 1 }], truncated: false },
      { sources: [], truncated: false, answer: 1 },
    ]) {
      expect(search.presentResult?.(
        { query: "q" },
        { isError: false, content: [], ...(meta === undefined ? {} : { meta: meta as JsonValue }) },
      )).toBeUndefined();
    }
    for (const meta of [
      undefined,
      { url: 1, statusCode: 200, truncated: false },
      { url: "https://example.test", statusCode: "200", truncated: false },
      { url: "https://example.test", statusCode: 200.5, truncated: false },
      { url: "https://example.test", statusCode: 200, truncated: "no" },
    ]) {
      expect(fetch.presentResult?.(
        { url: "https://example.test" },
        { isError: false, content: [], ...(meta === undefined ? {} : { meta: meta as JsonValue }) },
      )).toBeUndefined();
    }
  });

  it("registers and disposes both tools and rolls back an incomplete registration", () => {
    const harness = providerHarness();
    const disposed: string[] = [];
    const registered: string[] = [];
    const context = {
      tools: {
        register(definition: ToolDefinition) {
          registered.push(definition.name);
          return () => disposed.push(definition.name);
        },
      },
    } as unknown as Context;

    const dispose = registerModellixWebTools(context, harness.providers);
    expect(registered).toEqual([MODELLIX_WEB_SEARCH_TOOL, MODELLIX_WEB_FETCH_TOOL]);
    dispose();
    expect(disposed).toEqual([MODELLIX_WEB_FETCH_TOOL, MODELLIX_WEB_SEARCH_TOOL]);

    let registrations = 0;
    const broken = {
      tools: {
        register(definition: ToolDefinition) {
          registrations += 1;
          if (registrations === 2) throw new Error("duplicate");
          return () => {
            disposed.push(`rollback:${definition.name}`);
            throw new Error("cleanup failed");
          };
        },
      },
    } as unknown as Context;
    expect(() => registerModellixWebTools(broken, harness.providers)).toThrow("duplicate");
    expect(disposed).toContain(`rollback:${MODELLIX_WEB_SEARCH_TOOL}`);
  });
});
