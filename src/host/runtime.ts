import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import type { ConnectionRpcResult as RpcResult } from "@deepseek-ai/dsh-client-connection";
import { SettingsConflictError, type SettingsNamespace } from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-credentials";
import type {} from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-storage-domain";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-web";

import {
  MODELLIX_CREDENTIAL_REF,
  CredentialEpochConflictError,
  abandonLlmMaterialization,
  applyCredentialDescriptor,
  applyRuntimeUnauthorized,
  applyVerificationResult,
  beginOnboardingSave,
  beginLlmMaterialization,
  completeLlmMaterialization,
  completeOnboardingSave,
  createCredentialState,
  deferOnboarding,
  deriveModellixUserId,
  getServiceToggles,
  isCredentialInvalidError,
  markOnboardingCredentialSaved,
  setServiceToggles,
  type CredentialDescriptor,
  type CredentialState,
  type PluginConfig,
  type ServiceToggles,
} from "../core/index.js";
import { DesignError, type StoragePort } from "../design/index.js";
import {
  LlmCatalogCache,
  LlmCatalogClient,
  LlmCatalogRequestError,
  LlmRouteConflictError,
  LlmSettingsMaterializer,
  StaleLlmCatalogError,
  verifyLlmRegistryBackread,
  type LlmMaterializationReceipt,
  type LlmRouteLedger,
} from "../llm/index.js";
import { createModellixWebProviders } from "../web/index.js";
import {
  CredentialBroker,
  CredentialValidationError,
  type HarnessCredentialPort,
} from "./credential-broker.js";
import { DesignHostController } from "./design-controller.js";
import { createModellixRoutingMessage } from "./agent-routing-context.js";
import { openDesignStorage, type ModellixDesignDomain } from "./design-storage.js";
import { registerModellixDesignTools } from "./design-tool.js";
import { registerModellixWebTools } from "./web-tool.js";
import {
  PluginSettingsController,
  type SettingsServiceLike,
} from "./settings.js";

const RPC_CHANNEL = "/modellix";

/** rc.2 accepted an authority option; alpha.4 owns trust in Connection itself. */
interface CompatibleConnectionRpc {
  handle(
    channel: string,
    handler: (
      endpoint: string,
      payload: unknown,
      signal: AbortSignal,
    ) => Promise<RpcResult<unknown>>,
    options?: { readonly authority: "loopback" },
  ): () => Promise<void> | void;
}
const LLM_SETTINGS_NAMESPACE = "llm-pi-ai" as SettingsNamespace;
const LLM_OWNERSHIP_ROLLBACK_FAILED = "MODELLIX_LLM_OWNERSHIP_ROLLBACK_FAILED";
const LLM_MATERIALIZATION_RECOVERED = "MODELLIX_LLM_MATERIALIZATION_RECOVERED";
const LLM_MATERIALIZATION_RECOVERY_FAILED = "MODELLIX_LLM_MATERIALIZATION_RECOVERY_FAILED";
const LLM_PROVENANCE_CLEANUP_FAILED = "MODELLIX_LLM_PROVENANCE_CLEANUP_FAILED";

class LlmOwnershipRollbackFailure extends Error {
  constructor() {
    super("The LLM settings rollback failed after the ownership ledger was not committed");
    this.name = "LlmOwnershipRollbackFailure";
  }
}

class LlmMaterializationRecoveryFailure extends Error {
  constructor() {
    super("The pending LLM materialization could not be recovered safely");
    this.name = "LlmMaterializationRecoveryFailure";
  }
}

export interface ModellixRuntimeState {
  readonly version: 1;
  readonly settingsRevision: number;
  readonly services: ServiceToggles;
  readonly credential: CredentialDescriptor & {
    readonly verification: CredentialState["verification"];
    readonly invalidEpoch: number | null;
  };
  readonly onboarding: {
    readonly status: PluginConfig["onboarding"]["status"];
    readonly recoveryPending: boolean;
    /** Non-secret, process-local token for the latest explicit capability recovery request. */
    readonly recoveryRequestId: string | null;
  };
  readonly llm: {
    readonly health: "unknown" | "ready" | "missing" | "disabled" | "error" | "policy-blocked";
    readonly modelCount: number;
    readonly refreshedAt: number | null;
  };
}

interface LlmRuntimeState {
  health: ModellixRuntimeState["llm"]["health"];
  modelCount: number;
  refreshedAt: number | null;
}

/** Host composition root; every Secret-bearing operation terminates here. */
export class ModellixRuntime {
  readonly #ctx: Context;
  readonly #settings: PluginSettingsController;
  readonly #credential: CredentialBroker;
  readonly #catalog: LlmCatalogCache;
  readonly #materializer: LlmSettingsMaterializer;
  readonly #design: DesignHostController;
  readonly #designDomain: ModellixDesignDomain;
  readonly #userId: string;
  #config: PluginConfig;
  #credentialState: CredentialState;
  #llm: LlmRuntimeState = { health: "unknown", modelCount: 0, refreshedAt: null };
  #writeTail: Promise<void> = Promise.resolve();
  #designTail: Promise<void> = Promise.resolve();
  #credentialMutationInFlight = false;
  #credentialRecoveryRequestId: string | null = null;
  #designPollTimer: ReturnType<typeof setTimeout> | undefined;
  #disposeDesignTools: (() => void) | undefined;
  #disposeWebTools: (() => void) | undefined;
  #closing = false;
  readonly #lifecycleAbort = new AbortController();

  static async create(ctx: Context): Promise<ModellixRuntime> {
    const settings = new PluginSettingsController(ctx.settings as unknown as SettingsServiceLike);
    const initial = settings.read().config;
    const ref = credentialRef(MODELLIX_CREDENTIAL_REF);
    const credentialPort: HarnessCredentialPort = {
      resolve: async () => ctx.credentials.resolve(ref),
      describe: async () => ctx.credentials.describe(ref),
      set: async (_ignored, value) => ctx.credentials.set(ref, value),
      unset: async () => ctx.credentials.unset(ref),
    };
    const credential = new CredentialBroker({
      credentials: credentialPort,
      initialCredentialEpoch: initial.credentialEpoch,
    });
    const designStorage = await openDesignStorage(ctx);
    const runtime = new ModellixRuntime(
      ctx,
      settings,
      credential,
      initial,
      designStorage.domain,
      designStorage.storage,
    );
    try {
      await runtime.initialize();
      return runtime;
    } catch (error) {
      await designStorage.domain.close();
      throw error;
    }
  }

