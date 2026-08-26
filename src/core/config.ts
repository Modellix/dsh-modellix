export const CURRENT_CONFIG_SCHEMA_VERSION = 1 as const;
export const MODELLIX_CREDENTIAL_REF = "MODELLIX_API_KEY" as const;

export type ServiceId = "design" | "llm" | "web";
export type OnboardingStatus = "active" | "completed" | "deferred";
export type RetentionPolicy = "metadata-only";

export interface ServiceToggles {
  readonly design: boolean;
  readonly llm: boolean;
  readonly web: boolean;
}

export interface DesignConfig {
  readonly enabled: boolean;
  readonly retentionPolicy: RetentionPolicy;
  readonly retentionPolicyRevision: number;
  readonly lastModel: string | null;
  readonly recentModels: readonly string[];
  readonly favoriteModels: readonly string[];
}

export interface LlmConfig {
  readonly enabled: boolean;
  readonly recentModels: readonly string[];
  readonly favoriteModels: readonly string[];
}

export interface WebConfig {
  readonly enabled: boolean;
}

export interface ServicesConfig {
  readonly design: DesignConfig;
  readonly llm: LlmConfig;
  readonly web: WebConfig;
}

export type OnboardingSavePhase =
  | "credential-write-pending"
  | "settings-write-pending";

/**
 * Non-secret write-ahead state for the two-store onboarding save.
 *
 * The Credential store and plugin Settings store cannot be committed in one
 * transaction. Persisting this record before calling the Credential API makes
 * an interrupted save explicit and recoverable without retaining the candidate
 * secret in plugin data.
 */
export interface OnboardingSaveRecovery {
  readonly operationId: string;
  readonly phase: OnboardingSavePhase;
  readonly startedAt: number;
  readonly intendedServices: ServiceToggles;
  readonly expectedCredentialEpoch: number;
  readonly expectedCredentialRevision: string | null;
  readonly confirmedCredentialRevision: string | null;
}

export interface OnboardingConfig {
  readonly status: OnboardingStatus;
  readonly saveRecovery: OnboardingSaveRecovery | null;
}

export type PersistedLlmRouteOwnership = "none" | "created" | "adopted";

export interface LlmRouteOwnershipEntry {
  readonly kind: "field" | "model";
  readonly key: string;
  readonly appliedFingerprint: string;
}

export interface LlmRouteOwnershipConfig {
  readonly ownership: PersistedLlmRouteOwnership;
  readonly appliedRouteFingerprint: string | null;
  readonly entries: readonly LlmRouteOwnershipEntry[];
}

/** Non-secret write-ahead marker for one cross-namespace LLM materialization. */
export interface LlmMaterializationRecovery {
  readonly operationId: string;
  readonly startedAt: number;
  readonly expectedLlmSettingsRevision: number;
  /** Fingerprint of the raw user route before the CAS. Null only for legacy evidence. */
  readonly previousRouteFingerprint: string | null;
  /** Planned ownership, persisted before the route CAS. Null only for legacy evidence. */
  readonly targetRouteOwnership: LlmRouteOwnershipConfig | null;
}

export interface BeginLlmMaterializationInput {
  readonly operationId: string;
  readonly startedAt: number;
  readonly expectedLlmSettingsRevision: number;
  readonly previousRouteFingerprint: string;
  readonly targetRouteOwnership: LlmRouteOwnershipConfig;
}

export interface LlmOwnershipConfig {
  readonly route: LlmRouteOwnershipConfig;
  readonly materializationRecovery: LlmMaterializationRecovery | null;
}

export interface PluginConfig {
  readonly schemaVersion: typeof CURRENT_CONFIG_SCHEMA_VERSION;
  readonly credentialRef: typeof MODELLIX_CREDENTIAL_REF;
  /** Monotonic plugin-owned generation; never derived from Credential bytes. */
  readonly credentialEpoch: number;
  readonly services: ServicesConfig;
  readonly onboarding: OnboardingConfig;
  readonly llmOwnership: LlmOwnershipConfig;
}

