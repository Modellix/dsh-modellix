import { describe, expect, it } from "vitest";

import {
  ModellixClientContractError,
  parseDesignSnapshot,
  parseSettingsMutation,
  parseSettingsSnapshot,
  safeResourceHref,
  sanitizeParameters,
} from "../../../src/client/contracts.js";

function settingsSnapshot(overrides: Record<string, unknown> = {}): object {
  return {
    version: 1,
    settingsRevision: 4,
    services: { design: true, llm: true, web: true },
    credential: {
      configured: true,
      source: "local",
      writable: true,
      revision: "epoch:7",
      credentialEpoch: 7,
      verification: "valid",
      invalidEpoch: null,
    },
    onboarding: { status: "completed", recoveryPending: false, recoveryRequestId: null },
    llm: { health: "ready", modelCount: 18, refreshedAt: 1_787_616_000_000 },
    ...overrides,
  };
}

function designSnapshot(overrides: Record<string, unknown> = {}): object {
  return {
    version: 1,
    enabled: true,
    credentialReady: true,
    models: [
      {
        id: "openai/gpt-image-2",
        label: "GPT Image 2",
        kind: "image",
        featured: true,
        available: true,
        unavailableReason: null,
      },
    ],
    selectedModelId: "openai/gpt-image-2",
    draft: {
      modelId: "openai/gpt-image-2",
      draftRevision: 2,
      irContractHash: "schemahash1234",
      primaryInputPath: "/prompt",
      fields: [
        {
          path: "/prompt",
          label: "Prompt",
          description: "Describe the requested image",
          kind: "string",
          widget: "textarea",
          required: true,
          options: [],
          minimum: null,
          maximum: null,
          step: null,
          maxLength: 4_096,
          disabledReason: null,
        },
      ],
      parameters: { "/prompt": "A quiet landscape" },
    },
    proposal: null,
    jobs: [
      {
        jobId: "task_1",
        modelId: "openai/gpt-image-2",
        status: "succeeded",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:01.000Z",
        resources: [
          {
            id: "resource_1",
            kind: "image",
            url: "https://cdn.example/result.png?signature=fake",
            downloadUrl: "https://cdn.example/result.png?signature=fake",
            expiresAt: "2026-08-26T00:00:00.000Z",
          },
        ],
        diagnostic: null,
      },
    ],
    notice: null,
    ...overrides,
  };
}

describe("Modellix Client settings wire", () => {
  it("accepts the canonical nested Host state without flattening it", () => {
    expect(parseSettingsSnapshot(settingsSnapshot())).toEqual(settingsSnapshot());
  });

  it("enforces descriptor source, writability, and opaque revision invariants", () => {
    for (const credential of [
      {
        configured: false,
        source: "local",
        writable: true,
        revision: null,
        credentialEpoch: 0,
        verification: "unknown",
        invalidEpoch: null,
      },
      {
        configured: true,
        source: "env",
        writable: true,
        revision: "epoch:1",
        credentialEpoch: 1,
        verification: "unverified",
        invalidEpoch: null,
      },
      {
        configured: true,
        source: "local",
        writable: true,
        revision: null,
        credentialEpoch: 1,
        verification: "valid",
        invalidEpoch: null,
      },
    ]) {
      expect(() =>
        parseSettingsSnapshot(settingsSnapshot({ credential })),
      ).toThrow(ModellixClientContractError);
    }
  });

  it("parses successful, conflicting, and API-rejected mutations", () => {
    const state = settingsSnapshot();
    expect(
      parseSettingsMutation({ version: 1, accepted: true, state }),
    ).toMatchObject({ accepted: true, state });
    expect(
      parseSettingsMutation({
        version: 1,
        accepted: false,
        reason: "credential-changed",
        state,
      }),
    ).toMatchObject({
      accepted: false,
      code: "credential-changed",
      messageKey: null,
      state,
    });
    expect(
      parseSettingsMutation({
        version: 1,
        accepted: false,
        error: {
          code: "MODELLIX_UNAUTHORIZED",
          messageKey: "credential.invalid",
        },
      }),
    ).toEqual({
      version: 1,
      accepted: false,
      code: "MODELLIX_UNAUTHORIZED",
      messageKey: "credential.invalid",
      state: null,
    });
  });

  it("rejects unsupported versions, health states, and Secret-shaped fields", () => {
    expect(() =>
      parseSettingsSnapshot(settingsSnapshot({ version: 2 })),
    ).toThrow(ModellixClientContractError);
    expect(() =>
      parseSettingsSnapshot(
        settingsSnapshot({
          llm: { health: "degraded", modelCount: 0, refreshedAt: null },
        }),
      ),
    ).toThrow(ModellixClientContractError);
    expect(() =>
      parseSettingsSnapshot({ ...settingsSnapshot(), apiKey: "not-a-real-key" }),
    ).toThrow(/Secret-shaped/u);
  });
});