  private constructor(
    ctx: Context,
    settings: PluginSettingsController,
    credential: CredentialBroker,
    initial: PluginConfig,
    designDomain: ModellixDesignDomain,
    designStorage: StoragePort,
  ) {
    this.#ctx = ctx;
    this.#settings = settings;
    this.#credential = credential;
    this.#designDomain = designDomain;
    this.#config = initial;
    this.#credentialState = createCredentialState({
      configured: false,
      source: null,
      writable: false,
      revision: null,
      credentialEpoch: initial.credentialEpoch,
    });
    this.#userId = deriveModellixUserId(String(getOrCreateAnonymousUserId()));
    const catalogClient = new LlmCatalogClient({
      resolveCredential: () => this.resolveUsableCredential(),
    });
    this.#catalog = new LlmCatalogCache(catalogClient);
    this.#materializer = new LlmSettingsMaterializer({
      describe: async () => {
        const descriptor = this.#ctx.settings.describe({ redactSecrets: true })
          .find((candidate) => candidate.ns === LLM_SETTINGS_NAMESPACE);
        return descriptor === undefined
          ? undefined
          : {
            revision: descriptor.revision,
            value: descriptor.value,
            ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
            ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
          };
      },
      mutate: (operations, expectedRevision) => this.#ctx.settings.mutate(
        LLM_SETTINGS_NAMESPACE,
        operations,
        expectedRevision,
      ),
    });
    this.#design = new DesignHostController({
      storage: designStorage,
      resolveCredential: () => this.resolveUsableCredential(),
      isCredentialEpochCurrent: (epoch) => epoch === this.#credential.credentialEpoch,
      onUnauthorized: (epoch) => {
        this.markCredentialRejected(epoch);
      },
      isEnabled: () => this.#config.services.design.enabled,
      getLastModel: () => this.#config.services.design.lastModel,
      rememberModel: (modelId) => this.rememberDesignModel(modelId),
    });
  }

  private async initialize(): Promise<void> {
    this.#credentialState = applyCredentialDescriptor(
      this.#credentialState,
      await this.#credential.describe(),
    );
    const llmRecoveryReady = await this.reconcileInterruptedLlmMaterialization();
    await this.reconcileMissingCredentialState();
    this.syncDesignTools(this.#config.services.design.enabled);
    this.#ctx.effect(() => this.#settings.watch((next, previous) => {
      if (this.#closing) return undefined;
      this.#config = next;
      this.#catalog.invalidate();
      if (next.services.design.enabled !== previous.services.design.enabled) {
        this.syncDesignTools(next.services.design.enabled);
        if (next.services.design.enabled) this.scheduleDesignPoll(0);
      }
      if (next.services.web.enabled !== previous.services.web.enabled) {
        this.syncWebTools(next.services.web.enabled);
      }
      if (
        next.services.llm.enabled !== previous.services.llm.enabled ||
        next.credentialEpoch !== previous.credentialEpoch
      ) {
        return this.enqueueWrite(() => this.reconcileLiveSettings());
      }
      return undefined;
    }), "dsh-modellix: live settings snapshot");

    this.#ctx.on("credentials/reference-updated", (updated) => {
      if (
        this.#closing || String(updated) !== MODELLIX_CREDENTIAL_REF ||
        this.#credentialMutationInFlight
      ) return;
      return this.enqueueWrite(async () => {
        const snapshot = this.#settings.read();
        const observed = await this.#credential.describe();
        const nextEpoch = Math.max(snapshot.config.credentialEpoch, this.#credential.credentialEpoch) + 1;
        this.#credential.synchronizeRecoveredEpoch(nextEpoch);
        const removedCompletedCredential =
          !observed.configured && snapshot.config.onboarding.status === "completed" &&
          snapshot.config.onboarding.saveRecovery === null;
        await this.#settings.replace({
          ...snapshot.config,
          credentialEpoch: nextEpoch,
          ...(removedCompletedCredential
            ? { onboarding: { status: "active", saveRecovery: null } }
            : {}),
        }, snapshot.revision);
        this.#config = this.#settings.read().config;
        this.#credentialState = applyCredentialDescriptor(
          this.#credentialState,
          await this.#credential.describe(),
        );
        this.#catalog.invalidate();
        this.#llm = { health: "unknown", modelCount: 0, refreshedAt: null };
        if (this.#config.services.llm.enabled && this.credentialIsUsable()) {
          await this.refreshLlm(false, this.#lifecycleAbort.signal).catch(() => undefined);
        }
        this.scheduleDesignPoll(0);
      });
    });

    this.#ctx.effect(() => {
      this.syncWebTools(this.#config.services.web.enabled);
      return () => {
        this.#disposeWebTools?.();
        this.#disposeWebTools = undefined;
      };
    }, "dsh-modellix: explicit Modellix Web tools");

    this.#ctx.on("agent/session-start", ({ agent }) => {
      const message = createModellixRoutingMessage({
        mediaEnabled: this.#config.services.design.enabled && this.credentialIsUsable(),
        webEnabled: this.#config.services.web.enabled && this.credentialIsUsable(),
      });
      if (message !== null) agent.inject(message);
    });

    const connectionRpc = this.#ctx.connection.rpc as unknown as CompatibleConnectionRpc;
    this.#ctx.effect(() => connectionRpc.handle(
      RPC_CHANNEL,
      (endpoint, payload, signal) => this.handleRpc(endpoint, payload, signal),
      { authority: "loopback" },
    ), "dsh-modellix: loopback configuration and Design RPC");

    this.#ctx.effect(() => {
      this.scheduleDesignPoll(2_000);
      return async () => {
        this.#closing = true;
        this.#lifecycleAbort.abort();
        this.#disposeDesignTools?.();
        this.#disposeDesignTools = undefined;
        if (this.#designPollTimer !== undefined) clearTimeout(this.#designPollTimer);
        await Promise.all([this.#writeTail, this.#designTail]);
        await this.#designDomain.close();
      };
    }, "dsh-modellix: Design repository and polling");

    if (!llmRecoveryReady) this.#llm.health = "error";
    else if (!this.#config.services.llm.enabled) this.#llm.health = "disabled";
    else if (!this.#credentialState.descriptor.configured) this.#llm.health = "missing";
    else if (!this.credentialIsUsable()) this.#llm.health = "error";
    else void this.enqueueWrite(
      () => this.refreshLlm(false, this.#lifecycleAbort.signal).then(() => undefined),
    ).catch(() => undefined);
  }

  private async handleRpc(endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult<unknown>> {
    const operationSignal = AbortSignal.any([signal, this.#lifecycleAbort.signal]);
    if (this.#closing || operationSignal.aborted) return cancelled();
    if (!isRecord(payload) || payload.version !== 1) {
      return badRequest("Unsupported Modellix RPC version");
    }
    try {
      switch (endpoint) {
        case "state/get":
          return success(await this.state());
        case "credential/save":
          return success(await this.saveCredential(payload, operationSignal));
        case "credential/remove":
          return success(await this.removeCredential(payload));
        case "onboarding/defer":
          return success(await this.defer(payload));
        case "settings/toggles":
          return success(await this.updateToggles(payload));
        case "llm/refresh":
          return success(await this.refreshLlmRpc(operationSignal));
        default:
          if (endpoint.startsWith("design/")) {
            if (designEndpointRequestsCredential(endpoint) && !this.credentialIsUsable()) {
              this.requestCredentialRecovery();
            }
            const snapshot = await this.enqueueDesignWrite(
              () => this.#design.handle(endpoint, payload, operationSignal),
            );
            this.scheduleDesignPoll(5_000);
            return success({ version: 1, accepted: true, state: snapshot });
          }
          return badRequest("Unknown Modellix endpoint");
      }
    } catch (error) {
      // A paid Design POST may have been accepted before the caller aborted.
      // Preserve the domain's non-replayable outcome before the generic RPC
      // cancellation mapping, otherwise a proposal can be billed twice.
      if (error instanceof DesignError && error.code === "SUBMIT_UNKNOWN") {
        return success({
          version: 1,
          accepted: false,
          error: { code: designRpcErrorCode(error) },
        });
      }
      if (operationSignal.aborted || isAbortFailure(error)) return cancelled();
      if (error instanceof CredentialEpochConflictError) {
        return success({
          version: 1,
          accepted: false,
          reason: "credential-changed",
          state: await this.state(),
        });
      }
      if (error instanceof SettingsConflictError) {
        return success({
          version: 1,
          accepted: false,
          reason: "settings-changed",
          state: await this.state(),
        });
      }
      if (error instanceof CredentialValidationError || error instanceof LlmCatalogRequestError) {
        return success({ version: 1, accepted: false, error: error.contract });
      }
      if (error instanceof DesignError) {
        return success({
          version: 1,
          accepted: false,
          error: { code: designRpcErrorCode(error) },
        });
      }
      if (error instanceof StaleLlmCatalogError) {
        return success({ version: 1, accepted: false, reason: "credential-changed" });
      }
      return internalError();
    }
  }

  private async state(): Promise<ModellixRuntimeState> {
    const snapshot = this.#settings.read();
    this.#config = snapshot.config;
    this.#credentialState = applyCredentialDescriptor(
      this.#credentialState,
      await this.#credential.describe(),
    );
    const credential = this.#credentialState;
    if (credential.descriptor.configured && credential.verification !== "invalid") {
      this.clearCredentialRecoveryRequest();
    }
    return {
      version: 1,
      settingsRevision: snapshot.revision,
      services: getServiceToggles(this.#config),
      credential: {
        ...credential.descriptor,
        verification: credential.verification,
        invalidEpoch: credential.invalidEpoch?.credentialEpoch ?? null,
      },
      onboarding: {
        status: this.#config.onboarding.status,
        recoveryPending: this.#config.onboarding.saveRecovery !== null,
        recoveryRequestId: this.#credentialRecoveryRequestId,
      },
      llm: { ...this.#llm },
    };
  }

  private saveCredential(payload: unknown, signal: AbortSignal): Promise<unknown> {
    const request = parseCredentialSave(payload);
    return this.enqueueWrite(async () => {
      let snapshot = this.#settings.read();
      if (this.#credential.credentialEpoch !== request.expectedCredentialEpoch) {
        return {
          version: 1,
          accepted: false,
          reason: "credential-changed",
          state: await this.state(),
        };
      }
      await this.#credential.validateCandidate(request.apiKey, signal);

      // A resubmission is the recovery protocol for the two-store write. The
      // comparison remains Host-local and neither Credential value is retained.
      if (snapshot.config.onboarding.saveRecovery !== null) {
        const recovery = snapshot.config.onboarding.saveRecovery;
        const stored = await this.#credential.resolve();
        if (stored?.value === request.apiKey) {
          let recovered = snapshot.config;
          if (recovery.phase === "credential-write-pending") {
            const recoveredEpoch = snapshot.config.credentialEpoch + 1;
            if (this.#credential.credentialEpoch > recoveredEpoch) {
              throw new CredentialEpochConflictError(
                recoveredEpoch,
                this.#credential.credentialEpoch,
              );
            }
            this.#credential.synchronizeRecoveredEpoch(recoveredEpoch);
            recovered = markOnboardingCredentialSaved(
              recovered,
              recovery.operationId,
              `epoch:${String(recoveredEpoch)}`,
            );
          }
          const completed = setServiceToggles(
            completeOnboardingSave(recovered, recovery.operationId),
            request.services,
          );
          await this.#settings.replace(completed, snapshot.revision);
          this.#config = this.#settings.read().config;
          this.#credentialState = applyCredentialDescriptor(
            this.#credentialState,
            await this.#credential.describe(),
          );
          this.#credentialState = applyVerificationResult(
            this.#credentialState,
            this.#credential.credentialEpoch,
            "valid",
          ).state;
          this.clearCredentialRecoveryRequest();
          this.#catalog.invalidate();
          if (this.#config.services.llm.enabled) {
            await this.refreshLlm(false, this.#lifecycleAbort.signal).catch(() => undefined);
          }
          return { version: 1, accepted: true, state: await this.state() };
        }

        // The user deliberately supplied a different valid Key. Record any
        // already-observed mutation epoch, abandon only the non-secret intent,
        // then perform a fresh serialized save below.
        await this.#settings.replace({
          ...snapshot.config,
          credentialEpoch: this.#credential.credentialEpoch,
          onboarding: { status: "active", saveRecovery: null },
        }, snapshot.revision);
        snapshot = this.#settings.read();
      }
      this.#credentialState = applyCredentialDescriptor(
        this.#credentialState,
        await this.#credential.describe(),
      );
      const operationId = `save_${randomUUID().replaceAll("-", "")}`;
      const started = beginOnboardingSave(snapshot.config, {
        operationId,
        startedAt: Date.now(),
        intendedServices: request.services,
        expectedCredentialRevision: this.#credentialState.descriptor.revision,
      });
      await this.#settings.replace(started, snapshot.revision);

      this.#credentialMutationInFlight = true;
      let mutation: Awaited<ReturnType<CredentialBroker["set"]>>;
      try {
        mutation = await this.#credential.set(request.apiKey, request.expectedCredentialEpoch);
      } finally {
        this.#credentialMutationInFlight = false;
      }
      const confirmedCredential = await this.#credential.resolve();
      if (confirmedCredential?.value !== request.apiKey) {
        throw new Error("Credential changed before the onboarding save was confirmed");
      }

      snapshot = this.#settings.read();
      const marked = markOnboardingCredentialSaved(
        snapshot.config,
        operationId,
        `epoch:${String(mutation.credentialEpoch)}`,
      );
      const completed = completeOnboardingSave(marked, operationId);
      await this.#settings.replace(completed, snapshot.revision);
      this.#config = this.#settings.read().config;
      this.#credentialState = applyCredentialDescriptor(
        this.#credentialState,
        await this.#credential.describe(),
      );
      this.#credentialState = applyVerificationResult(
        this.#credentialState,
        mutation.credentialEpoch,
        "valid",
      ).state;
      this.clearCredentialRecoveryRequest();
      this.#catalog.invalidate();
      if (this.#config.services.llm.enabled) {
        await this.refreshLlm(false, this.#lifecycleAbort.signal).catch(() => undefined);
      }
      return { version: 1, accepted: true, state: await this.state() };
    });
  }

  private removeCredential(payload: unknown): Promise<unknown> {
    const expectedCredentialEpoch = parseExpectedEpoch(payload);
    return this.enqueueWrite(async () => {
      const snapshot = this.#settings.read();
      if (this.#credential.credentialEpoch !== expectedCredentialEpoch) {
        return {
          version: 1,
          accepted: false,
          reason: "credential-changed",
          state: await this.state(),
        };
      }
      this.#credentialMutationInFlight = true;
      let mutation: Awaited<ReturnType<CredentialBroker["unset"]>>;
      try {
        mutation = await this.#credential.unset(expectedCredentialEpoch);
      } catch (error) {
        // Credential providers may durably delete the local value and still
        // reject while publishing or acknowledging the mutation. A fresh
        // descriptor is the only authoritative, non-secret recovery signal;
        // never replay unset merely to obtain a successful acknowledgement.
        const observed = await this.#credential.describe().catch(() => undefined);
        if (observed?.configured !== false) throw error;
        const recoveredCredentialEpoch = expectedCredentialEpoch + 1;
        this.#credential.synchronizeRecoveredEpoch(recoveredCredentialEpoch);
        mutation = {
          value: undefined,
          previousEpoch: expectedCredentialEpoch,
          credentialEpoch: recoveredCredentialEpoch,
        };
      } finally {
        this.#credentialMutationInFlight = false;
      }
      if (await this.#credential.resolve() !== undefined) {
        throw new Error("Credential changed before removal was confirmed");
      }
      // From this point Credential absence is authoritative. Publish that fact
      // in process before touching the independently-owned LLM/Settings stores,
      // so a downstream failure cannot leave subsequent saves using the stale
      // descriptor generation.
      this.#credentialState = applyCredentialDescriptor(
        this.#credentialState,
        await this.#credential.describe(),
      );
      try {
        const withoutRoute = await this.#materializer.remove(toLlmLedger(snapshot.config));
        await this.#settings.replace({
          ...snapshot.config,
          credentialEpoch: mutation.credentialEpoch,
          onboarding: { status: "active", saveRecovery: null },
          llmOwnership: { ...snapshot.config.llmOwnership, route: withoutRoute },
        }, snapshot.revision);
      } catch (error) {
        // The same idempotent reconciliation used at startup also closes the
        // post-unset window immediately. It never replays the destructive
        // Credential mutation and leaves the ownership ledger intact when the
        // external LLM namespace is still unavailable.
        await this.reconcileMissingCredentialState(mutation.credentialEpoch).catch(() => undefined);
        this.#catalog.invalidate();
        this.#llm = {
          health: this.#credentialState.descriptor.configured ? "error" : "missing",
          modelCount: 0,
          refreshedAt: null,
        };
        throw error;
      }
      this.#config = this.#settings.read().config;
      this.#credentialState = applyCredentialDescriptor(
        this.#credentialState,
        await this.#credential.describe(),
      );
      this.clearCredentialRecoveryRequest();
      this.#catalog.invalidate();
      this.#llm = {
        health: this.#credentialState.descriptor.configured ? "error" : "missing",
        modelCount: 0,
        refreshedAt: null,
      };
      return { version: 1, accepted: true, state: await this.state() };
    });
  }

  private defer(payload: unknown): Promise<unknown> {
    const request = requireRecord(payload);
    const services = parseToggles(request);
    const expectedSettingsRevision = parseExpectedSettingsRevision(request);
    return this.enqueueWrite(async () => {
      const snapshot = this.#settings.read();
      if (snapshot.revision !== expectedSettingsRevision) {
        return { version: 1, accepted: false, reason: "settings-changed", state: await this.state() };
      }
      const next = deferOnboarding(snapshot.config, services);
      await this.#settings.replace(next, snapshot.revision);
      this.#config = this.#settings.read().config;
      return { version: 1, accepted: true, state: await this.state() };
    });
  }

  private updateToggles(payload: unknown): Promise<unknown> {
    const request = requireRecord(payload);
    const services = parseToggles(request);
    const expectedSettingsRevision = parseExpectedSettingsRevision(request);
    return this.enqueueWrite(async () => {
      const snapshot = this.#settings.read();
      if (snapshot.revision !== expectedSettingsRevision) {
        return { version: 1, accepted: false, reason: "settings-changed", state: await this.state() };
      }
      let next = setServiceToggles(snapshot.config, services);
      if (!services.llm) {
        const ledger = await this.#materializer.remove(toLlmLedger(snapshot.config));
        next = { ...next, llmOwnership: { ...next.llmOwnership, route: ledger } };
        this.#llm = { health: "disabled", modelCount: 0, refreshedAt: null };
      }
      await this.#settings.replace(next, snapshot.revision);
      this.#config = this.#settings.read().config;
      if (services.llm && this.credentialIsUsable()) {
        await this.refreshLlm(false, this.#lifecycleAbort.signal).catch(() => undefined);
      }
      if (services.design) this.scheduleDesignPoll(0);
      return { version: 1, accepted: true, state: await this.state() };
    });
  }

  private async refreshLlmRpc(signal: AbortSignal): Promise<unknown> {
    return this.enqueueWrite(async () => {
      if (!this.credentialIsUsable()) this.requestCredentialRecovery();
      const result = await this.refreshLlm(true, signal);
      if (isRecord(result) && result.accepted === false) return result;
      return { version: 1, accepted: true, state: await this.state() };
    });
  }

  private async reconcileLiveSettings(): Promise<void> {
    const snapshot = this.#settings.read();
    this.#config = snapshot.config;
    if (!snapshot.config.services.llm.enabled) {
      const ledger = await this.#materializer.remove(toLlmLedger(snapshot.config));
      if (!sameLlmLedger(ledger, snapshot.config.llmOwnership.route)) {
        await this.#settings.replace({
          ...snapshot.config,
          llmOwnership: { ...snapshot.config.llmOwnership, route: ledger },
        }, snapshot.revision);
        this.#config = this.#settings.read().config;
      }
      this.#llm = { health: "disabled", modelCount: 0, refreshedAt: null };
      return;
    }
    this.#credentialState = applyCredentialDescriptor(
      this.#credentialState,
      await this.#credential.describe(),
    );
    if (!this.credentialIsUsable()) {
      const ledger = await this.#materializer.remove(toLlmLedger(snapshot.config));
      if (!sameLlmLedger(ledger, snapshot.config.llmOwnership.route)) {
        await this.#settings.replace({
          ...snapshot.config,
          llmOwnership: { ...snapshot.config.llmOwnership, route: ledger },
        }, snapshot.revision);
        this.#config = this.#settings.read().config;
      }
      this.#llm = { health: "missing", modelCount: 0, refreshedAt: null };
      return;
    }
    await this.refreshLlm(false, this.#lifecycleAbort.signal).catch(() => undefined);
  }

  private async refreshLlm(force: boolean, signal?: AbortSignal): Promise<unknown> {
    if (!this.#config.services.llm.enabled) {
      this.#llm = { health: "disabled", modelCount: 0, refreshedAt: null };
      return { version: 1, accepted: false, reason: "disabled" };
    }
    if (!this.credentialIsUsable()) {
      const invalid = this.#credentialState.descriptor.configured;
      this.#llm = {
        health: invalid ? "error" : "missing",
        modelCount: 0,
        refreshedAt: null,
      };
      return {
        version: 1,
        accepted: false,
        reason: invalid ? "credential-invalid" : "credential-missing",
      };
    }
    const capturedEpoch = this.#config.credentialEpoch;
    try {
      if (this.#config.llmOwnership.materializationRecovery !== null) {
        const recovered = await this.reconcileInterruptedLlmMaterialization();
        if (!recovered) throw new LlmMaterializationRecoveryFailure();
      }
      signal?.throwIfAborted();
      const catalog = await this.#catalog.get(capturedEpoch, {
        force,
        ...(signal === undefined ? {} : { signal }),
      });
      signal?.throwIfAborted();
      if (this.#closing) throw new DOMException("Plugin is stopping", "AbortError");
      if (capturedEpoch !== this.#config.credentialEpoch) throw new StaleLlmCatalogError(
        capturedEpoch,
        this.#config.credentialEpoch,
      );
      const materializationOperationId = `llm_${randomUUID().replaceAll("-", "")}`;
      const materialization = await this.#materializer.prepareMaterialization(
        catalog.models,
        toLlmLedger(this.#config),
        materializationOperationId,
      );
      const ledger = materialization.ledger;
      const operationId = materialization.changed
        ? materializationOperationId
        : null;
      if (materialization.changed) {
        const intentSnapshot = this.#settings.read();
        if (
          intentSnapshot.config.credentialEpoch !== capturedEpoch ||
          !intentSnapshot.config.services.llm.enabled
        ) {
          throw new StaleLlmCatalogError(capturedEpoch, intentSnapshot.config.credentialEpoch);
        }
        await this.#settings.replace(beginLlmMaterialization(intentSnapshot.config, {
          operationId: materializationOperationId,
          startedAt: Date.now(),
          expectedLlmSettingsRevision: materialization.expectedSettingsRevision,
          previousRouteFingerprint: materialization.previousRouteFingerprint,
          targetRouteOwnership: ledger,
        }), intentSnapshot.revision);
        this.#config = this.#settings.read().config;
      }
      try {
        await materialization.apply();
      } catch (error) {
        await this.compensateLlmMaterialization(materialization, operationId);
        throw error;
      }
      // Once the write-ahead marker is durable, cancellation cannot split the
      // independent route and ownership stores. Finish verification plus the
      // ledger commit, or leave/clear recovery evidence after compensation.
      try {
        await verifyLlmRegistryBackread(this.#ctx.llm, catalog.models);
      } catch (error) {
        await this.compensateLlmMaterialization(materialization, operationId);
        throw error;
      }
      const snapshot = this.#settings.read();
      if (snapshot.config.credentialEpoch !== capturedEpoch || !snapshot.config.services.llm.enabled) {
        await this.compensateLlmMaterialization(materialization, operationId);
        throw new StaleLlmCatalogError(capturedEpoch, snapshot.config.credentialEpoch);
      }
      try {
        const committed = operationId === null
          ? {
              ...snapshot.config,
              llmOwnership: { ...snapshot.config.llmOwnership, route: ledger },
            }
          : completeLlmMaterialization(snapshot.config, operationId);
        await this.#settings.replace(committed, snapshot.revision);
      } catch (error) {
        const commitStatus = this.observeLlmOwnershipCommit(operationId, ledger);
        if (commitStatus !== "committed") {
          if (commitStatus === "pending") {
            await this.compensateLlmMaterialization(materialization, operationId);
          }
          throw error;
        }
        // A provider may report an ambiguous transport failure after the CAS
        // became durable. The read-back is authoritative; rolling back here
        // would split an already committed ledger from its route.
      }
      this.#config = this.#settings.read().config;
      if (operationId !== null) {
        await this.clearLlmProvenanceBestEffort(operationId);
      }
      this.#llm = { health: "ready", modelCount: catalog.models.length, refreshedAt: catalog.fetchedAt };
      this.#credentialState = applyVerificationResult(
        this.#credentialState,
        capturedEpoch,
        "valid",
      ).state;
      this.clearCredentialRecoveryRequest();
      if (signal?.aborted === true || this.#closing) {
        throw new DOMException("Plugin is stopping", "AbortError");
      }
      return { version: 1, accepted: true, modelCount: catalog.models.length, refreshedAt: catalog.fetchedAt };
    } catch (error) {
      if (isAbortFailure(error)) throw error;
      if (error instanceof LlmCatalogRequestError && isCredentialInvalidError(error.contract)) {
        this.markCredentialRejected(capturedEpoch);
      }
      this.#llm = {
        health: error instanceof StaleLlmCatalogError
          ? "unknown"
          : error instanceof LlmRouteConflictError
            ? "policy-blocked"
            : "error",
        modelCount: this.#llm.modelCount,
        refreshedAt: this.#llm.refreshedAt,
      };
      throw error;
    }
  }

  private async rollbackLlmMaterialization(
    materialization: LlmMaterializationReceipt,
  ): Promise<void> {
    try {
      await materialization.rollback();
    } catch {
      this.#llm = {
        health: "error",
        modelCount: this.#llm.modelCount,
        refreshedAt: this.#llm.refreshedAt,
      };
      try {
        this.#ctx.logger.error(
          `${LLM_OWNERSHIP_ROLLBACK_FAILED}: failed to restore the previous LLM settings snapshot`,
        );
      } catch {
        // Diagnostics must never prevent the safe non-ready state from sticking.
      }
      throw new LlmOwnershipRollbackFailure();
    }
  }

  private async compensateLlmMaterialization(
    materialization: LlmMaterializationReceipt,
    operationId: string | null,
  ): Promise<void> {
    await this.rollbackLlmMaterialization(materialization);
    if (operationId === null) return;
    try {
      await this.abandonPendingLlmMaterialization(operationId);
    } catch {
      this.recordLlmRecoveryDiagnostic(
        "error",
        `${LLM_MATERIALIZATION_RECOVERY_FAILED}: pending recovery marker could not be cleared`,
      );
      throw new LlmMaterializationRecoveryFailure();
    }
  }

  private observeLlmOwnershipCommit(
    operationId: string | null,
    ledger: LlmRouteLedger,
  ): "committed" | "pending" | "unknown" {
    if (operationId === null) return "unknown";
    try {
      const observed = this.#settings.read().config.llmOwnership;
      if (
        observed.materializationRecovery === null &&
        sameLlmLedger(ledger, observed.route)
      ) return "committed";
      return observed.materializationRecovery?.operationId === operationId
        ? "pending"
        : "unknown";
    } catch {
      return "unknown";
    }
  }

  private async abandonPendingLlmMaterialization(operationId: string): Promise<void> {
    const snapshot = this.#settings.read();
    const recovery = snapshot.config.llmOwnership.materializationRecovery;
    if (recovery === null) return;
    if (recovery.operationId !== operationId) throw new LlmMaterializationRecoveryFailure();
    await this.#settings.replace(
      abandonLlmMaterialization(snapshot.config, operationId),
      snapshot.revision,
    );
    this.#config = this.#settings.read().config;
  }

  private async reconcileInterruptedLlmMaterialization(): Promise<boolean> {
    const snapshot = this.#settings.read();
    const recovery = snapshot.config.llmOwnership.materializationRecovery;
    if (recovery === null) return true;
    try {
      if (
        recovery.previousRouteFingerprint === null ||
        recovery.targetRouteOwnership === null
      ) throw new LlmMaterializationRecoveryFailure();
      const recoveryResult = await this.#materializer.recoverInterruptedMaterialization({
        previousLedger: toLlmLedger(snapshot.config),
        targetLedger: toLlmLedgerFromOwnership(recovery.targetRouteOwnership),
        previousRouteFingerprint: recovery.previousRouteFingerprint,
        provenanceToken: recovery.operationId,
      });
      const current = this.#settings.read();
      const currentRecovery = current.config.llmOwnership.materializationRecovery;
      if (currentRecovery === null) {
        this.#config = current.config;
        return true;
      }
      if (currentRecovery.operationId !== recovery.operationId) {
        throw new LlmMaterializationRecoveryFailure();
      }
      await this.#settings.replace(recoveryResult.status === "applied"
        ? completeLlmMaterialization(current.config, recovery.operationId)
        : abandonLlmMaterialization(current.config, recovery.operationId), current.revision);
      this.#config = this.#settings.read().config;
      if (recoveryResult.status === "applied") {
        await this.clearLlmProvenanceBestEffort(recovery.operationId);
      }
      this.recordLlmRecoveryDiagnostic(
        "warn",
        recoveryResult.status === "applied"
          ? `${LLM_MATERIALIZATION_RECOVERED}: exact pending route ownership was committed`
          : `${LLM_MATERIALIZATION_RECOVERED}: unapplied pending route intent was cleared`,
      );
      return true;
    } catch {
      this.#llm = {
        health: "error",
        modelCount: this.#llm.modelCount,
        refreshedAt: this.#llm.refreshedAt,
      };
      this.recordLlmRecoveryDiagnostic(
        "error",
        `${LLM_MATERIALIZATION_RECOVERY_FAILED}: pending ownership remains unresolved`,
      );
      return false;
    }
  }

  private recordLlmRecoveryDiagnostic(level: "warn" | "error", message: string): void {
    try {
      this.#ctx.logger[level](message);
    } catch {
      // Fixed diagnostics are best effort and never carry the underlying error.
    }
  }

  private async clearLlmProvenanceBestEffort(operationId: string): Promise<void> {
    try {
      await this.#materializer.clearProvenance(operationId);
    } catch {
      // The route and ownership ledger are already committed. A stale opaque
      // token is harmless and a later materialization may replace it; never
      // roll back the committed route solely because cleanup raced another writer.
      this.recordLlmRecoveryDiagnostic(
        "warn",
        `${LLM_PROVENANCE_CLEANUP_FAILED}: committed recovery provenance was retained`,
      );
    }
  }

  /**
   * Finish an interrupted remove or an out-of-process Credential deletion.
   * An in-process caller supplies the exact confirmed Broker mutation epoch;
   * otherwise completed onboarding is the non-secret evidence that one
   * Credential generation disappeared while this process was offline.
   */
  private async reconcileMissingCredentialState(
    authoritativeCredentialEpoch?: number,
  ): Promise<void> {
    if (this.#credentialState.descriptor.configured) return;
    const snapshot = this.#settings.read();
    const lostConfiguredCredential =
      snapshot.config.onboarding.status === "completed" &&
      snapshot.config.onboarding.saveRecovery === null;
    const confirmedInProcessRemoval = authoritativeCredentialEpoch !== undefined;
    let ledger = toLlmLedger(snapshot.config);
    if (ledger.ownership !== "none") {
      try {
        ledger = await this.#materializer.remove(ledger);
      } catch {
        // Credential absence is authoritative even if the independently-owned
        // LLM namespace is not ready yet. Keeping the ledger makes cleanup
        // retryable on the next settings reconciliation or Host start.
      }
    }
    const nextEpoch = authoritativeCredentialEpoch ?? (lostConfiguredCredential
      ? snapshot.config.credentialEpoch + 1
      : snapshot.config.credentialEpoch);
    const nextOnboarding = confirmedInProcessRemoval || lostConfiguredCredential
      ? { status: "active" as const, saveRecovery: null }
      : snapshot.config.onboarding;
    if (
      nextEpoch !== snapshot.config.credentialEpoch ||
      nextOnboarding !== snapshot.config.onboarding ||
      !sameLlmLedger(ledger, snapshot.config.llmOwnership.route)
    ) {
      await this.#settings.replace({
        ...snapshot.config,
        credentialEpoch: nextEpoch,
        onboarding: nextOnboarding,
        llmOwnership: { ...snapshot.config.llmOwnership, route: ledger },
      }, snapshot.revision);
      this.#config = this.#settings.read().config;
    }
    this.#credential.synchronizeRecoveredEpoch(nextEpoch);
    this.#credentialState = applyCredentialDescriptor(
      this.#credentialState,
      await this.#credential.describe(),
    );
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#writeTail.then(operation);
    this.#writeTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private credentialIsUsable(): boolean {
    const descriptor = this.#credentialState.descriptor;
    return descriptor.configured && !(
      this.#credentialState.verification === "invalid" &&
      this.#credentialState.invalidEpoch?.credentialEpoch === descriptor.credentialEpoch
    );
  }

  private requestCredentialRecovery(): void {
    this.#credentialRecoveryRequestId = `recovery_${randomUUID().replaceAll("-", "")}`;
  }

  private clearCredentialRecoveryRequest(): void {
    this.#credentialRecoveryRequestId = null;
  }

  /** Coalesces concurrent 401s while explicit later capability calls get a fresh token. */
  private markCredentialRejected(credentialEpoch: number): void {
    const alreadyInvalid =
      this.#credentialState.verification === "invalid" &&
      this.#credentialState.invalidEpoch?.credentialEpoch === credentialEpoch;
    this.#credentialState = applyRuntimeUnauthorized(
      this.#credentialState,
      credentialEpoch,
      Date.now(),
    ).state;
    if (!alreadyInvalid && this.#credentialState.verification === "invalid") {
      this.requestCredentialRecovery();
    }
  }

  private async resolveUsableCredential(): Promise<
    Awaited<ReturnType<CredentialBroker["resolve"]>>
  > {
    if (!this.credentialIsUsable()) return undefined;
    const credential = await this.#credential.resolve();
    if (
      credential === undefined ||
      credential.credentialEpoch !== this.#credentialState.descriptor.credentialEpoch ||
      !this.credentialIsUsable()
    ) return undefined;
    return credential;
  }

  private enqueueDesignWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#designTail.then(operation);
    this.#designTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private rememberDesignModel(modelId: string): Promise<void> {
    if (this.#closing) return Promise.resolve();
    return this.enqueueWrite(async () => {
      const snapshot = this.#settings.read();
      const recent = [
        modelId,
        ...snapshot.config.services.design.recentModels
          .filter((candidate) => candidate !== modelId),
      ].slice(0, 20);
      await this.#settings.replace({
        ...snapshot.config,
        services: {
          ...snapshot.config.services,
          design: {
            ...snapshot.config.services.design,
            lastModel: modelId,
            recentModels: recent,
          },
        },
      }, snapshot.revision);
      this.#config = this.#settings.read().config;
    });
  }

  private syncDesignTools(enabled: boolean): void {
    if (enabled && this.#disposeDesignTools === undefined) {
      this.#disposeDesignTools = registerModellixDesignTools(this.#ctx, {
        resolveCredential: async () => (await this.resolveUsableCredential())?.value,
        handle: (endpoint, payload, signal) => {
          const operationSignal = signal === undefined
            ? this.#lifecycleAbort.signal
            : AbortSignal.any([signal, this.#lifecycleAbort.signal]);
          if (designEndpointRequestsCredential(endpoint) && !this.credentialIsUsable()) {
            this.requestCredentialRecovery();
          }
          return this.enqueueDesignWrite(
            () => this.#design.handle(endpoint, payload, operationSignal),
          );
        },
      });
      return;
    }
    if (!enabled && this.#disposeDesignTools !== undefined) {
      this.#disposeDesignTools();
      this.#disposeDesignTools = undefined;
    }
  }

  private syncWebTools(enabled: boolean): void {
    if (enabled && this.#disposeWebTools === undefined) {
      const providers = createModellixWebProviders({
        isEnabled: () => this.#config.services.web.enabled,
        hasCredential: () => this.credentialIsUsable(),
        resolveCredential: async () => {
          const hit = await this.resolveUsableCredential();
          if (hit === undefined) this.requestCredentialRecovery();
          return hit === undefined ? null : { apiKey: hit.value, credentialEpoch: hit.credentialEpoch };
        },
        getUserId: () => this.#userId,
        isCredentialEpochCurrent: (epoch) => epoch === this.#config.credentialEpoch,
        onCredentialRejected: async (epoch) => {
          if (epoch !== this.#config.credentialEpoch) return;
          this.markCredentialRejected(epoch);
        },
      });
      this.#disposeWebTools = registerModellixWebTools(this.#ctx, providers);
      return;
    }
    if (!enabled && this.#disposeWebTools !== undefined) {
      this.#disposeWebTools();
      this.#disposeWebTools = undefined;
    }
  }

  private scheduleDesignPoll(delayMs: number): void {
    if (this.#closing || this.#designPollTimer !== undefined) return;
    this.#designPollTimer = setTimeout(() => {
      this.#designPollTimer = undefined;
      void this.enqueueDesignWrite(
        () => this.#design.pollRunning(this.#lifecycleAbort.signal),
      )
        .then((hasRunning) => {
          if (hasRunning) this.scheduleDesignPoll(5_000);
        })
        .catch(() => {
          if (!this.#closing) this.scheduleDesignPoll(15_000);
        });
    }, Math.max(0, delayMs));
  }
}

