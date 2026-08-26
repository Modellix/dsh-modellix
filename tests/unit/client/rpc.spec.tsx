import { describe, expect, it } from "vitest";
import type {
  ClientConnectionRpc,
  RpcResult,
} from "@deepseek-ai/dsh-client-connection/client";

import {
  MODELLIX_RPC_CHANNEL,
  MODELLIX_RPC_ENDPOINTS,
} from "../../../src/client/contracts.js";
import {
  ModellixClientRpcError,
  ModellixRpcClient,
} from "../../../src/client/rpc.js";

interface CapturedCall {
  readonly channel: string;
  readonly endpoint: string;
  readonly payload: unknown;
  readonly signal: AbortSignal | undefined;
}

function canonicalState(): object {
  return {
    version: 1,
    settingsRevision: 3,
    services: { design: true, llm: true, web: true },
    credential: {
      configured: false,
      source: null,
      writable: true,
      revision: null,
      credentialEpoch: 0,
      verification: "unknown",
      invalidEpoch: null,
    },
    onboarding: { status: "active", recoveryPending: false, recoveryRequestId: null },
    llm: { health: "missing", modelCount: 0, refreshedAt: null },
  };
}

function designState(): object {
  return {
    version: 1,
    enabled: true,
    credentialReady: true,
    models: [],
    selectedModelId: null,
    draft: null,
    proposal: null,
    jobs: [],
    notice: null,
  };
}

function fakeRpc(
  handler: (call: CapturedCall) => Promise<RpcResult<unknown>>,
): { readonly rpc: Pick<ClientConnectionRpc, "call">; readonly calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  return {
    calls,
    rpc: {
      async call(channel, endpoint, payload, signal) {
        const call: CapturedCall = { channel, endpoint, payload, signal };
        calls.push(call);
        return handler(call);
      },
    },
  };
}

