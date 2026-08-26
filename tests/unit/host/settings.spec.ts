import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../../../src/core/config.js";
import { PluginSettingsSchema } from "../../../src/host/settings.js";

describe("PluginSettingsSchema", () => {
  it("accepts legacy retain-input settings but resolves them to metadata-only", () => {
    const defaults = createDefaultConfig();
    const parsed = PluginSettingsSchema({
      ...defaults,
      services: {
        ...defaults.services,
        design: {
          ...defaults.services.design,
          retentionPolicy: "retain-input",
          retentionPolicyRevision: 9,
        },
      },
    } as never);

    expect(parsed.services.design.retentionPolicy).toBe("metadata-only");
    expect(parsed.services.design.retentionPolicyRevision).toBe(9);
  });
});