function toLlmLedger(config: PluginConfig): LlmRouteLedger {
  return toLlmLedgerFromOwnership(config.llmOwnership.route);
}

function toLlmLedgerFromOwnership(
  route: PluginConfig["llmOwnership"]["route"],
): LlmRouteLedger {
  return {
    ownership: route.ownership,
    appliedRouteFingerprint: route.appliedRouteFingerprint,
    entries: route.entries.map((entry) => ({ ...entry })),
  };
}

function sameLlmLedger(left: LlmRouteLedger, right: PluginConfig["llmOwnership"]["route"]): boolean {
  return left.ownership === right.ownership &&
    left.appliedRouteFingerprint === right.appliedRouteFingerprint &&
    JSON.stringify(left.entries) === JSON.stringify(right.entries);
}

function parseCredentialSave(payload: unknown): {
  readonly apiKey: string;
  readonly expectedCredentialEpoch: number;
  readonly services: ServiceToggles;
} {
  const input = requireRecord(payload);
  if (typeof input.apiKey !== "string") throw new TypeError("apiKey is required");
  return {
    apiKey: input.apiKey,
    expectedCredentialEpoch: parseExpectedEpoch(input),
    services: parseToggles(input),
  };
}

function parseExpectedEpoch(payload: unknown): number {
  const input = requireRecord(payload);
  if (!Number.isSafeInteger(input.expectedCredentialEpoch) || (input.expectedCredentialEpoch as number) < 0) {
    throw new TypeError("expectedCredentialEpoch is invalid");
  }
  return input.expectedCredentialEpoch as number;
}

