import { createHash } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import {
  defineTool,
  type JsonValue as ToolJsonValue,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";

import { DesignError, type JsonValue as DesignJsonValue } from "../design/index.js";
import {
  MediaUploadClient,
  prepareMediaUploadFromPath,
  prepareMediaUploadFromSession,
} from "../design/media-upload-client.js";
import { DESIGN_JSON_LIMITS } from "../shared/design-wire-limits.js";
import { inspectJsonBudget } from "../shared/json-budget.js";
import type { DesignSnapshotWire } from "./design-controller.js";

export const MODELLIX_MEDIA_LIST_TOOL = "modellix_media_list";
export const MODELLIX_MEDIA_SCHEMA_TOOL = "modellix_media_schema";
export const MODELLIX_MEDIA_PREPARE_TOOL = "modellix_media_prepare";
export const MODELLIX_MEDIA_UPLOAD_FILE_TOOL = "modellix_media_upload_file";
export const MODELLIX_MEDIA_GENERATE_TOOL = "modellix_media_generate";
export const MODELLIX_MEDIA_GET_RESULT_TOOL = "modellix_media_get_result";

const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_QUERY_LENGTH = 512;
const MAX_INSTRUCTION_LENGTH = 64 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MODEL_LIMIT = 20;
const MAX_MODEL_LIMIT = 50;
const MAX_SCHEMA_FIELDS = 128;

type DesignJob = DesignSnapshotWire["jobs"][number];
type DesignDraft = NonNullable<DesignSnapshotWire["draft"]>;

/** The deliberately narrow Host seam used by model-facing Design tools. */
export interface DesignToolController {
  handle(
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<DesignSnapshotWire>;
  resolveCredential?(): Promise<string | undefined>;
}

interface ModellixMediaListResult {
  readonly version: 1;
  readonly service: "media";
  readonly operation: "list";
  readonly models: {
    readonly modelId: string;
    readonly label: string;
    readonly kind: "image" | "video" | "audio" | "unknown";
    readonly taskType?: string;
    readonly description?: string;
    readonly featured: boolean;
    readonly available: boolean;
    readonly unavailableReason?: string;
  }[];
  readonly truncated: boolean;
}

interface ModellixMediaSchemaResult {
  readonly version: 1;
  readonly service: "media";
  readonly operation: "schema";
  readonly modelId: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly schema?: {
    readonly modelId: string;
    readonly irContractHash: string;
    readonly primaryInputPath: string;
    readonly fields: {
      readonly path: string;
      readonly label: string;
      readonly kind: string;
      readonly required: boolean;
      readonly options: ToolJsonValue[];
      readonly description?: string;
    }[];
    readonly truncated: boolean;
  };
}

interface ModellixMediaPrepareResult {
  readonly version: 1;
  readonly service: "media";
  readonly operation: "prepare";
  readonly modelId: string;
  readonly irContractHash: string;
  readonly proposalId: string;
  readonly baseDraftRevision: number;
  readonly summary: string;
  readonly changes: {
    readonly path: string;
    readonly label: string;
    readonly before?: ToolJsonValue;
    readonly after?: ToolJsonValue;
  }[];
  readonly conflicts: string[];
  readonly requiresConfirmation: true;
}

interface ModellixMediaUploadResult {
  readonly version: 1;
  readonly service: "media";
  readonly operation: "upload_file";
  readonly fileId: string;
  readonly type: string;
  readonly url: string;
  readonly filename: string;
  readonly size: number;
  readonly createdAt?: string;
  readonly noAutomaticRetry: true;
}

interface ModellixMediaGenerateResult {
  readonly version: 1;
  readonly service: "media";
  readonly operation: "generate";
  readonly modelId: string;
  readonly submitted: true;
  readonly noAutomaticRetry: true;
  readonly status: DesignJob["status"];
  readonly jobId?: string;
  readonly resources: {
    readonly kind: "image" | "video" | "audio";
    readonly url: string;
    readonly expiresAt?: string;
  }[];
  readonly diagnostic?: {
    readonly code: string;
    readonly message: string;
  };
}

interface ModellixMediaGetResultResult {
  readonly version: 1;
  readonly service: "media";
  readonly operation: "get_result";
  readonly found: boolean;
  readonly job?: {
    readonly jobId: string;
    readonly modelId: string;
    readonly status: DesignJob["status"];
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly resources: {
      readonly kind: "image" | "video" | "audio";
      readonly url: string;
      readonly expiresAt?: string;
    }[];
    readonly diagnostic?: {
      readonly code: string;
      readonly message: string;
    };
  };
}

/**
 * Build the six stable, namespaced Modellix media tools. The caller owns
 * visibility and must only register these definitions while Design is enabled.
 */
export function createModellixDesignToolDefinitions(
  controller: DesignToolController,
  uploadClient?: MediaUploadClient,
): readonly ToolDefinition[] {
  const uploads = uploadClient ?? new MediaUploadClient();
  return [
    createListTool(controller),
    createSchemaTool(controller),
    createPrepareTool(controller),
    createUploadFileTool(uploads, controller.resolveCredential),
    createGenerateTool(controller),
    createGetResultTool(controller),
  ];
}

/**
 * Register media tools. The returned disposer removes every definition, allowing the runtime to
 * mirror the live Design toggle without leaving model-visible stale tools.
 */
export function registerModellixDesignTools(
  ctx: Context,
  controller: DesignToolController,
): () => void {
  const disposers: (() => unknown)[] = [];
  try {
    for (const definition of createModellixDesignToolDefinitions(controller)) {
      disposers.push(ctx.tools.register(definition));
    }
  } catch (error) {
    disposeAll(disposers);
    throw error;
  }
  return () => disposeAll(disposers);
}

function createListTool(controller: DesignToolController): ToolDefinition {
  return defineTool({
    name: MODELLIX_MEDIA_LIST_TOOL,
    description: "List and search the live Modellix media model catalog. Use this before generation when no compatible provider/model slug is already known. This read-only tool never accepts credentials.",
    parameters: {
      query: { type: "string", description: "Optional case-insensitive model, provider, or media-kind search." },
      limit: { type: "integer", description: `Maximum models to return (default ${String(DEFAULT_MODEL_LIMIT)}, maximum ${String(MAX_MODEL_LIMIT)}).` },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: "integer", const: 1, required: true },
          service: { type: "string", const: "media", required: true },
          operation: { type: "string", const: "list", required: true },
          models: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                modelId: { type: "string", required: true },
                label: { type: "string", required: true },
                kind: { type: "string", enum: ["image", "video", "audio", "unknown"], required: true },
                taskType: { type: "string" },
                description: { type: "string" },
                featured: { type: "boolean", required: true },
                available: { type: "boolean", required: true },
                unavailableReason: { type: "string" },
              },
            },
          },
          truncated: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: formatModels(value) }],
    },
    async execute(args, exec) {
      assertOnlyKeys(args, ["query", "limit"]);
      throwIfAborted(exec.signal);
      const sessionId = sessionIdFrom(exec);
      const query = optionalBoundedText(args.query, "query", MAX_QUERY_LENGTH)?.toLowerCase() ?? "";
      const limit = boundedLimit(args.limit);
      const snapshot = await controller.handle(
        "design/read",
        { version: 1, sessionId },
        exec.signal,
      );
      requireReady(snapshot);

      throwIfAborted(exec.signal);
      return projectModels(snapshot, query, limit);
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Browse Modellix media models",
      kind: "search",
      ...(args.query === undefined ? {} : { rawInput: args.query }),
    }),
  });
}