export interface BeginOnboardingSaveInput {
  readonly operationId: string;
  readonly startedAt: number;
  readonly intendedServices: ServiceToggles;
  readonly expectedCredentialRevision: string | null;
}

export type OnboardingRecoveryAction =
  | "none"
  | "await-credential-write"
  | "commit-intended-settings"
  | "needs-user-reconciliation";

export interface OnboardingRecoveryDecision {
  readonly config: PluginConfig;
  readonly action: OnboardingRecoveryAction;
}

export class UnsupportedConfigVersionError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`Unsupported dsh-modellix config schema version: ${version}`);
    this.name = "UnsupportedConfigVersionError";
    this.version = version;
  }
}

export class OnboardingSaveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingSaveConflictError";
  }
}

export class LlmMaterializationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmMaterializationConflictError";
  }
}

const DEFAULT_TOGGLES: ServiceToggles = Object.freeze({
  design: true,
  llm: true,
  web: true,
});

export function createDefaultConfig(): PluginConfig {
  return {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    credentialRef: MODELLIX_CREDENTIAL_REF,
    credentialEpoch: 0,
    services: {
      design: {
        enabled: DEFAULT_TOGGLES.design,
        retentionPolicy: "metadata-only",
        retentionPolicyRevision: 1,
        lastModel: null,
        recentModels: [],
        favoriteModels: [],
      },
      llm: {
        enabled: DEFAULT_TOGGLES.llm,
        recentModels: [],
        favoriteModels: [],
      },
      web: { enabled: DEFAULT_TOGGLES.web },
    },
    onboarding: {
      status: "active",
      saveRecovery: null,
    },
    llmOwnership: {
      route: {
        ownership: "none",
        appliedRouteFingerprint: null,
        entries: [],
      },
      materializationRecovery: null,
    },
  };
}

/**
 * Migrates absent/legacy settings by filling missing fields without turning an
 * explicit false toggle back on. Unknown future schema versions are rejected
 * instead of being silently downgraded.
 */
export function migrateConfig(input: unknown): PluginConfig {
  if (!isRecord(input)) {
    return createDefaultConfig();
  }

  const sourceVersion = nonNegativeInteger(input.schemaVersion, 0);
  if (sourceVersion > CURRENT_CONFIG_SCHEMA_VERSION) {
    throw new UnsupportedConfigVersionError(sourceVersion);
  }

  const defaults = createDefaultConfig();
  const services = isRecord(input.services) ? input.services : {};
  const design = serviceRecord(services.design);
  const llm = serviceRecord(services.llm);
  const web = serviceRecord(services.web);
  const legacyWeb = serviceRecord(input.web);
  const onboarding = isRecord(input.onboarding) ? input.onboarding : {};
  const llmOwnership = isRecord(input.llmOwnership) ? input.llmOwnership : {};
  const hasLlmMaterializationRecovery = Object.hasOwn(
    llmOwnership,
    "materializationRecovery",
  );

  const migrated: PluginConfig = {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    credentialRef: MODELLIX_CREDENTIAL_REF,
    credentialEpoch: nonNegativeInteger(
      input.credentialEpoch,
      defaults.credentialEpoch,
    ),
    services: {
      design: {
        enabled: explicitBoolean(design.enabled, defaults.services.design.enabled),
        retentionPolicy: retentionPolicy(design.retentionPolicy),
        retentionPolicyRevision: positiveInteger(
          design.retentionPolicyRevision,
          defaults.services.design.retentionPolicyRevision,
        ),
        lastModel: optionalModelId(design.lastModel),
        recentModels: modelIdList(design.recentModels),
        favoriteModels: modelIdList(design.favoriteModels),
      },
      llm: {
        enabled: explicitBoolean(llm.enabled, defaults.services.llm.enabled),
        recentModels: modelIdList(llm.recentModels),
        favoriteModels: modelIdList(llm.favoriteModels),
      },
      web: {
        enabled: explicitBoolean(
          web.enabled,
          explicitBoolean(
            legacyWeb.enabled,
            explicitBoolean(input.enabled, defaults.services.web.enabled),
          ),
        ),
      },
    },
    onboarding: {
      status: onboardingStatus(onboarding.status, defaults.onboarding.status),
      saveRecovery: migrateSaveRecovery(onboarding.saveRecovery),
    },
    llmOwnership: {
      route: migrateLlmRouteOwnership(llmOwnership.route),
      materializationRecovery: migrateLlmMaterializationRecovery(
        llmOwnership.materializationRecovery,
        hasLlmMaterializationRecovery,
      ),
    },
  };

  return migrated;
}

