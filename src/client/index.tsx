import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-tool/client";

import { SettingsController } from "./store.js";
import { CredentialRecoveryOverlay } from "./CredentialRecoveryOverlay.js";
import {
  DesignDrawerController,
  ModellixDesignDrawer,
  ModellixDesignLauncher,
} from "./DesignDrawer.js";
import { ModellixMediaToolView } from "./MediaToolView.js";
import { en, MODELLIX_LOCALE_NAMESPACE, zh } from "./locales.js";
import { ModellixOnboarding } from "./Onboarding.js";
import { ModellixRpcClient } from "./rpc.js";
import { ModellixSettingsSection } from "./SettingsSection.js";
import { installModellixClientStyles } from "./styles.js";

export const inject = ["slots", "locale", "connection", "layout"];

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () =>
      ctx.locale.register(MODELLIX_LOCALE_NAMESPACE, {
        zh,
        en,
      }),
    "modellix: client dictionaries",
  );
  ctx.effect(
    () => installModellixClientStyles(),
    "modellix: client styles",
  );

  const t = ctx.locale.bind(MODELLIX_LOCALE_NAMESPACE);
  const rpc = new ModellixRpcClient(ctx.connection.rpc);
  const settingsController = new SettingsController(rpc);
  const designDrawer = new DesignDrawerController(rpc, ctx.layout);

  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      {
        name: "shell.overlay",
        id: "modellix.credential-recovery",
        order: 10,
        locale: MODELLIX_LOCALE_NAMESPACE,
        inject: () => ({ controller: settingsController }),
      },
      CredentialRecoveryOverlay,
    ),
  );

  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      {
        name: "shell.overlay",
        id: "modellix.design-drawer",
        order: 20,
        locale: MODELLIX_LOCALE_NAMESPACE,
        inject: () => ({ drawer: designDrawer, settingsController }),
      },
      ModellixDesignDrawer,
    ),
  );

  ctx.slots.inject("settings.onboarding", () =>
    ctx.slots.register(
      {
        name: "settings.onboarding",
        id: "modellix.onboarding",
        order: 10,
        locale: MODELLIX_LOCALE_NAMESPACE,
        inject: () => ({ controller: settingsController }),
      },
      ModellixOnboarding,
    ),
  );

  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "modellix",
        order: 30,
        label: () => t("nav"),
        locale: MODELLIX_LOCALE_NAMESPACE,
        inject: () => ({ controller: settingsController }),
      },
      ModellixSettingsSection,
    ),
  );

  ctx.slots.inject("conversation.session.header.utilities", () =>
    ctx.slots.register(
      {
        name: "conversation.session.header.utilities",
        id: "modellix.design-launcher",
        order: 20,
        locale: MODELLIX_LOCALE_NAMESPACE,
        inject: () => ({ drawer: designDrawer }),
      },
      ModellixDesignLauncher,
    ),
  );


  ctx.slots.inject("tool.call.toolview", () =>
    ctx.slots.register(
      {
        name: "tool.call.toolview",
        key: "modellix_media_generate",
        priority: 20,
        locale: MODELLIX_LOCALE_NAMESPACE,
        inject: () => ({ drawer: designDrawer }),
      },
      ModellixMediaToolView,
    ),
  );

  ctx.slots.inject("tool.call.toolview", () =>
    ctx.slots.register(
      {
        name: "tool.call.toolview",
        key: "modellix_media_get_result",
        priority: 20,
        locale: MODELLIX_LOCALE_NAMESPACE,
        inject: () => ({ drawer: designDrawer }),
      },
      ModellixMediaToolView,
    ),
  );
}

export * from "./contracts.js";
export * from "./registration.js";