describe("Modellix Client Design wire", () => {
  it("accepts provider/model ids, Schema IR fields, and safe media results", () => {
    const parsed = parseDesignSnapshot(designSnapshot());
    expect(parsed.selectedModelId).toBe("openai/gpt-image-2");
    expect(parsed.draft?.parameters).toEqual({ "/prompt": "A quiet landscape" });
    expect(parsed.jobs[0]?.resources[0]?.url).toContain("https://cdn.example/");
  });

  it("accepts only stable localizable Design presentation codes", () => {
    const base = designSnapshot() as {
      models: readonly Record<string, unknown>[];
      jobs: readonly Record<string, unknown>[];
    };
    const coded = designSnapshot({
      notice: "catalog-stale",
      models: [{
        ...base.models[0],
        available: false,
        unavailableReason: "removed-from-catalog",
      }],
      jobs: [{
        ...base.jobs[0],
        diagnostic: { code: "task-inaccessible", retryable: false },
      }],
    });
    expect(parseDesignSnapshot(coded)).toMatchObject({
      notice: "catalog-stale",
      models: [{ unavailableReason: "removed-from-catalog" }],
      jobs: [{ diagnostic: { code: "task-inaccessible", retryable: false } }],
    });
    expect(() => parseDesignSnapshot(designSnapshot({ notice: "Host prose" }))).toThrow(
      ModellixClientContractError,
    );
    expect(() => parseDesignSnapshot(designSnapshot({
      jobs: [{
        ...base.jobs[0],
        diagnostic: {
          code: "task-inaccessible",
          message: "Host prose must not cross the wire",
          retryable: false,
        },
      }],
    }))).toThrow(/stable code/u);
  });

  it("rejects catalog/draft disagreement and unknown selected models", () => {
    expect(() =>
      parseDesignSnapshot(
        designSnapshot({ selectedModelId: "other/model" }),
      ),
    ).toThrow(ModellixClientContractError);
    const base = designSnapshot() as { draft: Record<string, unknown> };
    expect(() =>
      parseDesignSnapshot({
        ...base,
        draft: { ...base.draft, modelId: "other/model" },
      }),
    ).toThrow(ModellixClientContractError);
  });

  it("bounds model catalogs and nested JSON payloads", () => {
    const model = (designSnapshot() as { models: readonly unknown[] }).models[0];
    expect(() =>
      parseDesignSnapshot(
        designSnapshot({ models: Array.from({ length: 1_001 }, () => model) }),
      ),
    ).toThrow(ModellixClientContractError);

    let nested: unknown = "value";
    for (let index = 0; index < 12; index += 1) nested = { nested };
    expect(() => sanitizeParameters({ nested } as never)).toThrow(
      ModellixClientContractError,
    );
  });

  it("allows only credential-free HTTPS result links", () => {
    expect(safeResourceHref("https://example.com/result")).toBe(
      "https://example.com/result",
    );
    for (const href of [
      "http://example.com/result",
      "https://user@example.com/result",
      "file:///tmp/result",
      "/relative/result",
    ]) {
      expect(() => safeResourceHref(href)).toThrow(
        ModellixClientContractError,
      );
    }
    expect(() =>
      safeResourceHref(`https://example.com/${"a".repeat(16_365)}`),
    ).toThrow(ModellixClientContractError);
  });
});
