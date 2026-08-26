import { createRequire } from "node:module";

import { Context } from "@deepseek-ai/cordis";
import {
  SettingsProvider,
  settingsNamespace,
  type SettingsNamespace,
  type SettingsScope,
} from "@deepseek-ai/dsh-settings";
import type z from "@deepseek-ai/schemastery";
import { describe, expect, it } from "vitest";

const PI_AI_MODULE_ID: string = "@deepseek-ai/dsh-llm-pi-ai";
const EXPECTED_PI_AI_VERSION = "0.1.1-rc.2";
const LLM_SETTINGS_NAMESPACE = settingsNamespace("llm-pi-ai");
const PROVENANCE_FIELD = "__dshModellixMaterialization";
const PROVENANCE_TOKEN = "llm_contract_provenance_1234";

interface PiAiSettingsConfig {
  readonly providers?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly [key: string]: unknown;
}

interface DurableSettingsStore {
  document: Record<string, unknown>;
  persistCount: number;
}

interface MountedSettings {
  readonly root: Context;
  readonly provider: SettingsProvider;
  readonly scope: SettingsScope<PiAiSettingsConfig>;
}

const MODELLIX_ROUTE = Object.freeze({
  apiKeyEnv: "MODELLIX_API_KEY",
  displayName: "Modellix",
  api: "openai-completions",
  baseURL: "https://llm.modellix.ai/v1",
  defaultInput: ["text"],
  retryPolicy: { mode: "normal", maxRetries: 0 },
  models: [{ id: "openai/gpt-5.6-sol" }],
});

describe("llm-pi-ai Settings provenance contract", () => {
  it("persists a top-level token across registration rebuilds without placing it in the provider route", async () => {
    expect(installedPiAiVersion()).toBe(EXPECTED_PI_AI_VERSION);
    const schema = await loadPiAiConfigSchema();
    const store: DurableSettingsStore = { document: {}, persistCount: 0 };

    const first = await mountSettings(store, schema);
    try {
      expect(descriptor(first.provider).revision).toBe(0);

      await first.provider.mutate(LLM_SETTINGS_NAMESPACE, [
        {
          op: "set",
          path: ["providers", "modellix"],
          value: MODELLIX_ROUTE,
        },
        {
          op: "set",
          path: [PROVENANCE_FIELD],
          value: PROVENANCE_TOKEN,
        },
      ], 0);

      expect(store.persistCount).toBe(1);
      const written = descriptor(first.provider);
      expect(written.revision).toBe(1);
      expectRawProvenance(written.user);
      expectResolvedRouteBoundary(first.scope.get());
    } finally {
      await first.root.fiber.dispose();
    }

    const rebuilt = await mountSettings(store, schema);
    try {
      const reloaded = descriptor(rebuilt.provider);
      // dsh-settings revisions belong to one registration and intentionally
      // restart at zero; durable raw provenance, not revision arithmetic, is
      // the cross-process proof of the atomic route write.
      expect(reloaded.revision).toBe(0);
      expectRawProvenance(reloaded.user);
      expectResolvedRouteBoundary(rebuilt.scope.get());
      expect(store.persistCount).toBe(1);
    } finally {
      await rebuilt.root.fiber.dispose();
    }
  });
});

async function loadPiAiConfigSchema(): Promise<z<PiAiSettingsConfig>> {
  // A non-literal dynamic import keeps TypeScript from walking the adapter's
  // pi-ai SDK declarations while still exercising the installed runtime.
  const module = await import(/* @vite-ignore */ PI_AI_MODULE_ID) as Record<string, unknown>;
  if (typeof module.Config !== "function") {
    throw new TypeError("Installed dsh-llm-pi-ai does not export Config");
  }
  return module.Config as z<PiAiSettingsConfig>;
}

function installedPiAiVersion(): string {
  const require = createRequire(import.meta.url);
  const metadata = require(`${PI_AI_MODULE_ID}/package.json`) as unknown;
  if (!isRecord(metadata) || typeof metadata.version !== "string") {
    throw new TypeError("Installed dsh-llm-pi-ai package metadata is malformed");
  }
  return metadata.version;
}

async function mountSettings(
  store: DurableSettingsStore,
  schema: z<PiAiSettingsConfig>,
): Promise<MountedSettings> {
  class MemorySettingsProvider extends SettingsProvider {
    readonly writable = true;

    protected override async load(): Promise<Record<string, unknown>> {
      return structuredClone(store.document);
    }

    protected override async persist(
      namespace: SettingsNamespace,
      section: Record<string, unknown>,
    ): Promise<void> {
      store.document = {
        ...structuredClone(store.document),
        [String(namespace)]: structuredClone(section),
      };
      store.persistCount += 1;
    }
  }

  const root = new Context();
  await root.plugin(MemorySettingsProvider);
  let scope: SettingsScope<PiAiSettingsConfig> | undefined;
  let provider: SettingsProvider | undefined;
  await root.inject(["settings"], (ctx) => {
    provider = ctx.settings;
    scope = ctx.settings.register(LLM_SETTINGS_NAMESPACE, schema, {
      applies: "live",
    });
  });
  if (scope === undefined || provider === undefined) {
    await root.fiber.dispose();
    throw new Error("llm-pi-ai Settings scope did not register");
  }
  return { root, provider, scope };
}

function descriptor(provider: SettingsProvider): {
  readonly revision: number;
  readonly user?: unknown;
} {
  const found = provider.describe({ redactSecrets: true })
    .find((candidate) => candidate.ns === LLM_SETTINGS_NAMESPACE);
  if (found === undefined) {
    throw new Error("llm-pi-ai Settings descriptor is unavailable");
  }
  return found;
}

function expectRawProvenance(value: unknown): void {
  expect(value).toMatchObject({
    [PROVENANCE_FIELD]: PROVENANCE_TOKEN,
    providers: { modellix: MODELLIX_ROUTE },
  });
  const raw = requireRecord(value, "raw llm-pi-ai user section");
  const providers = requireRecord(raw.providers, "raw providers");
  const route = requireRecord(providers.modellix, "raw Modellix route");
  expect(route).not.toHaveProperty(PROVENANCE_FIELD);
}

function expectResolvedRouteBoundary(value: PiAiSettingsConfig): void {
  expect(value[PROVENANCE_FIELD]).toBe(PROVENANCE_TOKEN);
  const providers = requireRecord(value.providers, "resolved providers");
  const route = requireRecord(providers.modellix, "resolved Modellix route");
  expect(route).not.toHaveProperty(PROVENANCE_FIELD);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
