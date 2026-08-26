import { afterEach, describe, expect, it, vi } from "vitest";

const MODULES = [
  "../../../src/client/store.js",
  "../../../src/client/rpc.js",
  "../../../src/client/styles.js",
  "../../../src/client/CredentialRecoveryOverlay.js",
  "../../../src/client/DesignView.js",
  "../../../src/client/Onboarding.js",
  "../../../src/client/SettingsSection.js",
] as const;

afterEach(() => {
  for (const moduleId of MODULES) vi.doUnmock(moduleId);
  vi.resetModules();
});

describe("Modellix Client entry point", () => {
  it("registers dictionaries, styles, and the four public slot contributions", async () => {
    const styleDispose = vi.fn();
    const installStyles = vi.fn(() => styleDispose);
    const overlay = vi.fn(() => null);
    const designView = vi.fn(() => null);
    const onboarding = vi.fn(() => null);
    const settingsSection = vi.fn(() => null);

    class TestRpcClient {
      constructor(readonly transport: unknown) {}
    }
    class TestSettingsController {
      constructor(readonly rpc: TestRpcClient) {}
    }
    class TestDesignController {
      constructor(
        readonly rpc: TestRpcClient,
        readonly sessionId: string,
      ) {}
    }

    vi.doMock("../../../src/client/store.js", () => ({
      DesignController: TestDesignController,
      SettingsController: TestSettingsController,
    }));
    vi.doMock("../../../src/client/rpc.js", () => ({
      ModellixRpcClient: TestRpcClient,
    }));
    vi.doMock("../../../src/client/styles.js", () => ({
      installModellixClientStyles: installStyles,
    }));
    vi.doMock("../../../src/client/CredentialRecoveryOverlay.js", () => ({
      CredentialRecoveryOverlay: overlay,
    }));
    vi.doMock("../../../src/client/DesignView.js", () => ({
      ModellixDesignView: designView,
    }));
    vi.doMock("../../../src/client/Onboarding.js", () => ({
      ModellixOnboarding: onboarding,
    }));
    vi.doMock("../../../src/client/SettingsSection.js", () => ({
      ModellixSettingsSection: settingsSection,
    }));

    const { apply, inject } = await import("../../../src/client/index.js");
    const effects: Array<{ readonly label: string; readonly cleanup: unknown }> = [];
    const registrations: Array<{
      readonly metadata: Record<string, unknown>;
      readonly component: unknown;
    }> = [];
    const slotDependencies: string[] = [];
    const localeCleanup = vi.fn();
    const localeRegister = vi.fn(
      (_namespace: string, _dictionary: unknown) => localeCleanup,
    );
    const translate = vi.fn((key: string) => `translated:${key}`);
    const bind = vi.fn((_namespace: string) => translate);
    const transport = { request: vi.fn() };
    const register = vi.fn(
      (metadata: Record<string, unknown>, component: unknown) => {
        registrations.push({ metadata, component });
        return vi.fn();
      },
    );
    const context = {
      connection: { rpc: transport },
      effect: vi.fn((factory: () => unknown, label: string) => {
        effects.push({ label, cleanup: factory() });
      }),
      locale: { bind, register: localeRegister },
      slots: {
        inject: vi.fn((name: string, factory: () => unknown) => {
          slotDependencies.push(name);
          return factory();
        }),
        register,
      },
    };

    apply(context as never);

    expect(inject).toEqual(["slots", "locale", "connection"]);
    expect(localeRegister).toHaveBeenCalledOnce();
    expect(localeRegister.mock.calls[0]?.[0]).toBe("modellix");
    expect(localeRegister.mock.calls[0]?.[1]).toEqual({
      zh: expect.any(Object),
      en: expect.any(Object),
    });
    expect(bind).toHaveBeenCalledWith("modellix");
    expect(installStyles).toHaveBeenCalledOnce();
    expect(effects).toEqual([
      { label: "modellix: client dictionaries", cleanup: localeCleanup },
      { label: "modellix: client styles", cleanup: styleDispose },
    ]);
    expect(slotDependencies).toEqual([
      "shell.overlay",
      "settings.onboarding",
      "settings.section",
      "conversation.view",
    ]);
    expect(registrations.map(({ metadata, component }) => ({
      id: metadata.id,
      name: metadata.name,
      order: metadata.order,
      component,
    }))).toEqual([
      {
        id: "modellix.credential-recovery",
        name: "shell.overlay",
        order: 10,
        component: overlay,
      },
      {
        id: "modellix.onboarding",
        name: "settings.onboarding",
        order: 10,
        component: onboarding,
      },
      {
        id: "modellix",
        name: "settings.section",
        order: 30,
        component: settingsSection,
      },
      {
        id: "modellix.design",
        name: "conversation.view",
        order: 20,
        component: designView,
      },
    ]);

    const overlayProps = registrations[0]?.metadata.inject as (() => {
      readonly controller: TestSettingsController;
    });
    const onboardingProps = registrations[1]?.metadata.inject as (() => {
      readonly controller: TestSettingsController;
    });
    const settingsProps = registrations[2]?.metadata.inject as (() => {
      readonly controller: TestSettingsController;
    });
    const designProps = registrations[3]?.metadata.inject as ((sessionId: string) => {
      readonly controller: TestDesignController;
      readonly settingsController: TestSettingsController;
    });
    const sharedSettings = overlayProps().controller;

    expect(onboardingProps().controller).toBe(sharedSettings);
    expect(settingsProps().controller).toBe(sharedSettings);
    expect(sharedSettings.rpc).toBeInstanceOf(TestRpcClient);
    expect(sharedSettings.rpc.transport).toBe(transport);
    const conversation = designProps("session-entry-test");
    expect(conversation.settingsController).toBe(sharedSettings);
    expect(conversation.controller.rpc).toBe(sharedSettings.rpc);
    expect(conversation.controller.sessionId).toBe("session-entry-test");

    const settingsLabel = registrations[2]?.metadata.label as (() => string);
    const designLabel = registrations[3]?.metadata.label as (() => string);
    expect(settingsLabel()).toBe("translated:nav");
    expect(designLabel()).toBe("translated:designTab");
  });
});