function createSchemaTool(controller: DesignToolController): ToolDefinition {
  return defineTool({
    name: MODELLIX_MEDIA_SCHEMA_TOOL,
    description: "Get the current Modellix API schema for one exact media model. Use the returned field paths and contract hash before prepare or generate; do not guess model parameters.",
    parameters: {
      model: { type: "string", required: true, description: "Exact provider/model slug returned by modellix_media_list." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: "integer", const: 1, required: true },
          service: { type: "string", const: "media", required: true },
          operation: { type: "string", const: "schema", required: true },
          modelId: { type: "string", required: true },
          available: { type: "boolean", required: true },
          unavailableReason: { type: "string" },
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              modelId: { type: "string", required: true },
              irContractHash: { type: "string", required: true },
              primaryInputPath: { type: "string", required: true },
              fields: {
                type: "array",
                required: true,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    path: { type: "string", required: true },
                    label: { type: "string", required: true },
                    kind: { type: "string", required: true },
                    required: { type: "boolean", required: true },
                    options: { type: "array", required: true, items: { type: "json" } },
                    description: { type: "string" },
                  },
                },
              },
              truncated: { type: "boolean", required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: formatSchema(value) }],
    },
    async execute(args, exec) {
      assertOnlyKeys(args, ["model"]);
      const modelId = requireModel(args.model);
      const sessionId = sessionIdFrom(exec);
      const read = await controller.handle("design/read", { version: 1, sessionId }, exec.signal);
      requireReady(read);
      requireCatalogModel(read, modelId);
      throwIfAborted(exec.signal);
      try {
        const selected = await controller.handle("design/select-model", {
          version: 1,
          sessionId,
          modelId,
        }, exec.signal);
        return projectSchema(requireDraft(selected, modelId));
      } catch (error) {
        if (!isUnsupportedSchema(error)) throw error;
        return projectUnsupportedSchema(modelId);
      }
    },
    presentCall: (args) => ({ card: "generic", title: `Inspect ${args.model} schema`, kind: "read" }),
  });
}

