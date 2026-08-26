import { describe, expect, it, vi } from "vitest";

import {
  LlmRegistryBackreadError,
  verifyLlmRegistryBackread,
  type LlmRegistryReader,
} from "../../../src/llm/index.js";

const MODELS = [
  { id: "openai/gpt-image-2", name: "GPT Image 2" },
  { id: "google/veo-3.1", name: "Veo 3.1" },
] as const;

describe("LLM public registry backread", () => {
  it("resolves the registered route and every exact materialized model without generating", async () => {
    const resolveModelInfo = vi.fn(async (provider: string, model: string) => ({
      provider,
      id: model,
      name: model,
    }));
    const registry: LlmRegistryReader = {
      listProviders: () => [{ id: "modellix", name: "Modellix" }],
      resolveModelInfo,
    };

    await expect(verifyLlmRegistryBackread(registry, MODELS)).resolves.toBeUndefined();
    expect(resolveModelInfo.mock.calls.map(([provider, model]) => [provider, model])).toEqual([
      ["modellix", "openai/gpt-image-2"],
      ["modellix", "google/veo-3.1"],
    ]);
  });

  it("waits for the llm-pi-ai Settings watcher to publish the route", async () => {
    let reads = 0;
    const registry: LlmRegistryReader = {
      listProviders: () => (++reads === 1 ? [] : [{ id: "modellix", name: "Modellix" }]),
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    };

    await expect(verifyLlmRegistryBackread(registry, MODELS, {
      attempts: 2,
      retryDelayMs: 0,
    })).resolves.toBeUndefined();
    expect(reads).toBe(2);
  });

  it("fails closed when an exact model never resolves from the public registry", async () => {
    const failure = new Error("model absent from adapter snapshot");
    const registry: LlmRegistryReader = {
      listProviders: () => [{ id: "modellix", name: "Modellix" }],
      resolveModelInfo: async () => Promise.reject(failure),
    };

    const verification = verifyLlmRegistryBackread(registry, MODELS, {
      attempts: 2,
      retryDelayMs: 0,
    });
    await expect(verification).rejects.toMatchObject({
      name: "LlmRegistryBackreadError",
      attempts: 2,
      cause: failure,
    });
    await expect(verification).rejects.toBeInstanceOf(LlmRegistryBackreadError);
  });

  it("honors cancellation while waiting for a registry refresh", async () => {
    const controller = new AbortController();
    const registry: LlmRegistryReader = {
      listProviders: () => [],
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    };
    const verification = verifyLlmRegistryBackread(registry, MODELS, {
      attempts: 20,
      retryDelayMs: 1_000,
      signal: controller.signal,
    });

    controller.abort(new DOMException("stopped", "AbortError"));
    await expect(verification).rejects.toMatchObject({ name: "AbortError" });
  });
});
