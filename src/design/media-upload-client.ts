import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ImageAttachmentRef, ImageMediaType } from "@deepseek-ai/dsh-attachment";

import { readBoundedResponseJson, requestDeadline } from "../core/http.js";
import { DesignError } from "./errors.js";
import type { FetchPort } from "./ports.js";

const MEDIA_UPLOAD_URL = "https://api.modellix.ai/api/v1/media/files";
const MAX_MEDIA_FILE_BYTES = 16 * 1024 * 1024;
const MAX_UPLOAD_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;
const SAFE_FILE_ID = /^[A-Za-z0-9._~:+@=-]{1,512}$/u;

export interface PreparedMediaUpload {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: ImageMediaType;
}

export interface MediaUploadRecord {
  readonly fileId: string;
  readonly type: string;
  readonly url: string;
  readonly filename: string;
  readonly size: number;
  readonly createdAt: string | null;
}

export interface MediaUploadInput extends PreparedMediaUpload {
  readonly apiKey: string;
  readonly signal?: AbortSignal;
}

export class MediaUploadClient {
  readonly #fetch: FetchPort;
  readonly #timeoutMs: number;

  constructor(options: { readonly fetch?: FetchPort; readonly timeoutMs?: number } = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  async upload(input: MediaUploadInput): Promise<MediaUploadRecord> {
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_MEDIA_FILE_BYTES) {
      throw new DesignError("INVALID_ARGUMENT", "Media file size must be between 1 byte and 16 MiB");
    }
    if (input.apiKey.trim() === "" || /[\r\n]/u.test(input.apiKey)) {
      throw new DesignError("INVALID_ARGUMENT", "Modellix credential is missing or malformed");
    }
    input.signal?.throwIfAborted();
    const filename = safeFilename(input.filename, input.mimeType);
    const form = new FormData();
    form.append("file", new Blob([input.bytes], { type: input.mimeType }), filename);
    const deadline = requestDeadline(input.signal, this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(MEDIA_UPLOAD_URL, {
        method: "POST",
        headers: new Headers({
          accept: "application/json",
          authorization: `Bearer ${input.apiKey}`,
        }),
        body: form,
        redirect: "error",
        signal: deadline.signal,
      });
    } catch (cause) {
      throw new DesignError(
        "SUBMIT_UNKNOWN",
        "The media upload outcome is unknown; do not retry automatically",
        { cause },
      );
    }
    if (response.redirected) {
      void response.body?.cancel().catch(() => undefined);
      throw new DesignError(
        "SUBMIT_UNKNOWN",
        "The media upload outcome is unknown; do not retry automatically",
        { status: response.status },
      );
    }
    if (!response.ok) {
      const ambiguous = response.status === 408 || response.status === 409 ||
        response.status === 425 || response.status === 429 || response.status >= 500;
      void response.body?.cancel().catch(() => undefined);
      throw new DesignError(
        ambiguous ? "SUBMIT_UNKNOWN" : "SUBMIT_REJECTED",
        ambiguous
          ? "The media upload outcome is unknown; do not retry automatically"
          : `The media upload was rejected with HTTP ${String(response.status)}`,
        { status: response.status },
      );
    }
    let payload: unknown;
    try {
      payload = await readBoundedResponseJson(response, MAX_UPLOAD_RESPONSE_BYTES, deadline.signal);
      return parseMediaUploadRecord(payload);
    } catch (cause) {
      throw new DesignError(
        "SUBMIT_UNKNOWN",
        "The upload succeeded but its file metadata could not be read; do not retry automatically",
        { cause },
      );
    }
  }
}

