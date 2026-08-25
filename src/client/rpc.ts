import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";

import {
  MODELLIX_CLIENT_WIRE_VERSION,
  MODELLIX_RPC_CHANNEL,
  MODELLIX_RPC_ENDPOINTS,
  parseDesignSnapshot,
  parseSettingsMutation,
  parseSettingsSnapshot,
  sanitizeParameters,
  type ClientJsonValue,
  type DesignSnapshotWire,
  type ServiceTogglesWire,
  type SettingsSnapshotWire,
} from "./contracts.js";

export class ModellixClientRpcError extends Error {
  readonly endpoint: string;
  readonly code: string;
  readonly messageKey: string | null;
  readonly state: SettingsSnapshotWire | null;

  constructor(
    endpoint: string,
    code: string,
    options: {
      readonly messageKey?: string | null;
      readonly state?: SettingsSnapshotWire | null;
    } = {},
  ) {
    super("The Modellix Host operation could not be completed");
    this.name = "ModellixClientRpcError";
    this.endpoint = endpoint;
    this.code = safeErrorCode(code);
    this.messageKey = options.messageKey ?? null;
    this.state = options.state ?? null;
  }
}

export class ModellixRpcClient {
  readonly #rpc: Pick<ClientConnectionRpc, "call">;

  constructor(rpc: Pick<ClientConnectionRpc, "call">) {
    this.#rpc = rpc;
  }

  settings(signal?: AbortSignal): Promise<SettingsSnapshotWire> {
    return this.#call(
      MODELLIX_RPC_ENDPOINTS.stateGet,
      {},
      parseSettingsSnapshot,
      signal,
    );
  }

  saveOnboarding(
    apiKey: string,
    services: ServiceTogglesWire,
    expectedCredentialEpoch: number,
    signal?: AbortSignal,
  ): Promise<SettingsSnapshotWire> {
    return this.#settingsMutation(
      MODELLIX_RPC_ENDPOINTS.credentialSave,
      { apiKey, services, expectedCredentialEpoch },
      signal,
    );
  }

  deferOnboarding(
    services: ServiceTogglesWire,
    expectedSettingsRevision: number,
    signal?: AbortSignal,
  ): Promise<SettingsSnapshotWire> {
    return this.#settingsMutation(
      MODELLIX_RPC_ENDPOINTS.onboardingDefer,
      { services, expectedSettingsRevision },
      signal,
    );
  }

  updateToggles(
    services: ServiceTogglesWire,
    expectedSettingsRevision: number,
    signal?: AbortSignal,
  ): Promise<SettingsSnapshotWire> {
    return this.#settingsMutation(
      MODELLIX_RPC_ENDPOINTS.settingsToggles,
      { services, expectedSettingsRevision },
      signal,
    );
  }

  replaceCredential(
    apiKey: string,
    expectedCredentialEpoch: number,
    services: ServiceTogglesWire,
    signal?: AbortSignal,
  ): Promise<SettingsSnapshotWire> {
    return this.#settingsMutation(
      MODELLIX_RPC_ENDPOINTS.credentialSave,
      {
        apiKey,
        expectedCredentialEpoch,
        services,
      },
      signal,
    );
  }

  removeCredential(
    expectedCredentialEpoch: number,
    signal?: AbortSignal,
  ): Promise<SettingsSnapshotWire> {
    return this.#settingsMutation(
      MODELLIX_RPC_ENDPOINTS.credentialRemove,
      { expectedCredentialEpoch },
      signal,
    );
  }

  refreshLlmCatalog(signal?: AbortSignal): Promise<SettingsSnapshotWire> {
    return this.#settingsMutation(
      MODELLIX_RPC_ENDPOINTS.llmRefresh,
      {},
      signal,
    );
  }

  design(sessionId: string, signal?: AbortSignal): Promise<DesignSnapshotWire> {
    return this.#call(
      MODELLIX_RPC_ENDPOINTS.designRead,
      { sessionId },
      parseDesignSnapshot,
      signal,
    );
  }

  refreshDesignCatalog(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DesignSnapshotWire> {
    return this.#call(
      MODELLIX_RPC_ENDPOINTS.designRefresh,
      { sessionId },
      parseDesignSnapshot,
      signal,
    );
  }

  selectDesignModel(
    sessionId: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<DesignSnapshotWire> {
    return this.#call(
      MODELLIX_RPC_ENDPOINTS.designSelectModel,
      { sessionId, modelId },
      parseDesignSnapshot,
      signal,
    );
  }

  proposeDesignParameters(
    input: {
      readonly sessionId: string;
      readonly modelId: string;
      readonly instruction: string;
      readonly draftRevision: number;
      readonly irContractHash: string;
    },
    signal?: AbortSignal,
  ): Promise<DesignSnapshotWire> {
    return this.#call(
      MODELLIX_RPC_ENDPOINTS.designPropose,
      input,
      parseDesignSnapshot,
      signal,
    );
  }

  applyDesignProposal(
    sessionId: string,
    proposalId: string,
    signal?: AbortSignal,
  ): Promise<DesignSnapshotWire> {
    return this.#call(
      MODELLIX_RPC_ENDPOINTS.designProposalApply,
      { sessionId, proposalId },
      parseDesignSnapshot,
      signal,
    );
  }

  rejectDesignProposal(
    sessionId: string,
    proposalId: string,
    signal?: AbortSignal,
  ): Promise<DesignSnapshotWire> {
    return this.#call(
      MODELLIX_RPC_ENDPOINTS.designProposalReject,
      { sessionId, proposalId },
      parseDesignSnapshot,
      signal,
    );
  }

  submitDesign(
    input: {
      readonly sessionId: string;
      readonly modelId: string;
      readonly draftRevision: number;
      readonly irContractHash: string;
      readonly parameters: Readonly<Record<string, ClientJsonValue>>;
    },
    signal?: AbortSignal,
  ): Promise<DesignSnapshotWire> {
    return this.#call(
      MODELLIX_RPC_ENDPOINTS.designSubmit,
      { ...input, parameters: sanitizeParameters(input.parameters) },
      parseDesignSnapshot,
      signal,
    );
  }

  async #call<T>(
    endpoint: string,
    payload: Readonly<Record<string, unknown>>,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    let result: Awaited<ReturnType<ClientConnectionRpc["call"]>>;
    try {
      result = await this.#rpc.call(
        MODELLIX_RPC_CHANNEL,
        endpoint,
        { version: MODELLIX_CLIENT_WIRE_VERSION, ...payload },
        signal,
      );
    } catch (error) {
      const code =
        signal?.aborted === true ||
        (error instanceof Error && error.name === "AbortError")
          ? "cancelled"
          : "transport";
      throw new ModellixClientRpcError(endpoint, code);
    }
    if (!result.ok) {
      throw new ModellixClientRpcError(endpoint, result.error.code);
    }
    try {
      return parse(result.value);
    } catch {
      throw new ModellixClientRpcError(endpoint, "invalid-response");
    }
  }

  async #settingsMutation(
    endpoint: string,
    payload: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<SettingsSnapshotWire> {
    const mutation = await this.#call(
      endpoint,
      payload,
      parseSettingsMutation,
      signal,
    );
    if (mutation.accepted) return mutation.state;
    throw new ModellixClientRpcError(endpoint, mutation.code, {
      messageKey: mutation.messageKey,
      state: mutation.state,
    });
  }
}

function safeErrorCode(value: string): string {
  return /^(?:MODELLIX_[A-Z0-9_]{1,96}|[a-z][a-z0-9-]{0,63})$/u.test(value)
    ? value
    : "internal";
}
