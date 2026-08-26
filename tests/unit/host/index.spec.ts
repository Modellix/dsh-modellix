import { afterEach, describe, expect, it, vi } from "vitest";

const RUNTIME_MODULE = "../../../src/host/runtime.js";

afterEach(() => {
  vi.doUnmock(RUNTIME_MODULE);
  vi.resetModules();
});

describe("Modellix Host entry point", () => {
  it("publishes the fixed plugin contract and awaits runtime creation", async () => {
    const create = vi.fn(async () => undefined);
    vi.doMock(RUNTIME_MODULE, () => ({
      ModellixRuntime: { create },
    }));

    const entry = await import("../../../src/index.js");
    const context = { marker: "host-context" };

    expect(entry.name).toBe("modellix");
    expect(entry.inject).toEqual([
      "settings",
      "credentials",
      "llm",
      "web",
      "connection",
      "storageDomain",
      "tools",
    ]);

    await entry.apply(context as never);

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(context);
  });
});
