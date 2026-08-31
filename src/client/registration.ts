export const MODELLIX_CLIENT_SLOTS = Object.freeze([
  {
    name: "shell.overlay",
    id: "modellix.credential-recovery",
    order: 10,
  },
  {
    name: "shell.overlay",
    id: "modellix.design-drawer",
    order: 20,
  },
  {
    name: "settings.onboarding",
    id: "modellix.onboarding",
    order: 10,
  },
  {
    name: "settings.section",
    id: "modellix",
    order: 30,
  },
  {
    name: "conversation.session.header.utilities",
    id: "modellix.design-launcher",
    order: 20,
  },
  {
    name: "tool.call.toolview",
    key: "modellix_media_generate",
    priority: 20,
  },
  {
    name: "tool.call.toolview",
    key: "modellix_media_get_result",
    priority: 20,
  },
] as const);

export type ModellixClientSlotDefinition =
  (typeof MODELLIX_CLIENT_SLOTS)[number];