function createUploadFileTool(
  client: MediaUploadClient,
  resolveCredential: DesignToolController["resolveCredential"],
): ToolDefinition {
  return defineTool({
    name: MODELLIX_MEDIA_UPLOAD_FILE_TOOL,
    description: "Upload one image from the current conversation or session workspace to Modellix and return a temporary URL for media model inputs. Supply exactly one of attachment_id or path. Reuse returned URLs and never retry an unknown upload outcome automatically.",
    parameters: {
      attachment_id: { type: "string", description: "Attachment ID from an image in this conversation." },
      path: { type: "string", description: "Image path inside the current session workspace." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: "integer", const: 1, required: true },
          service: { type: "string", const: "media", required: true },
          operation: { type: "string", const: "upload_file", required: true },
          fileId: { type: "string", required: true },
          type: { type: "string", required: true },
          url: { type: "string", required: true },
          filename: { type: "string", required: true },
          size: { type: "integer", required: true },
          createdAt: { type: "string" },
          noAutomaticRetry: { type: "boolean", const: true, required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `Uploaded ${value.filename} for Modellix media input: ${value.url}\nReuse this URL; do not upload the same file again unless the URL is no longer usable.`,
      }],
    },
    async execute(args, exec) {
      assertOnlyKeys(args, ["attachment_id", "path"]);
      const attachmentId = optionalBoundedText(args.attachment_id, "attachment_id", 512);
      const path = optionalBoundedText(args.path, "path", 32_767);
      if ((attachmentId === undefined) === (path === undefined)) {
        throw new DesignError("INVALID_ARGUMENT", "Provide exactly one of attachment_id or path");
      }
      const prepared = attachmentId === undefined
        ? await prepareMediaUploadFromPath(exec.agent?.session.header.cwd, path as string)
        : await prepareMediaUploadFromSession(exec.agent, attachmentId, exec.signal);
      throwIfAborted(exec.signal);
      const apiKey = await resolveCredential?.();
      if (apiKey === undefined) throw new DesignError("MISSING_API_KEY", "A Modellix API key is required");
      const uploaded = await client.upload({ ...prepared, apiKey, signal: exec.signal });
      const result: ModellixMediaUploadResult = {
        version: 1,
        service: "media",
        operation: "upload_file",
        fileId: uploaded.fileId,
        type: uploaded.type,
        url: uploaded.url,
        filename: uploaded.filename,
        size: uploaded.size,
        ...(uploaded.createdAt === null ? {} : { createdAt: uploaded.createdAt }),
        noAutomaticRetry: true,
      };
      return result;
    },
    presentCall: () => ({ card: "generic", title: "Upload media to Modellix", kind: "execute" }),
  });
}