describe("Modellix browser RPC adapter", () => {
  it("uses only the /modellix Host channel and the versioned canonical state endpoint", async () => {
    const transport = fakeRpc(async () => ({ ok: true, value: canonicalState() }));
    const client = new ModellixRpcClient(transport.rpc);

    await expect(client.settings()).resolves.toMatchObject({ version: 1 });
    expect(transport.calls).toEqual([
      {
        channel: MODELLIX_RPC_CHANNEL,
        endpoint: MODELLIX_RPC_ENDPOINTS.stateGet,
        payload: { version: 1 },
        signal: undefined,
      },
    ]);
  });

  it("always sends candidate save CAS inputs and all three services", async () => {
    const transport = fakeRpc(async () => ({
      ok: true,
      value: { version: 1, accepted: true, state: canonicalState() },
    }));
    const client = new ModellixRpcClient(transport.rpc);

    await client.saveOnboarding(
      "fake-test-candidate",
      { design: true, llm: false, web: true },
      12,
    );

    expect(transport.calls[0]).toMatchObject({
      channel: "/modellix",
      endpoint: "credential/save",
      payload: {
        version: 1,
        apiKey: "fake-test-candidate",
        expectedCredentialEpoch: 12,
        services: { design: true, llm: false, web: true },
      },
    });
  });

  it("uses settings CAS for defer/toggles and Credential epoch for removal", async () => {
    const transport = fakeRpc(async () => ({
      ok: true,
      value: { version: 1, accepted: true, state: canonicalState() },
    }));
    const client = new ModellixRpcClient(transport.rpc);
    const services = { design: false, llm: true, web: false };

    await client.deferOnboarding(services, 20);
    await client.updateToggles(services, 21);
    await client.removeCredential(7);

    expect(transport.calls.map(({ endpoint, payload }) => ({ endpoint, payload }))).toEqual([
      {
        endpoint: "onboarding/defer",
        payload: { version: 1, services, expectedSettingsRevision: 20 },
      },
      {
        endpoint: "settings/toggles",
        payload: { version: 1, services, expectedSettingsRevision: 21 },
      },
      {
        endpoint: "credential/remove",
        payload: { version: 1, expectedCredentialEpoch: 7 },
      },
    ]);
  });

  it("surfaces conflict state without flattening or displaying Host text", async () => {
    const latest = canonicalState();
    const transport = fakeRpc(async () => ({
      ok: true,
      value: {
        version: 1,
        accepted: false,
        reason: "settings-changed",
        state: latest,
      },
    }));
    const client = new ModellixRpcClient(transport.rpc);

    await expect(
      client.updateToggles({ design: true, llm: true, web: true }, 1),
    ).rejects.toMatchObject({
      name: "ModellixClientRpcError",
      code: "settings-changed",
      messageKey: null,
      state: latest,
    });
  });

  it("routes candidate rejection only by stable code and messageKey", async () => {
    const transport = fakeRpc(async () => ({
      ok: true,
      value: {
        version: 1,
        accepted: false,
        error: {
          code: "MODELLIX_PAYMENT_REQUIRED",
          messageKey: "billing.payment_required",
          message: "untrusted Host prose",
        },
      },
    }));
    const client = new ModellixRpcClient(transport.rpc);

    await expect(
      client.replaceCredential(
        "fake-test-candidate",
        2,
        { design: true, llm: true, web: true },
      ),
    ).rejects.toMatchObject({
      code: "MODELLIX_PAYMENT_REQUIRED",
      messageKey: "billing.payment_required",
      state: null,
      message: "The Modellix Host operation could not be completed",
    });
  });

  it("strictly rejects malformed success values and classifies cancellation", async () => {
    const malformed = fakeRpc(async () => ({ ok: true, value: { version: 1 } }));
    await expect(new ModellixRpcClient(malformed.rpc).settings()).rejects.toMatchObject({
      code: "invalid-response",
    });

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = fakeRpc(async () => {
      throw new Error("transport text is not forwarded");
    });
    await expect(
      new ModellixRpcClient(cancelled.rpc).settings(aborted.signal),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ModellixClientRpcError>>({ code: "cancelled" }),
    );
  });

  it("sends Design actions through Host and never invents a cancel endpoint", async () => {
    const transport = fakeRpc(async () => ({
      ok: true,
      value: { version: 1, accepted: true, state: designState() },
    }));
    const client = new ModellixRpcClient(transport.rpc);

    await client.submitDesign({
      sessionId: "session-1",
      modelId: "openai/gpt-image-2",
      draftRevision: 4,
      irContractHash: "schemahash1234",
      parameters: { "/prompt": "A test image" },
    });

    expect(transport.calls[0]).toMatchObject({
      endpoint: "design/submit",
      payload: {
        version: 1,
        sessionId: "session-1",
        modelId: "openai/gpt-image-2",
        draftRevision: 4,
        irContractHash: "schemahash1234",
        parameters: { "/prompt": "A test image" },
      },
    });
    expect(Object.values(MODELLIX_RPC_ENDPOINTS)).not.toContain("design/cancel");
  });

  it("refreshes the Design catalog through the bounded Host endpoint", async () => {
    const transport = fakeRpc(async () => ({
      ok: true,
      value: { version: 1, accepted: true, state: designState() },
    }));
    const client = new ModellixRpcClient(transport.rpc);

    await client.refreshDesignCatalog("session-1");

    expect(transport.calls[0]).toMatchObject({
      channel: "/modellix",
      endpoint: "design/refresh",
      payload: { version: 1, sessionId: "session-1" },
    });
  });

  it("surfaces safe Design business codes without forwarding Host prose", async () => {
    const transport = fakeRpc(async () => ({
      ok: true,
      value: {
        version: 1,
        accepted: false,
        error: {
          code: "MODELLIX_RATE_LIMITED",
          message: "untrusted upstream prose",
        },
      },
    }));
    const error = await new ModellixRpcClient(transport.rpc)
      .design("session-1")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModellixClientRpcError);
    expect(error).toMatchObject({
      code: "MODELLIX_RATE_LIMITED",
      message: "The Modellix Host operation could not be completed",
    });
    expect(JSON.stringify(error)).not.toContain("upstream prose");
  });

  it("classifies a canonical outer RPC error without exposing its message", async () => {
    const transport = fakeRpc(async () => ({
      ok: false,
      error: { code: "internal", message: "untrusted transport prose", details: {} },
    }));
    const error = await new ModellixRpcClient(transport.rpc)
      .settings()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModellixClientRpcError);
    expect(error).toMatchObject({ code: "internal" });
    expect((error as Error).message).not.toContain("untrusted");
  });
});
