import type { Context } from "@deepseek-ai/cordis";
import {
  defineDomain,
  type Domain,
} from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import type { StoragePort } from "../design/index.js";

const designStorageState = z.object({
  version: z.literal(1),
  values: z.record(z.string(), z.string()),
});

/** One atomic singleton keeps the Design WAL independent of Settings. */
export const modellixDesignDomainSpec = defineDomain({
  name: "modellix_design",
  version: 1,
  global: {
    schema: designStorageState,
    initial: { version: 1 as const, values: {} as Record<string, string> },
  },
  tables: {},
});

export type ModellixDesignDomain = Domain<typeof modellixDesignDomainSpec>;

export async function openDesignStorage(ctx: Context): Promise<{
  readonly domain: ModellixDesignDomain;
  readonly storage: StoragePort;
}> {
  const domain = await ctx.storageDomain.open(modellixDesignDomainSpec);
  return {
    domain,
    storage: {
      read: async (key) => {
        assertStorageKey(key);
        return domain.global.get().values[key] ?? null;
      },
      write: async (key, value) => {
        assertStorageKey(key);
        if (new TextEncoder().encode(value).byteLength > 8 * 1024 * 1024) {
          throw new Error("Design storage value exceeds the Host boundary");
        }
        const current = domain.global.get();
        await domain.global.set({
          version: 1,
          values: { ...current.values, [key]: value },
        });
      },
    },
  };
}

function assertStorageKey(key: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(key)) {
    throw new TypeError("Design storage key is invalid");
  }
}
