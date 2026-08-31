import { describe, expect, it } from "vitest";

import { MODELLIX_CLIENT_SLOTS } from "../../../src/client/registration.js";

describe("Modellix Client slot inventory", () => {
  it("registers the chat-first drawer and media result extension seams", () => {
    expect(MODELLIX_CLIENT_SLOTS).toEqual([
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
    ]);
  });

  it("keeps contribution identities unique and deterministic", () => {
    const identities = MODELLIX_CLIENT_SLOTS.map((slot) =>
      `${slot.name}:${"id" in slot ? slot.id : slot.key}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(MODELLIX_CLIENT_SLOTS.every((slot) =>
      Number.isInteger("order" in slot ? slot.order : slot.priority))).toBe(true);
  });
});