function createPrepareTool(controller: DesignToolController): ToolDefinition {
  return defineTool({
    name: MODELLIX_MEDIA_PREPARE_TOOL,
    description: "Convert a natural-language media request into a schema-constrained parameter proposal for one exact provider/model slug. Use this for Modellix Design parameter editing; it never submits media generation.",
    parameters: {
      model: { type: "string", required: true, description: "Exact provider/model slug from modellix_media_list." },
      instruction: { type: "string", required: true, description: "Prompt or conservative parameter instruction. Plain text updates only the schema-declared primary input; other fields require explicit assignments." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: "integer", const: 1, required: true },
          service: { type: "string", const: "media", required: true },
          operation: { type: "string", const: "prepare", required: true },
          modelId: { type: "string", required: true },
          irContractHash: { type: "string", required: true },
          proposalId: { type: "string", required: true },
          baseDraftRevision: { type: "integer", required: true },
          summary: { type: "string", required: true },
          changes: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", required: true },
                label: { type: "string", required: true },
                before: { type: "json" },
                after: { type: "json" },
              },
            },
          },
          conflicts: { type: "array", required: true, items: { type: "string" } },
          requiresConfirmation: { type: "boolean", const: true, required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: formatPreparation(value) }],
    },
    async execute(args, exec) {
      assertOnlyKeys(args, ["model", "instruction"]);
      throwIfAborted(exec.signal);
      const modelId = requireModel(args.model);
      const instruction = requiredBoundedText(args.instruction, "instruction", MAX_INSTRUCTION_LENGTH);
      const sessionId = sessionIdFrom(exec);
      const read = await controller.handle(
        "design/read",
        { version: 1, sessionId },
        exec.signal,
      );
      requireReady(read);
      requireCatalogModel(read, modelId);
      throwIfAborted(exec.signal);
      const selected = await controller.handle("design/select-model", {
        version: 1,
        sessionId,
        modelId,
      }, exec.signal);
      const draft = requireDraft(selected, modelId);
      throwIfAborted(exec.signal);
      const proposed = await controller.handle("design/propose", {
        version: 1,
        sessionId,
        modelId,
        instruction,
        draftRevision: draft.draftRevision,
        irContractHash: draft.irContractHash,
        parameters: draft.parameters,
      }, exec.signal);
      throwIfAborted(exec.signal);
      const proposal = proposed.proposal;
      if (proposal === null) throw new DesignError("UNEXPECTED_RESPONSE", "Design did not return a parameter proposal");
      const result: ModellixMediaPrepareResult = {
        version: 1,
        service: "media",
        operation: "prepare",
        modelId,
        irContractHash: draft.irContractHash,
        proposalId: proposal.proposalId,
        baseDraftRevision: proposal.baseDraftRevision,
        summary: proposal.summary,
        changes: proposal.changes.map((change) => ({
          path: change.path,
          label: change.label,
          ...(change.before === undefined ? {} : { before: toToolJson(change.before) }),
          ...(change.after === undefined ? {} : { after: toToolJson(change.after) }),
        })),
        conflicts: [...proposal.conflicts],
        requiresConfirmation: true,
      };
      return result;
    },
    presentCall: (args) => ({ card: "generic", title: `Prepare ${args.model}`, kind: "execute" }),
  });
}

function createGenerateTool(controller: DesignToolController): ToolDefinition {
  return defineTool({
    name: MODELLIX_MEDIA_GENERATE_TOOL,
    description: "Generate or edit image, video, or audio with one exact Modellix media model. Choose text-to-media for a new work; reuse the latest relevant media URL or uploaded file for edit/image-to-video/video-to-video requests. Use schema fields from modellix_media_schema. Never include an API key, never retry an unknown submission outcome, and never start a replacement or parallel generation while a matching task is queued or running unless the user explicitly asks for another result.",
    parameters: {
      model: { type: "string", required: true, description: "Exact provider/model slug from the live Design catalog." },
      prompt: { type: "string", description: "Primary prompt/text. It is mapped to the model schema's declared primary input field." },
      input: {
        type: "object",
        additionalProperties: true,
        description: "Optional schema-constrained input overrides. Keys may be top-level field names or exact RFC 6901 paths from the compact schema.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: "integer", const: 1, required: true },
          service: { type: "string", const: "media", required: true },
          operation: { type: "string", const: "generate", required: true },
          modelId: { type: "string", required: true },
          submitted: { type: "boolean", const: true, required: true },
          noAutomaticRetry: { type: "boolean", const: true, required: true },
          status: { type: "string", enum: ["running", "succeeded", "failed", "canceled", "submit-unknown", "expired"], required: true },
          jobId: { type: "string" },
          resources: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: ["image", "video", "audio"], required: true },
                url: { type: "string", required: true },
                expiresAt: { type: "string" },
              },
            },
          },
          diagnostic: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: { type: "string", required: true },
              message: { type: "string", required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: formatGeneration(value) }],
      presentationMeta: (_args, value) => value,
    },
    async execute(args, exec) {
      assertOnlyKeys(args, ["model", "prompt", "input"]);
      throwIfAborted(exec.signal);
      const modelId = requireModel(args.model);
      const prompt = optionalBoundedText(args.prompt, "prompt", MAX_INSTRUCTION_LENGTH);
      const sessionId = sessionIdFrom(exec);
      const read = await controller.handle(
        "design/read",
        { version: 1, sessionId },
        exec.signal,
      );
      requireReady(read);
      requireCatalogModel(read, modelId);
      throwIfAborted(exec.signal);
      const selected = await controller.handle("design/select-model", {
        version: 1,
        sessionId,
        modelId,
      }, exec.signal);
      const draft = requireDraft(selected, modelId);
      const parameters = normalizeGenerationInput(draft, prompt, args.input);
      throwIfAborted(exec.signal);
      try {
        const submitted = await controller.handle("design/submit", {
          version: 1,
          sessionId,
          modelId,
          draftRevision: draft.draftRevision,
          irContractHash: draft.irContractHash,
          parameters,
        }, exec.signal);
        return projectGeneration(modelId, findNewJob(selected.jobs, submitted.jobs));
      } catch (error) {
        if (!(error instanceof DesignError) || error.code !== "SUBMIT_UNKNOWN") throw error;
        // The controller has already persisted the non-replayable WAL state.
        // Return a successful canonical warning so the model is not invited to
        // treat an ambiguous generation POST like an ordinary retryable tool error.
        const result: ModellixMediaGenerateResult = {
          version: 1,
          service: "media",
          operation: "generate",
          modelId,
          submitted: true,
          noAutomaticRetry: true,
          status: "submit-unknown",
          resources: [],
          diagnostic: {
            code: "submit-unknown",
            message: "The generation outcome is unknown. Do not retry automatically; inspect Modellix Design results or the Modellix console.",
          },
        };
        return result;
      }
    },
    presentCall: (args) => ({ card: "generic", title: `Generate with ${args.model}`, kind: "execute" }),
  });
}