function parseExpectedSettingsRevision(input: Record<string, unknown>): number {
  if (!Number.isSafeInteger(input.expectedSettingsRevision) || (input.expectedSettingsRevision as number) < 0) {
    throw new TypeError("expectedSettingsRevision is invalid");
  }
  return input.expectedSettingsRevision as number;
}

function parseToggles(input: Record<string, unknown>): ServiceToggles {
  const services = isRecord(input.services) ? input.services : input;
  if (typeof services.design !== "boolean" || typeof services.llm !== "boolean" || typeof services.web !== "boolean") {
    throw new TypeError("all three service toggles are required");
  }
  return { design: services.design, llm: services.llm, web: services.web };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("payload must be an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function designEndpointRequestsCredential(endpoint: string): boolean {
  switch (endpoint) {
    case "design/refresh":
    case "design/select-model":
    case "design/propose":
    case "design/submit":
      return true;
    default:
      return false;
  }
}

function success(value: unknown): RpcResult<unknown> {
  return { ok: true, value };
}

function badRequest(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: "bad-request", message, details: { issues: [] } } };
}

function cancelled(): RpcResult<unknown> {
  return { ok: false, error: { code: "cancelled", message: "The Modellix request was cancelled", details: {} } };
}

function internalError(): RpcResult<unknown> {
  return {
    ok: false,
    error: {
      code: "internal",
      message: "The Modellix operation could not be completed",
      details: {},
    },
  };
}

