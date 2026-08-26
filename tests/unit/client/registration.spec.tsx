import { describe, expect, it } from "vitest";

import { MODELLIX_CLIENT_SLOTS } from "../../../src/client/registration.js";

describe("Modellix Client slot inventory", () => {
  it("registers only the four public Harness extension seams", () => {
    expect(MODELLIX_CLIENT_SLOTS).toEqual([
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
    ]);
  });

  it("keeps contribution identities unique and deterministic", () => {
    const identities = MODELLIX_CLIENT_SLOTS.map(
      ({ name, id }) => `${name}:${id}`,
    );
    expect(new Set(identities).size).toBe(identities.length);
    expect(MODELLIX_CLIENT_SLOTS.every(({ order }) => Number.isInteger(order))).toBe(true);
  });
});
