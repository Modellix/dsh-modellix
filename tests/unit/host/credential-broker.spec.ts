import { describe, expect, it, vi } from "vitest";

import {
  CredentialBroker,
  CredentialValidationError,
  type HarnessCredentialInfo,
} from "../../../src/host/credential-broker.js";

function credentialPort() {
  return {
    resolve: vi.fn(async (): Promise<{ value: string; source: string } | undefined> => undefined),
    describe: vi.fn(async (): Promise<HarnessCredentialInfo> => ({ configured: false, writable: true })),
    set: vi.fn(async () => undefined),
    unset: vi.fn(async () => undefined),
  };
}

describe("CredentialBroker", () => {
  it("preserves writability for an unconfigured local Credential", async () => {
    const broker = new CredentialBroker({
      credentials: credentialPort(),
      initialCredentialEpoch: 0,
    });

    await expect(broker.describe()).resolves.toMatchObject({
      configured: false,
      source: null,
      writable: true,
    });
  });

  it("validates a candidate without persisting it", async () => {
    const credentials = credentialPort();
    let authorization: string | null = null;
    const broker = new CredentialBroker({
      credentials,
      initialCredentialEpoch: 0,
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return new Response(JSON.stringify({ data: { is_valid: true } }), { status: 200 });
      },
    });
    await broker.validateCandidate("candidate-secret");
    expect(authorization).toBe("Bearer candidate-secret");
    expect(credentials.set).not.toHaveBeenCalled();
  });

  it("treats HTTP 200 is_valid=false as candidate rejection", async () => {
    const broker = new CredentialBroker({
      credentials: credentialPort(),
      initialCredentialEpoch: 3,
      fetch: async () => new Response(JSON.stringify({ data: { is_valid: false } })),
    });
    await expect(broker.validateCandidate("candidate-secret")).rejects.toMatchObject({
      contract: { code: "MODELLIX_CANDIDATE_KEY_INVALID" },
    });
  });

  it("rejects redirects and malformed envelopes", async () => {
    const followed = new Response(JSON.stringify({ data: { is_valid: true } }));
    Object.defineProperty(followed, "redirected", { value: true });
    const responses = [
      new Response(null, { status: 302, headers: { location: "https://example.test" } }),
      followed,
      new Response("not-json"),
    ];
    const broker = new CredentialBroker({
      credentials: credentialPort(),
      initialCredentialEpoch: 0,
      fetch: async () => responses.shift()!,
    });
    await expect(broker.validateCandidate("candidate-secret")).rejects.toBeInstanceOf(CredentialValidationError);
    await expect(broker.validateCandidate("candidate-secret")).rejects.toBeInstanceOf(CredentialValidationError);
    await expect(broker.validateCandidate("candidate-secret")).rejects.toBeInstanceOf(CredentialValidationError);
  });

  it("bounds a chunked validation response without Content-Length", async () => {
    let canceled = false;
    const broker = new CredentialBroker({
      credentials: credentialPort(),
      initialCredentialEpoch: 0,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new Uint8Array(40 * 1_024));
          stream.enqueue(new Uint8Array(40 * 1_024));
        },
        cancel() {
          canceled = true;
        },
      })),
    });

    await expect(broker.validateCandidate("candidate-secret")).rejects.toMatchObject({
      contract: { code: "MODELLIX_UNEXPECTED_RESPONSE" },
    });
    expect(canceled).toBe(true);
  });

  it("cancels a stalled validation body", async () => {
    let canceled = false;
    const controller = new AbortController();
    const broker = new CredentialBroker({
      credentials: credentialPort(),
      initialCredentialEpoch: 0,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      })),
    });
    const validation = broker.validateCandidate("candidate-secret", controller.signal);

    controller.abort();

    await expect(validation).rejects.toMatchObject({
      contract: { code: "MODELLIX_CANCELED" },
    });
    expect(canceled).toBe(true);
  });

  it("times out a stalled validation request within its owned deadline", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      }));
    const broker = new CredentialBroker({
      credentials: credentialPort(),
      initialCredentialEpoch: 0,
      fetch: fetchMock,
      requestTimeoutMs: 5,
    });

    await expect(broker.validateCandidate("candidate-secret")).rejects.toMatchObject({
      contract: { code: "MODELLIX_TIMEOUT" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("serializes writes and rejects a stale plugin epoch", async () => {
    const credentials = credentialPort();
    const broker = new CredentialBroker({ credentials, initialCredentialEpoch: 5 });
    await expect(broker.set("first-secret", 5)).resolves.toMatchObject({ credentialEpoch: 6 });
    await expect(broker.set("stale-secret", 5)).rejects.toMatchObject({
      name: "CredentialEpochConflictError",
      actualEpoch: 6,
    });
    expect(credentials.set).toHaveBeenCalledTimes(1);
  });

  it("never exposes a configured Credential value in descriptors", async () => {
    const credentials = credentialPort();
    credentials.describe.mockResolvedValue({ configured: true, source: "file", writable: true });
    credentials.resolve.mockResolvedValue({ value: "private-secret", source: "file" });
    const broker = new CredentialBroker({ credentials, initialCredentialEpoch: 8 });
    expect(await broker.describe()).toEqual({
      configured: true,
      source: "local",
      writable: true,
      revision: "epoch:8",
      credentialEpoch: 8,
    });
    expect(JSON.stringify(await broker.describe())).not.toContain("private-secret");
  });
});