function createGetResultTool(controller: DesignToolController): ToolDefinition {
  return defineTool({
    name: MODELLIX_MEDIA_GET_RESULT_TOOL,
    description: "Refresh and inspect an existing Modellix media generation at most once per Agent turn. For a nonterminal result, the assistant may only confirm submission and direct the user to the live result card or Modellix Design; it must not write queued, running, generating, processing, pending, or equivalent status wording in ordinary assistant text. Accepts a remote task ID or local submit-unknown request ID and never resubmits or replaces generation.",
    parameters: {
      task_id: { type: "string", required: true, description: "Existing remote task ID or local Design request ID." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: "integer", const: 1, required: true },
          service: { type: "string", const: "media", required: true },
          operation: { type: "string", const: "get_result", required: true },
          found: { type: "boolean", required: true },
          job: {
            type: "object",
            additionalProperties: false,
            properties: {
              jobId: { type: "string", required: true },
              modelId: { type: "string", required: true },
              status: { type: "string", enum: ["running", "succeeded", "failed", "canceled", "submit-unknown", "expired"], required: true },
              createdAt: { type: "string", required: true },
              updatedAt: { type: "string", required: true },
              resources: {
                type: "array",
                required: true,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    kind: { type: "string", enum: ["image", "video", "audio"], required: true },
                    url: { type: "string", required: true },
                    expiresAt: { type: "string" },
                  },
                },
              },
              diagnostic: {
                type: "object",
                additionalProperties: false,
                properties: {
                  code: { type: "string", required: true },
                  message: { type: "string", required: true },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: formatTask(value) }],
      presentationMeta: (_args, value) => value,
    },
    async execute(args, exec) {
      assertOnlyKeys(args, ["task_id"]);
      throwIfAborted(exec.signal);
      const taskId = requiredBoundedText(args.task_id, "task_id", 256);
      if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(taskId)) {
        throw new DesignError("INVALID_ARGUMENT", "task_id is malformed");
      }
      const snapshot = await controller.handle("design/read", {
        version: 1,
        sessionId: sessionIdFrom(exec),
      }, exec.signal);
      requireReady(snapshot);
      throwIfAborted(exec.signal);
      const job = snapshot.jobs.find((candidate) => candidate.jobId === taskId);
      const result: ModellixMediaGetResultResult = job === undefined
        ? { version: 1, service: "media", operation: "get_result", found: false }
        : { version: 1, service: "media", operation: "get_result", found: true, job: projectJob(job) };
      return result;
    },
    presentCall: (args) => ({ card: "generic", title: `Inspect Design task ${args.task_id}`, kind: "read" }),
  });
}

