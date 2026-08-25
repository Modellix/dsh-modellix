import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";

import { DesignController, SettingsController } from "./store.js";
import { ModellixDesignView } from "./DesignView.js";
import { en, MODELLIX_LOCALE_NAMESPACE, zh } from "./locales.js";
import { ModellixOnboarding } from "./Onboarding.js";
import { ModellixRpcClient } from "./rpc.js";
import { ModellixSettingsSection } from "./SettingsSection.js";
import { installModellixClientStyles } from "./styles.js";

export const inject = ["slots", "locale", "connection"];

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

  ctx.slots.inject("conversation.view", () =>
    ctx.slots.register(
      {
        name: "conversation.view",
        id: "modellix.design",
        order: 20,
        label: () => t("designTab"),
        locale: MODELLIX_LOCALE_NAMESPACE,
        inject: (sessionId) => ({
          controller: new DesignController(rpc, sessionId),
          settingsController,
        }),
      },
      ModellixDesignView,
    ),
  );
}

export * from "./contracts.js";
export * from "./registration.js";
