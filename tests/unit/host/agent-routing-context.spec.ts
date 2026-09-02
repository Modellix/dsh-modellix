import { describe, expect, it } from "vitest";

import { createModellixRoutingMessage } from "../../../src/host/agent-routing-context.js";

describe("Modellix automatic Agent routing context", () => {
  it("teaches the Agent to prefer explicit Modellix Web and media tools without magic user wording", () => {
    const message = createModellixRoutingMessage({ mediaEnabled: true, webEnabled: true });
    const serialized = JSON.stringify(message);

    expect(serialized).toContain("modellix_web_search");
    expect(serialized).toContain("modellix_web_fetch");
    expect(serialized).toContain("Prefer these explicit Modellix tools");
    expect(serialized).toContain("never call both tool families");
    expect(serialized).toContain("Do not wait for the user to name a tool");
    expect(serialized).toContain("never automatically repeat");
    expect(serialized).toContain("modellix_media_list");
    expect(serialized).toContain("modellix_media_schema");
    expect(serialized).toContain("Do not use media tools for documentation");
    expect(serialized).toContain("use the Modellix Web tools for those questions");
    expect(serialized).toContain("conversation attachments");
    expect(serialized).toContain("is not a new text-to-media request");
    expect(serialized).toContain("Never replace that source-dependent operation");
    expect(serialized).toContain("Never launch a replacement or parallel generation");
    expect(serialized).toContain("ordinary assistant text is immutable");
    expect(serialized).toContain("Hard response rule");
    expect(serialized).toContain("must not say that the task is queued, running, generating");
    expect(serialized).not.toMatch(/api.?key|authorization/iu);
  });

  it("omits disabled capabilities and returns no message when both are disabled", () => {
    expect(JSON.stringify(createModellixRoutingMessage({ mediaEnabled: false, webEnabled: true })))
      .not.toContain("modellix_media_list");
    const mediaOnly = JSON.stringify(
      createModellixRoutingMessage({ mediaEnabled: true, webEnabled: false }),
    );
    expect(mediaOnly).not.toContain("modellix_web_search");
    expect(mediaOnly).not.toContain("modellix_web_fetch");
    expect(mediaOnly).not.toContain("use the Modellix Web tools");
    expect(mediaOnly).toContain("Harness-native web_search or web_fetch");
    expect(createModellixRoutingMessage({ mediaEnabled: false, webEnabled: false })).toBeNull();
  });
});