function projectModels(
  snapshot: DesignSnapshotWire,
  query: string,
  limit: number,
): ModellixMediaListResult {
  const matches = snapshot.models.filter((model) =>
    query === "" || [model.id, model.label, model.kind, model.taskType, model.description]
      .some((value) => value?.toLowerCase().includes(query) === true));
  const models = matches.slice(0, limit).map((model) => ({
    modelId: model.id,
    label: model.label,
    kind: model.kind,
    ...(model.taskType === undefined ? {} : { taskType: model.taskType }),
    ...(model.description === undefined ? {} : { description: model.description }),
    featured: model.featured,
    available: model.available,
    ...(model.unavailableReason === null
      ? {}
      : { unavailableReason: modelUnavailableMessage(model.unavailableReason) }),
  }));
  return {
    version: 1,
    service: "media",
    operation: "list",
    models,
    truncated: matches.length > models.length,
  };
}

function projectSchema(draft: DesignDraft): ModellixMediaSchemaResult {
  return {
    version: 1,
    service: "media",
    operation: "schema",
    modelId: draft.modelId,
    available: true,
    schema: {
      modelId: draft.modelId,
      irContractHash: draft.irContractHash,
      primaryInputPath: draft.primaryInputPath,
      fields: draft.fields.slice(0, MAX_SCHEMA_FIELDS).map((field) => ({
        path: field.path,
        label: field.label,
        kind: field.kind,
        required: field.required,
        options: field.options.map((option) => option.value),
        ...(field.description === null ? {} : { description: field.description }),
      })),
      truncated: draft.fields.length > MAX_SCHEMA_FIELDS,
    },
  };
}

function projectUnsupportedSchema(modelId: string): ModellixMediaSchemaResult {
  return {
    version: 1,
    service: "media",
    operation: "schema",
    modelId,
    available: false,
    unavailableReason: "This model's API schema is not compatible with Modellix Design. Choose another model from the live catalog.",
  };
}

function normalizeGenerationInput(
  draft: DesignDraft,
  prompt: string | undefined,
  input: Readonly<Record<string, ToolJsonValue>> | undefined,
): Readonly<Record<string, DesignJsonValue>> {
  const source = input ?? {};
  const violation = inspectJsonBudget(source, {
    ...DESIGN_JSON_LIMITS,
    maxBytes: MAX_INPUT_BYTES,
  });
  if (violation !== null) {
    throw new DesignError(
      "INVALID_ARGUMENT",
      violation === "bytes"
        ? `input exceeds ${String(MAX_INPUT_BYTES)} bytes`
        : "input exceeds the Design JSON structural budget",
    );
  }
  const fields = new Set(draft.fields.map((field) => field.path));
  const parameters: Record<string, DesignJsonValue> = {};
  for (const [key, value] of Object.entries(source)) {
    const path = key.startsWith("/") ? key : `/${escapePointerToken(key)}`;
    if (!fields.has(path)) {
      throw new DesignError("PARAMETER_INVALID", `Unknown model field: ${path}`);
    }
    if (Object.hasOwn(parameters, path)) {
      throw new DesignError("PARAMETER_INVALID", `Duplicate model field: ${path}`);
    }
    parameters[path] = value;
  }
  if (prompt !== undefined) {
    const prior = parameters[draft.primaryInputPath];
    if (prior !== undefined && prior !== prompt) {
      throw new DesignError("PARAMETER_INVALID", "prompt conflicts with input at the schema primary input path");
    }
    parameters[draft.primaryInputPath] = prompt;
  }
  return parameters;
}

function projectGeneration(
  modelId: string,
  job: DesignJob | undefined,
): ModellixMediaGenerateResult {
  if (job === undefined) {
    return {
      version: 1,
      service: "media",
      operation: "generate",
      modelId,
      submitted: true,
      noAutomaticRetry: true,
      status: "submit-unknown",
      resources: [],
      diagnostic: {
        code: "job-record-unavailable",
        message: "The generation returned without a readable local job record. Do not retry automatically.",
      },
    };
  }
  return {
    version: 1,
    service: "media",
    operation: "generate",
    modelId,
    submitted: true,
    noAutomaticRetry: true,
    status: job.status,
    jobId: job.jobId,
    resources: projectResources(job),
    ...(job.diagnostic === null ? {} : {
      diagnostic: {
        code: job.diagnostic.code,
        message: diagnosticMessage(job.diagnostic.code),
      },
    }),
  };
}