export function getServiceToggles(config: PluginConfig): ServiceToggles {
  return {
    design: config.services.design.enabled,
    llm: config.services.llm.enabled,
    web: config.services.web.enabled,
  };
}

export function setServiceToggles(
  config: PluginConfig,
  toggles: ServiceToggles,
): PluginConfig {
  return {
    ...config,
    services: applyToggles(config.services, toggles),
  };
}

export function beginLlmMaterialization(
  config: PluginConfig,
  input: BeginLlmMaterializationInput,
): PluginConfig {
  if (config.llmOwnership.materializationRecovery !== null) {
    throw new LlmMaterializationConflictError(
      "An LLM materialization operation is already pending",
    );
  }
  assertOperationId(input.operationId);
  assertTimestamp(input.startedAt);
  if (!Number.isSafeInteger(input.expectedLlmSettingsRevision) || input.expectedLlmSettingsRevision < 0) {
    throw new TypeError("expectedLlmSettingsRevision must be a non-negative safe integer");
  }
  if (safeFingerprint(input.previousRouteFingerprint) === null) {
    throw new TypeError("previousRouteFingerprint must be a SHA-256 fingerprint");
  }
  const targetRouteOwnership = copyLlmRouteOwnership(input.targetRouteOwnership);
  if (targetRouteOwnership.ownership === "none") {
    throw new TypeError("targetRouteOwnership must describe a materialized route");
  }
  return {
    ...config,
    llmOwnership: {
      ...config.llmOwnership,
      materializationRecovery: {
        ...input,
        targetRouteOwnership,
      },
    },
  };
}

export function completeLlmMaterialization(
  config: PluginConfig,
  operationId: string,
): PluginConfig {
  const recovery = requireLlmMaterializationRecovery(config, operationId);
  if (recovery.targetRouteOwnership === null) {
    throw new LlmMaterializationConflictError(
      "Legacy LLM materialization evidence cannot prove route ownership",
    );
  }
  return {
    ...config,
    llmOwnership: {
      route: copyLlmRouteOwnership(recovery.targetRouteOwnership),
      materializationRecovery: null,
    },
  };
}

export function abandonLlmMaterialization(
  config: PluginConfig,
  operationId: string,
): PluginConfig {
  const recovery = config.llmOwnership.materializationRecovery;
  if (recovery === null) return config;
  requireLlmMaterializationRecovery(config, operationId);
  return {
    ...config,
    llmOwnership: {
      ...config.llmOwnership,
      materializationRecovery: null,
    },
  };
}

export function beginOnboardingSave(
  config: PluginConfig,
  input: BeginOnboardingSaveInput,
): PluginConfig {
  if (config.onboarding.saveRecovery !== null) {
    throw new OnboardingSaveConflictError(
      "An onboarding save operation is already pending",
    );
  }
  assertOperationId(input.operationId);
  assertTimestamp(input.startedAt);
  assertOpaqueRevision(input.expectedCredentialRevision);

  return {
    ...config,
    onboarding: {
      ...config.onboarding,
      saveRecovery: {
        operationId: input.operationId,
        phase: "credential-write-pending",
        startedAt: input.startedAt,
        intendedServices: copyToggles(input.intendedServices),
        expectedCredentialEpoch: config.credentialEpoch,
        expectedCredentialRevision: input.expectedCredentialRevision,
        confirmedCredentialRevision: null,
      },
    },
  };
}

