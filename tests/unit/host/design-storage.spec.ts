import type { Context } from "@deepseek-ai/cordis";
import type { Domain } from "@deepseek-ai/dsh-storage-domain";
import { describe, expect, it, vi } from "vitest";

import {
  modellixDesignDomainSpec,
  openDesignStorage,
  type ModellixDesignDomain,
} from "../../../src/host/design-storage.js";

const MAX_VALUE_BYTES = 8 * 1024 * 1024;

describe("openDesignStorage", () => {
  it("accepts exactly 8 MiB, rejects one byte more, and validates storage keys", async () => {
    const fake = fakeDomain();
    const open = vi.fn(async () => fake.domain);
    const { storage } = await openDesignStorage(contextWithOpen(open));

    const boundaryValue = "a".repeat(MAX_VALUE_BYTES);
    await expect(storage.write("safe:key-1", boundaryValue)).resolves.toBeUndefined();
    await expect(storage.read("safe:key-1")).resolves.toBe(boundaryValue);
    expect(fake.set).toHaveBeenCalledOnce();

    await expect(
      storage.write("safe:key-2", `${boundaryValue}a`),
    ).rejects.toThrow("exceeds the Host boundary");
    expect(fake.set).toHaveBeenCalledOnce();

    await expect(storage.read("../escape")).rejects.toThrow(TypeError);
    await expect(storage.write("", "value")).rejects.toThrow(TypeError);
    expect(open).toHaveBeenCalledWith(modellixDesignDomainSpec);
  });

  it("returns the caller-owned domain and propagates its closed lifecycle", async () => {
    const fake = fakeDomain();
    const open = vi.fn(async () => fake.domain);
    const opened = await openDesignStorage(contextWithOpen(open));

    expect(opened.domain).toBe(fake.domain);
    expect(fake.close).not.toHaveBeenCalled();
    await opened.storage.write("wal", "before-close");
    await opened.domain.close();
    await opened.domain.close();

    expect(fake.close).toHaveBeenCalledTimes(2);
    await expect(opened.storage.read("wal")).rejects.toThrow("domain is closed");
    await expect(opened.storage.write("wal", "after-close")).rejects.toThrow("domain is closed");
  });
});

function fakeDomain(): {
  readonly domain: ModellixDesignDomain;
  readonly set: ReturnType<typeof vi.fn<(value: { version: 1; values: Record<string, string> }) => Promise<void>>>;
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  let state: { version: 1; values: Record<string, string> } = { version: 1, values: {} };
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new Error("domain is closed");
  };
  const set = vi.fn(async (value: { version: 1; values: Record<string, string> }) => {
    assertOpen();
    state = value;
  });
  const close = vi.fn(async () => {
    closed = true;
  });
  const domain = {
    name: "modellix_design",
    global: {
      get: () => {
        assertOpen();
        return state;
      },
      set,
    },
    table: () => {
      throw new Error("No tables are declared");
    },
    close,
  } as unknown as ModellixDesignDomain;
  return { domain, set, close };
}

function contextWithOpen(
  open: (spec: typeof modellixDesignDomainSpec) => Promise<ModellixDesignDomain>,
): Context {
  return {
    storageDomain: { open },
  } as unknown as Context;
}

// Keeps the imported public lifecycle type checked against the concrete alias.
const _domainContract: Domain<typeof modellixDesignDomainSpec> | null = null;
void _domainContract;
