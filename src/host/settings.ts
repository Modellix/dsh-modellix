import z from "@deepseek-ai/schemastery";
import type { SettingsPathOp } from "@deepseek-ai/dsh-settings";
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  MODELLIX_CREDENTIAL_REF,
  createDefaultConfig,
  migrateConfig,
  type PluginConfig,
} from "../core/index.js";

export const MODELLIX_SETTINGS_NAMESPACE = "modellix" as const;

const modelId = z.string();
const serviceToggle = z.boolean().default(true);
const fingerprintEntry = z.object({
  kind: z.union(["field", "model"]).required(),
  key: z.string().required(),
  appliedFingerprint: z.string().required(),
});

/** Serializable non-secret section. Host reads still pass through migrateConfig. */
export const PluginSettingsSchema: z<PluginConfig> = z.object({
  schemaVersion: z.const(CURRENT_CONFIG_SCHEMA_VERSION).default(CURRENT_CONFIG_SCHEMA_VERSION),
  credentialRef: z.const(MODELLIX_CREDENTIAL_REF).default(MODELLIX_CREDENTIAL_REF),
  credentialEpoch: z.natural().default(0),
  services: z.object({
    design: z.object({
      enabled: serviceToggle,
      retentionPolicy: z.union(["retain-input", "metadata-only"]).default("retain-input"),
      retentionPolicyRevision: z.natural().min(1).default(1),
      lastModel: z.union([modelId, z.const(null)]).default(null),
      recentModels: z.array(modelId).default([]),
      favoriteModels: z.array(modelId).default([]),
    }),
    llm: z.object({
      enabled: serviceToggle,
      recentModels: z.array(modelId).default([]),
      favoriteModels: z.array(modelId).default([]),
    }),
    web: z.object({ enabled: serviceToggle }),
  }),
  onboarding: z.object({
    status: z.union(["active", "completed", "deferred"]).default("active"),
    // Recovery carries no Secret. Core owns its bounded runtime validation.
    saveRecovery: z.any().default(null),
  }),
  llmOwnership: z.object({
    route: z.object({
      ownership: z.union(["none", "created", "adopted"]).default("none"),
      appliedRouteFingerprint: z.union([z.string(), z.const(null)]).default(null),
      entries: z.array(fingerprintEntry).default([]),
    }),
  }),
}) as z<PluginConfig>;

export interface SettingsScopeLike {
  get(): PluginConfig;
  watch(callback: (next: PluginConfig, previous: PluginConfig) => void | Promise<void>): () => void;
}

export interface SettingsServiceLike {
  register<T>(
    namespace: string,
    schema: z<T>,
    options: { readonly base: Partial<T>; readonly applies: "live" },
  ): SettingsScopeLike;
  describe(options?: { readonly redactSecrets?: boolean }): readonly {
    readonly ns: string;
    readonly revision: number;
    readonly user?: unknown;
  }[];
  mutate(
    namespace: string,
    operations: readonly SettingsPathOp[],
    expectedRevision?: number,
  ): Promise<void>;
}

export interface PluginSettingsSnapshot {
  readonly config: PluginConfig;
  readonly revision: number;
}

/** Small CAS facade that always returns migrated, detached plugin settings. */
export class PluginSettingsController {
  readonly #settings: SettingsServiceLike;
  readonly #scope: SettingsScopeLike;

  constructor(settings: SettingsServiceLike) {
    this.#settings = settings;
    this.#scope = settings.register(
      MODELLIX_SETTINGS_NAMESPACE,
      PluginSettingsSchema,
      { base: createDefaultConfig(), applies: "live" },
    );
  }

  read(): PluginSettingsSnapshot {
    const descriptor = this.#settings.describe({ redactSecrets: true })
      .find((candidate) => candidate.ns === MODELLIX_SETTINGS_NAMESPACE);
    if (descriptor === undefined) throw new Error("Modellix settings namespace is unavailable");
    return {
      config: migrateConfig(this.#scope.get()),
      revision: descriptor.revision,
    };
  }

  async replace(config: PluginConfig, expectedRevision?: number): Promise<void> {
    const normalized = migrateConfig(config);
    await this.#settings.mutate(MODELLIX_SETTINGS_NAMESPACE, [{
      op: "set",
      path: [],
      value: normalized,
    }], expectedRevision);
  }

  watch(callback: (next: PluginConfig, previous: PluginConfig) => void | Promise<void>): () => void {
    return this.#scope.watch((next, previous) => callback(migrateConfig(next), migrateConfig(previous)));
  }
}