/** Marks a confirmed Host Credential write without storing any Credential data. */
export function markOnboardingCredentialSaved(
  config: PluginConfig,
  operationId: string,
  confirmedCredentialRevision: string,
): PluginConfig {
  const recovery = requireRecovery(config, operationId);
  if (recovery.phase !== "credential-write-pending") {
    if (recovery.confirmedCredentialRevision === confirmedCredentialRevision) {
      return config;
    }
    throw new OnboardingSaveConflictError(
      "Credential write was already confirmed with a different revision",
    );
  }
  if (recovery.expectedCredentialEpoch !== config.credentialEpoch) {
    throw new OnboardingSaveConflictError(
      "Credential epoch changed while onboarding save was pending",
    );
  }
  assertOpaqueRevision(confirmedCredentialRevision, false);
  if (confirmedCredentialRevision === recovery.expectedCredentialRevision) {
    throw new OnboardingSaveConflictError(
      "Credential revision did not change after the write",
    );
  }

  return {
    ...config,
    credentialEpoch: config.credentialEpoch + 1,
    onboarding: {
      ...config.onboarding,
      saveRecovery: {
        ...recovery,
        phase: "settings-write-pending",
        confirmedCredentialRevision,
      },
    },
  };
}

/**
 * Completes the idempotent Settings half of onboarding after Credential write
 * confirmation. Calling it again with no recovery marker is intentionally a
 * no-op so crash recovery can safely replay the Settings commit.
 */
export function completeOnboardingSave(
  config: PluginConfig,
  operationId: string,
): PluginConfig {
  const recovery = config.onboarding.saveRecovery;
  if (recovery === null) {
    return config;
  }
  if (recovery.operationId !== operationId) {
    throw new OnboardingSaveConflictError(
      "Onboarding save operation does not match the pending operation",
    );
  }
  if (recovery.phase !== "settings-write-pending") {
    throw new OnboardingSaveConflictError(
      "Credential write must be confirmed before Settings can be committed",
    );
  }

  return {
    ...config,
    services: applyToggles(config.services, recovery.intendedServices),
    onboarding: {
      status: "completed",
      saveRecovery: null,
    },
  };
}

export function deferOnboarding(
  config: PluginConfig,
  intendedServices: ServiceToggles = getServiceToggles(config),
): PluginConfig {
  if (config.onboarding.saveRecovery !== null) {
    throw new OnboardingSaveConflictError(
      "A pending Credential save must be reconciled before onboarding is deferred",
    );
  }

  return {
    ...config,
    services: applyToggles(config.services, intendedServices),
    onboarding: {
      status: "deferred",
      saveRecovery: null,
    },
  };
}

/**
 * Determines the safe restart action from descriptor revision only. A missing
 * revision is deliberately ambiguous and requires user reconciliation; it is
 * never treated as proof that a Credential write failed.
 */
export function reconcileOnboardingSave(
  config: PluginConfig,
  currentCredentialRevision: string | null,
): OnboardingRecoveryDecision {
  const recovery = config.onboarding.saveRecovery;
  if (recovery === null) {
    return { config, action: "none" };
  }
  assertOpaqueRevision(currentCredentialRevision);

  if (recovery.phase === "settings-write-pending") {
    return { config, action: "commit-intended-settings" };
  }
  if (currentCredentialRevision === null) {
    return { config, action: "needs-user-reconciliation" };
  }
  if (currentCredentialRevision === recovery.expectedCredentialRevision) {
    return { config, action: "await-credential-write" };
  }

  return {
    config: markOnboardingCredentialSaved(
      config,
      recovery.operationId,
      currentCredentialRevision,
    ),
    action: "commit-intended-settings",
  };
}

export function advanceCredentialEpoch(config: PluginConfig): PluginConfig {
  if (config.onboarding.saveRecovery !== null) {
    throw new OnboardingSaveConflictError(
      "Cannot perform an unrelated Credential mutation during onboarding save",
    );
  }
  return { ...config, credentialEpoch: config.credentialEpoch + 1 };
}

