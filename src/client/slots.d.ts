import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Public browser Connection service installed by dsh-client-connection. */
    connection: ConnectionHandle;
  }
}

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    /** DSH 0.1.1-rc.2 public session-scoped conversation view seam. */
    "conversation.view": {
      kind: "list";
      scope: "session";
      owner: {
        inspect?: { callId: string } | null;
        onInspectDone?: () => void;
      };
    };
  }
}

export {};
