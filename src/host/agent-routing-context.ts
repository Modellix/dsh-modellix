import { createUserMessage, type UserMessage } from "@deepseek-ai/dsh-llm";

export interface ModellixRoutingState {
  readonly mediaEnabled: boolean;
  readonly webEnabled: boolean;
}

export function createModellixRoutingMessage(state: ModellixRoutingState): UserMessage | null {
  const sections: { readonly name: string; readonly text: string }[] = [];
  const nonMediaWebRouting = state.webEnabled
    ? "use the Modellix Web tools for those questions"
    : "leave those questions to the Harness-native web_search or web_fetch tools when available";
  if (state.webEnabled) {
    sections.push({
      name: "Web routing",
      text: "Use modellix_web_search automatically for current, changing, external, or source-verification questions. Use modellix_web_fetch automatically when the user supplies a public URL or a Modellix search result needs full-page reading. Prefer these explicit Modellix tools over the native web_search and web_fetch tools, and never call both tool families for the same operation. Do not wait for the user to name a tool, do not browse when the user explicitly says not to, and never automatically repeat a failed or unknown Modellix Web request.",
    });
  }
  if (state.mediaEnabled) {
    sections.push({
      name: "Media routing",
      text: `Use Modellix media tools automatically only when the user intends to create, edit, transform, animate, upload, or inspect generated image, video, or audio work. Do not use media tools for documentation, pricing, general model-capability, or public API-reference questions; ${nonMediaWebRouting} unless the user explicitly requests a live Modellix Design model Schema. For media work, use modellix_media_list then modellix_media_schema when a compatible model is not already known. Treat every returned field description and allowed value as authoritative; do not guess, translate, or replace a published parameter format, and omit optional fields when the user did not request them. A request that refers to the previous/current work, conversation attachments, or prior Modellix result URLs, asks to change or animate it, or asks to preserve its composition, subject, identity, or structure is not a new text-to-media request: select an image-edit/image-to-image, image-to-video, or video-to-video model as appropriate, inspect its schema, and place the latest relevant Modellix result URL in the declared media input field. Never replace that source-dependent operation with text-to-image or text-to-video. Reuse usable URLs and upload local inputs with modellix_media_upload_file. After submitting, inspect the task at most once in the same turn. Hard response rule: while a task is nonterminal, ordinary assistant text may say only that the submission was accepted and that the result card and Modellix Design own the current status. It must not say that the task is queued, running, generating, processing, pending, or any equivalent current-state wording, because ordinary assistant text is immutable and becomes stale. Never launch a replacement or parallel generation while a matching task is active unless the user explicitly requests another result, and never repeat an unknown generation or upload outcome.`,
    });
  }
  if (sections.length === 0) return null;
  return createUserMessage({
    content: [{
      type: "text",
      text: sections.map((section) => `${section.name}: ${section.text}`).join("\n"),
    }],
    source: {
      kind: "plugin",
      plugin: "dsh-modellix",
      form: "snapshot",
      sections,
    },
  });
}