function applyToggles(
  services: ServicesConfig,
  toggles: ServiceToggles,
): ServicesConfig {
  return {
    design: { ...services.design, enabled: toggles.design },
    llm: { ...services.llm, enabled: toggles.llm },
    web: { ...services.web, enabled: toggles.web },
  };
}

function copyToggles(toggles: ServiceToggles): ServiceToggles {
  return {
    design: Boolean(toggles.design),
    llm: Boolean(toggles.llm),
    web: Boolean(toggles.web),
  };
}

function requireRecovery(
  config: PluginConfig,
  operationId: string,
): OnboardingSaveRecovery {
  const recovery = config.onboarding.saveRecovery;
  if (recovery === null || recovery.operationId !== operationId) {
    throw new OnboardingSaveConflictError(
      "Onboarding save operation does not match the pending operation",
    );
  }
  return recovery;
}

function migrateSaveRecovery(input: unknown): OnboardingSaveRecovery | null {
  if (!isRecord(input)) {
    return null;
  }
  const operationId = safeOperationId(input.operationId);
  const phase = savePhase(input.phase);
  const intendedServices = migrateToggles(input.intendedServices);
  const expectedCredentialEpoch = optionalNonNegativeInteger(
    input.expectedCredentialEpoch,
  );
  const expectedCredentialRevision = optionalOpaqueRevision(
    input.expectedCredentialRevision,
  );
  const confirmedCredentialRevision = optionalOpaqueRevision(
    input.confirmedCredentialRevision,
  );
  const startedAt = optionalTimestamp(input.startedAt);

  if (
    operationId === null ||
    phase === null ||
    intendedServices === null ||
    expectedCredentialEpoch === null ||
    startedAt === null
  ) {
    return null;
  }
  if (phase === "settings-write-pending" && confirmedCredentialRevision === null) {
    return null;
  }

  return {
    operationId,
    phase,
    intendedServices,
    expectedCredentialEpoch,
    expectedCredentialRevision,
    confirmedCredentialRevision,
    startedAt,
  };
}

