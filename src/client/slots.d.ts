import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Public browser Connection service installed by dsh-client-connection. */
    connection: ConnectionHandle;
  }
}

export {};
