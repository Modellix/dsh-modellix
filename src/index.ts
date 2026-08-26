import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-credentials";
import type {} from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-storage-domain";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-web";

import { ModellixRuntime } from "./host/runtime.js";

export const name = "modellix";
export const inject = ["settings", "credentials", "llm", "web", "connection", "storageDomain", "tools"];

export interface Config {}

export const Config: z<Config> = z.object({});

export async function apply(ctx: Context): Promise<void> {
  await ModellixRuntime.create(ctx);
}

export * from "./core/index.js";
export * from "./design/index.js";
export * from "./host/index.js";
export * from "./llm/index.js";
export * from "./web/index.js";