function migrateToggles(input: unknown): ServiceToggles | null {
  if (!isRecord(input)) {
    return null;
  }
  if (
    typeof input.design !== "boolean" ||
    typeof input.llm !== "boolean" ||
    typeof input.web !== "boolean"
  ) {
    return null;
  }
  return copyToggles({
    design: input.design,
    llm: input.llm,
    web: input.web,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serviceRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "boolean") {
    return { enabled: value };
  }
  return isRecord(value) ? value : {};
}

function explicitBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function retentionPolicy(
  _value: unknown,
): RetentionPolicy {
  // Older development builds exposed retain-input even though the task WAL
  // has always persisted metadata only. Accept any persisted legacy value at
  // the migration boundary, but never expose or re-persist it as active state.
  return "metadata-only";
}

function migrateLlmRouteOwnership(input: unknown): LlmRouteOwnershipConfig {
  const empty = createDefaultConfig().llmOwnership.route;
  if (!isRecord(input)) return empty;
  const ownership = input.ownership === "created" || input.ownership === "adopted"
    ? input.ownership
    : "none";
  const appliedRouteFingerprint = safeFingerprint(input.appliedRouteFingerprint);
  const entries = Array.isArray(input.entries)
    ? input.entries.slice(0, 10_000).flatMap((value): LlmRouteOwnershipEntry[] => {
        if (!isRecord(value)) return [];
        const kind = value.kind === "field" || value.kind === "model" ? value.kind : null;
        const key = typeof value.key === "string" && isSafeBoundedText(value.key, 256)
          ? value.key
          : null;
        const appliedFingerprint = safeFingerprint(value.appliedFingerprint);
        return kind === null || key === null || appliedFingerprint === null
          ? []
          : [{ kind, key, appliedFingerprint }];
      })
    : [];
  return ownership === "none" || appliedRouteFingerprint === null
    ? empty
    : { ownership, appliedRouteFingerprint, entries };
}

function migrateLlmMaterializationRecovery(
  input: unknown,
  present: boolean,
): LlmMaterializationRecovery | null {
  if (!present || input === null) return null;
  if (!isRecord(input)) {
    throw new TypeError("llmOwnership.materializationRecovery is malformed");
  }
  const operationId = safeOperationId(input.operationId);
  const startedAt = optionalTimestamp(input.startedAt);
  const expectedLlmSettingsRevision = optionalNonNegativeInteger(
    input.expectedLlmSettingsRevision,
  );
  const previousRouteFingerprint = safeFingerprint(input.previousRouteFingerprint);
  const migratedTarget = input.targetRouteOwnership === undefined
    ? null
    : migrateLlmRouteOwnership(input.targetRouteOwnership);
  const targetRouteOwnership = migratedTarget?.ownership === "none"
    ? null
    : migratedTarget;
  if (operationId === null || startedAt === null || expectedLlmSettingsRevision === null) {
    throw new TypeError("llmOwnership.materializationRecovery is malformed");
  }
  return {
    operationId,
    startedAt,
    expectedLlmSettingsRevision,
    previousRouteFingerprint,
    targetRouteOwnership,
  };
}

function copyLlmRouteOwnership(
  route: LlmRouteOwnershipConfig,
): LlmRouteOwnershipConfig {
  const migrated = migrateLlmRouteOwnership(route);
  if (
    migrated.ownership !== route.ownership ||
    migrated.appliedRouteFingerprint !== route.appliedRouteFingerprint ||
    migrated.entries.length !== route.entries.length
  ) {
    throw new TypeError("targetRouteOwnership is malformed");
  }
  return {
    ownership: migrated.ownership,
    appliedRouteFingerprint: migrated.appliedRouteFingerprint,
    entries: migrated.entries.map((entry) => ({ ...entry })),
  };
}

function requireLlmMaterializationRecovery(
  config: PluginConfig,
  operationId: string,
): LlmMaterializationRecovery {
  const recovery = config.llmOwnership.materializationRecovery;
  if (recovery === null || recovery.operationId !== operationId) {
    throw new LlmMaterializationConflictError(
      "LLM materialization operation does not match the pending operation",
    );
  }
  return recovery;
}

function modelIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const candidate of value.slice(0, 100)) {
    const id = optionalModelId(candidate);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return output;
}

function optionalModelId(value: unknown): string | null {
  return typeof value === "string" && value.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(value)
    ? value
    : null;
}

function safeFingerprint(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function isSafeBoundedText(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && !hasControlCharacters(value);
}

function onboardingStatus(
  value: unknown,
  fallback: OnboardingStatus,
): OnboardingStatus {
  return value === "active" || value === "completed" || value === "deferred"
    ? value
    : fallback;
}

function savePhase(value: unknown): OnboardingSavePhase | null {
  return value === "credential-write-pending" ||
    value === "settings-write-pending"
    ? value
    : null;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : fallback;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : fallback;
}

function optionalTimestamp(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function safeOperationId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value)
    ? value
    : null;
}

function optionalOpaqueRevision(value: unknown): string | null {
  return value === null || value === undefined
    ? null
    : typeof value === "string" &&
        value.length > 0 &&
        value.length <= 256 &&
        !hasControlCharacters(value)
      ? value
      : null;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

function assertOperationId(value: string): void {
  if (safeOperationId(value) === null) {
    throw new TypeError("operationId must contain 8-128 safe characters");
  }
}

function assertTimestamp(value: number): void {
  if (optionalTimestamp(value) === null) {
    throw new TypeError("startedAt must be a non-negative safe integer");
  }
}

function assertOpaqueRevision(
  value: string | null,
  allowNull = true,
): void {
  if (value === null && allowNull) {
    return;
  }
  if (optionalOpaqueRevision(value) === null) {
    throw new TypeError("Credential revision must be a bounded opaque value");
  }
}