function projectJob(job: DesignJob): NonNullable<ModellixMediaGetResultResult["job"]> {
  return {
    jobId: job.jobId,
    modelId: job.modelId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    resources: projectResources(job),
    ...(job.diagnostic === null ? {} : {
      diagnostic: {
        code: job.diagnostic.code,
        message: diagnosticMessage(job.diagnostic.code),
      },
    }),
  };
}

function projectResources(job: DesignJob): ModellixMediaGenerateResult["resources"] {
  return job.resources.map((resource) => ({
    kind: resource.kind,
    url: resource.url,
    ...(resource.expiresAt === null ? {} : { expiresAt: resource.expiresAt }),
  }));
}

function findNewJob(
  before: readonly DesignJob[],
  after: readonly DesignJob[],
): DesignJob | undefined {
  const known = new Set(before.map((job) => job.jobId));
  return after.find((job) => !known.has(job.jobId));
}

function requireReady(snapshot: DesignSnapshotWire): void {
  if (!snapshot.enabled) throw new DesignError("INVALID_ARGUMENT", "Modellix Design is disabled");
  if (!snapshot.credentialReady) throw new DesignError("MISSING_API_KEY", "A Modellix API key is required");
}

function requireCatalogModel(snapshot: DesignSnapshotWire, modelId: string): void {
  const model = snapshot.models.find((candidate) => candidate.id === modelId);
  if (model === undefined) {
    throw new DesignError("INVALID_ARGUMENT", "The selected model is not in the current Modellix Design catalog");
  }
  if (!model.available) {
    throw new DesignError("SCHEMA_INVALID", "The selected model is unavailable");
  }
}

function requireDraft(snapshot: DesignSnapshotWire, modelId: string): DesignDraft {
  if (snapshot.draft === null || snapshot.draft.modelId !== modelId) {
    throw new DesignError("SCHEMA_INVALID", "The selected model did not return a usable Design schema");
  }
  return snapshot.draft;
}

function sessionIdFrom(exec: ToolRunContext): string {
  if (exec.agent === undefined) {
    throw new DesignError("INVALID_ARGUMENT", "A Modellix Design tool requires an active Harness session");
  }
  const raw = String(exec.agent.id);
  return SAFE_SESSION_ID.test(raw)
    ? raw
    : `tool_${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 48)}`;
}

function requireModel(value: string): string {
  if (!MODEL_SLUG.test(value)) {
    throw new DesignError("INVALID_ARGUMENT", "model must use the exact provider/model form");
  }
  return value;
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MODEL_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MODEL_LIMIT) {
    throw new DesignError("INVALID_ARGUMENT", `limit must be an integer from 1 through ${String(MAX_MODEL_LIMIT)}`);
  }
  return limit;
}

function optionalBoundedText(
  value: string | undefined,
  field: string,
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > maximum) {
    throw new DesignError("INVALID_ARGUMENT", `${field} exceeds ${String(maximum)} characters`);
  }
  return value;
}

function requiredBoundedText(value: string, field: string, maximum: number): string {
  if (value.trim() === "" || value.length > maximum) {
    throw new DesignError("INVALID_ARGUMENT", `${field} must be non-empty and at most ${String(maximum)} characters`);
  }
  return value;
}

function assertOnlyKeys(value: object, allowed: readonly string[]): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) {
    throw new DesignError("INVALID_ARGUMENT", `Unknown tool argument: ${extra}`);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Modellix Design tool call aborted");
  error.name = "AbortError";
  throw error;
}

function escapePointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function toToolJson(value: DesignJsonValue): ToolJsonValue {
  if (Array.isArray(value)) return value.map(toToolJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toToolJson(item)]),
    );
  }
  return value;
}

function formatModels(value: ModellixMediaListResult): string {
  const lines = value.models.map((model) =>
    `- ${model.modelId} (${model.taskType ?? model.kind})${model.available ? "" : " — unavailable"}${model.description === undefined ? "" : `: ${model.description}`}`);
  return `${lines.length === 0 ? "No matching Modellix media models." : lines.join("\n")}${value.truncated ? "\n(Results truncated; refine the query.)" : ""}`;
}

