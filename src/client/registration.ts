export const MODELLIX_CLIENT_SLOTS = Object.freeze([
  {
    name: "shell.overlay",
    id: "modellix.credential-recovery",
    order: 10,
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
    name: "conversation.view",
    id: "modellix.design",
    order: 20,
  },
] as const);

export type ModellixClientSlotDefinition =
  (typeof MODELLIX_CLIENT_SLOTS)[number];
