import { afterEach, describe, expect, it, vi } from "vitest";

const MODULES = [
  "../../../src/client/store.js",
  "../../../src/client/rpc.js",
  "../../../src/client/styles.js",
  "../../../src/client/CredentialRecoveryOverlay.js",
  "../../../src/client/DesignDrawer.js",
  "../../../src/client/MediaToolView.js",
  "../../../src/client/Onboarding.js",
  "../../../src/client/SettingsSection.js",
] as const;

afterEach(() => {
  for (const moduleId of MODULES) vi.doUnmock(moduleId);
  vi.resetModules();
});

describe("Modellix Client entry point", () => {
  it("registers dictionaries, styles, the Design drawer, and media result views", async () => {
    const styleDispose = vi.fn();
    const installStyles = vi.fn(() => styleDispose);
    const overlay = vi.fn(() => null);
    const designDrawer = vi.fn(() => null);
    const designLauncher = vi.fn(() => null);
    const mediaToolView = vi.fn(() => null);
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
    class TestDesignDrawerController {
      constructor(
        readonly rpc: TestRpcClient,
        readonly layout: unknown,
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
    vi.doMock("../../../src/client/DesignDrawer.js", () => ({
      DesignDrawerController: TestDesignDrawerController,
      ModellixDesignDrawer: designDrawer,
      ModellixDesignLauncher: designLauncher,
    }));
    vi.doMock("../../../src/client/MediaToolView.js", () => ({
      ModellixMediaToolView: mediaToolView,
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
    const layout = { openDetails: vi.fn(), closeDetails: vi.fn() };
    const register = vi.fn(
      (metadata: Record<string, unknown>, component: unknown) => {
        registrations.push({ metadata, component });
        return vi.fn();
      },
    );
    const context = {
      connection: { rpc: transport },
      layout,
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

    expect(inject).toEqual(["slots", "locale", "connection", "layout"]);
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
      "shell.overlay",
      "settings.onboarding",
      "settings.section",
      "conversation.session.header.utilities",
      "tool.call.toolview",
      "tool.call.toolview",
    ]);
    expect(registrations.map(({ metadata, component }) => ({
      id: metadata.id,
      name: metadata.name,
      order: metadata.order,
      priority: metadata.priority,
      component,
    }))).toEqual([
      {
        id: "modellix.credential-recovery",
        name: "shell.overlay",
        order: 10,
        priority: undefined,
        component: overlay,
      },
      {
        id: "modellix.design-drawer",
        name: "shell.overlay",
        order: 20,
        priority: undefined,
        component: designDrawer,
      },
      {
        id: "modellix.onboarding",
        name: "settings.onboarding",
        order: 10,
        priority: undefined,
        component: onboarding,
      },
      {
        id: "modellix",
        name: "settings.section",
        order: 30,
        priority: undefined,
        component: settingsSection,
      },
      {
        id: "modellix.design-launcher",
        name: "conversation.session.header.utilities",
        order: 20,
        priority: undefined,
        component: designLauncher,
      },
      {
        id: undefined,
        name: "tool.call.toolview",
        order: undefined,
        priority: 20,
        component: mediaToolView,
      },
      {
        id: undefined,
        name: "tool.call.toolview",
        order: undefined,
        priority: 20,
        component: mediaToolView,
      },
    ]);

    const overlayProps = registrations[0]?.metadata.inject as (() => {
      readonly controller: TestSettingsController;
    });
    const drawerProps = registrations[1]?.metadata.inject as (() => {
      readonly drawer: TestDesignDrawerController;
      readonly settingsController: TestSettingsController;
    });
    const onboardingProps = registrations[2]?.metadata.inject as (() => {
      readonly controller: TestSettingsController;
    });
    const settingsProps = registrations[3]?.metadata.inject as (() => {
      readonly controller: TestSettingsController;
    });
    const launcherProps = registrations[4]?.metadata.inject as (() => {
      readonly drawer: TestDesignDrawerController;
    });
    const sharedSettings = overlayProps().controller;

    const drawer = drawerProps().drawer;
    expect(drawerProps().settingsController).toBe(sharedSettings);
    expect(onboardingProps().controller).toBe(sharedSettings);
    expect(settingsProps().controller).toBe(sharedSettings);
    expect(sharedSettings.rpc).toBeInstanceOf(TestRpcClient);
    expect(sharedSettings.rpc.transport).toBe(transport);
    expect(drawer.rpc).toBe(sharedSettings.rpc);
    expect(drawer.layout).toBe(layout);
    expect(launcherProps().drawer).toBe(drawer);

    const settingsLabel = registrations[3]?.metadata.label as (() => string);
    expect(settingsLabel()).toBe("translated:nav");
    expect(registrations[5]?.metadata.key).toBe("modellix_media_generate");
    expect(registrations[6]?.metadata.key).toBe("modellix_media_get_result");
  });
});