function formatSchema(value: ModellixMediaSchemaResult): string {
  if (!value.available || value.schema === undefined) {
    return `Schema for ${value.modelId} is unavailable to Modellix Design. ${value.unavailableReason ?? "Choose another model from the live catalog."}`;
  }
  const fields = value.schema.fields.map((field) => {
    const qualifiers = [
      field.kind,
      field.required ? "required" : "optional",
      field.options.length === 0
        ? null
        : `allowed values: ${field.options.map((option) => JSON.stringify(option)).join(", ")}`,
    ].filter((qualifier): qualifier is string => qualifier !== null);
    return `- ${field.path} (${qualifiers.join("; ")})${field.description === undefined ? "" : ` — ${field.description}`}`;
  });
  return [
    `Schema for ${value.schema.modelId}. Primary input: ${value.schema.primaryInputPath}. Use the exact field descriptions and allowed values below; do not infer a different format.`,
    fields.length === 0 ? "No input fields." : fields.join("\n"),
    value.schema.truncated ? "The field list is truncated." : null,
  ].filter((line): line is string => line !== null).join("\n");
}

function isUnsupportedSchema(error: unknown): boolean {
  return error instanceof DesignError &&
    (error.code === "SCHEMA_INVALID" || error.code === "ENDPOINT_NOT_ALLOWED");
}

function formatPreparation(value: ModellixMediaPrepareResult): string {
  const changes = value.changes.map((change) => `- ${change.path} (${change.label})`).join("\n");
  const conflicts = value.conflicts.length === 0 ? "" : `\nConflicts: ${value.conflicts.join("; ")}`;
  return `${value.summary}\n${changes || "No parameter changes were proposed."}${conflicts}\nReview and explicitly confirm before generation.`;
}

function modelUnavailableMessage(
  code: NonNullable<DesignSnapshotWire["models"][number]["unavailableReason"]>,
): string {
  switch (code) {
    case "removed-from-catalog":
      return "The selected model is no longer in the current catalog.";
  }
}

function diagnosticMessage(
  code: NonNullable<DesignJob["diagnostic"]>["code"],
): string {
  switch (code) {
    case "credential-changed":
      return "This generation belongs to an earlier credential and cannot be refreshed.";
    case "submit-unknown":
      return "The generation outcome is unknown.";
    case "generation-failed":
      return "The generation was not completed.";
    case "result-unavailable":
      return "The generation completed without a usable output resource.";
    case "credential-rejected":
      return "The Modellix credential was rejected while refreshing this task.";
    case "task-inaccessible":
      return "This generation task is no longer accessible.";
    case "rate-limited":
      return "Task refresh is rate limited and will resume later.";
    case "response-invalid":
      return "The task response could not be understood.";
    case "poll-unavailable":
      return "Task refresh is temporarily unavailable and will resume later.";
  }
}

function formatGeneration(value: ModellixMediaGenerateResult): string {
  const resources = value.resources.map((resource) => `- ${resource.kind}: ${resource.url}`).join("\n");
  const diagnostic = value.diagnostic === undefined ? "" : `\n${value.diagnostic.message}`;
  if (value.status === "running") {
    return `Modellix media submission accepted${value.jobId === undefined ? "" : ` (${value.jobId})`}.${diagnostic}\nThe result card and Modellix Design now own the current status. Do not inspect it repeatedly or start a replacement in this turn. In ordinary assistant text, say only that submission was accepted and point to those live surfaces; do not use queued, running, generating, processing, pending, or equivalent current-state wording.`;
  }
  return `Modellix media status: ${value.status}${value.jobId === undefined ? "" : ` (${value.jobId})`}.${diagnostic}${resources === "" ? "" : `\n${resources}`}\nDo not automatically repeat this submission.`;
}

function formatTask(value: ModellixMediaGetResultResult): string {
  if (!value.found || value.job === undefined) return "No persisted Modellix media task matched that identifier.";
  const resources = value.job.resources.map((resource) => `- ${resource.kind}: ${resource.url}`).join("\n");
  if (value.job.status === "running") {
    return `Modellix media submission ${value.job.jobId} remains assigned to the live result card and Modellix Design. Do not inspect it again or start a replacement in this turn. In ordinary assistant text, say only that submission was accepted and point to those live surfaces; do not use queued, running, generating, processing, pending, or equivalent current-state wording.`;
  }
  return `Modellix media task ${value.job.jobId}: ${value.job.status}.${resources === "" ? "" : `\n${resources}`}`;
}

function disposeAll(disposers: readonly (() => unknown)[]): void {
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose();
    } catch {
      // Disposal is best effort; every registration has an independent owner.
    }
  }
}