export async function prepareMediaUploadFromSession(
  agent: Agent | undefined,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<PreparedMediaUpload> {
  if (agent === undefined) {
    throw new DesignError("INVALID_ARGUMENT", "Session attachments require an active Agent");
  }
  const ref = findSessionAttachment(agent, attachmentId);
  if (ref === null) {
    throw new DesignError("INVALID_ARGUMENT", "The attachment is not present in this conversation");
  }
  const stored = await agent.ctx.attachments.readImage(ref, signal);
  return {
    bytes: stored.data,
    filename: safeFilename(ref.name ?? `attachment-${String(ref.attachmentId)}`, ref.mediaType),
    mimeType: ref.mediaType,
  };
}

export async function prepareMediaUploadFromPath(
  cwd: string | undefined,
  inputPath: string,
): Promise<PreparedMediaUpload> {
  if (cwd === undefined || cwd.trim() === "") {
    throw new DesignError("INVALID_ARGUMENT", "A session workspace is required for path uploads");
  }
  if (inputPath.trim() === "" || inputPath.length > 32_767) {
    throw new DesignError("INVALID_ARGUMENT", "Media path is missing or too long");
  }
  const workspace = await realpath(cwd);
  const candidate = resolve(workspace, inputPath);
  const candidateStats = await lstat(candidate).catch((cause: unknown) => {
    throw new DesignError("INVALID_ARGUMENT", "The media file could not be inspected", { cause });
  });
  if (candidateStats.isSymbolicLink()) {
    throw new DesignError("INVALID_ARGUMENT", "Media upload input must not be a symbolic link");
  }
  const resolved = await realpath(candidate).catch((cause: unknown) => {
    throw new DesignError("INVALID_ARGUMENT", "The media file could not be resolved", { cause });
  });
  if (!within(workspace, resolved)) {
    throw new DesignError("INVALID_ARGUMENT", "Media path must stay inside the session workspace");
  }
  const before = candidateStats;
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new DesignError("INVALID_ARGUMENT", "Media upload input must be a regular file");
  }
  if (before.size < 1 || before.size > MAX_MEDIA_FILE_BYTES) {
    throw new DesignError("INVALID_ARGUMENT", "Media file size must be between 1 byte and 16 MiB");
  }
  const handle = await open(resolved, "r");
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new DesignError("INVALID_ARGUMENT", "Media file changed while it was being opened");
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.byteLength !== before.size) {
    throw new DesignError("INVALID_ARGUMENT", "Media file changed while it was being read");
  }
  const mimeType = detectImageMimeType(bytes);
  return { bytes, filename: safeFilename(basename(resolved), mimeType), mimeType };
}

function findSessionAttachment(agent: Agent, attachmentId: string): ImageAttachmentRef | null {
  for (const message of agent.session.deriveMessages().toReversed()) {
    for (const block of message.content.toReversed()) {
      if (block.type === "image" && String(block.attachment.attachmentId) === attachmentId) {
        return block.attachment;
      }
    }
  }
  return null;
}

function within(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

function detectImageMimeType(bytes: Uint8Array): ImageMediaType {
  if (bytes.length >= 8 && bytes.slice(0, 8).every((value, index) =>
    value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const ascii = (start: number, end: number): string =>
    new TextDecoder("ascii").decode(bytes.slice(start, end));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return "image/webp";
  }
  throw new DesignError("INVALID_ARGUMENT", "Unsupported media type; use PNG, JPEG, or WebP");
}

function safeFilename(value: string, mimeType: ImageMediaType): string {
  const extension = mimeType === "image/png" ? ".png" : mimeType === "image/webp"
    ? ".webp" : ".jpg";
  const headerSafe = value.normalize("NFC").replaceAll(/["\\/]/gu, "_");
  const cleaned = Array.from(headerSafe, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? "_" : character;
  }).join("").trim().slice(0, 180);
  return cleaned === "" ? `upload${extension}` : cleaned;
}

function parseMediaUploadRecord(payload: unknown): MediaUploadRecord {
  const root = record(payload);
  const data = record(root?.data) ?? root;
  if (data === null || typeof data.file_id !== "string" || !SAFE_FILE_ID.test(data.file_id) ||
    typeof data.type !== "string" || typeof data.filename !== "string" ||
    typeof data.size !== "number" || !Number.isSafeInteger(data.size) || data.size < 0 ||
    typeof data.url !== "string") {
    throw new TypeError("Media upload response is malformed");
  }
  const url = new URL(data.url);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TypeError("Media upload URL is unsafe");
  }
  const createdAt = typeof data.created_at === "string" && Number.isFinite(Date.parse(data.created_at))
    ? new Date(data.created_at).toISOString()
    : typeof data.created_at === "number" && Number.isFinite(data.created_at)
      ? new Date(data.created_at).toISOString()
      : null;
  return {
    fileId: data.file_id,
    type: data.type.slice(0, 128),
    url: url.href,
    filename: data.filename.slice(0, 512),
    size: data.size,
    createdAt,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