function designRpcErrorCode(error: DesignError): string {
  // Outcome semantics take precedence over the transport status. In
  // particular, an HTTP 408/5xx from a billed POST is still non-replayable.
  switch (error.code) {
    case "SUBMIT_UNKNOWN":
      return "MODELLIX_SUBMIT_UNKNOWN";
    case "PLANNER_ABORTED":
      return "cancelled";
  }
  switch (error.status) {
    case 401:
      return "MODELLIX_UNAUTHORIZED";
    case 402:
      return "MODELLIX_BILLING_BLOCKED";
    case 403:
      return "MODELLIX_POLICY_BLOCKED";
    case 408:
      return "MODELLIX_TIMEOUT";
    case 429:
      return "MODELLIX_RATE_LIMITED";
    default:
      if (error.status !== null && error.status >= 500) return "MODELLIX_SERVER_ERROR";
  }
  switch (error.code) {
    case "INVALID_ARGUMENT":
    case "PARAMETER_INVALID":
      return "MODELLIX_DESIGN_INPUT_INVALID";
    case "MISSING_API_KEY":
      return "MODELLIX_API_KEY_REQUIRED";
    case "CATALOG_UNAVAILABLE":
      return "MODELLIX_DESIGN_CATALOG_UNAVAILABLE";
    case "SCHEMA_UNAVAILABLE":
      return "MODELLIX_DESIGN_SCHEMA_UNAVAILABLE";
    case "SCHEMA_INVALID":
    case "UNEXPECTED_RESPONSE":
    case "PLANNER_RESPONSE_INVALID":
      return "MODELLIX_DESIGN_SCHEMA_INVALID";
    case "ENDPOINT_NOT_ALLOWED":
    case "PLANNER_FORBIDDEN":
      return "MODELLIX_POLICY_BLOCKED";
    case "PLANNER_UNAUTHORIZED":
      return "MODELLIX_UNAUTHORIZED";
    case "PLANNER_BILLING_BLOCKED":
      return "MODELLIX_BILLING_BLOCKED";
    case "PLANNER_RATE_LIMITED":
      return "MODELLIX_RATE_LIMITED";
    case "PLANNER_TIMEOUT":
      return "MODELLIX_TIMEOUT";
    case "PLANNER_UNAVAILABLE":
      return "MODELLIX_SERVER_ERROR";
    case "SUBMIT_REJECTED":
    case "TASK_READ_FAILED":
      return "MODELLIX_SERVER_ERROR";
    case "STORAGE_INVALID":
    case "PLANNER_REJECTED":
      return "internal";
  }
}
