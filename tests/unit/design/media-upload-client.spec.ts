import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Agent } from "@deepseek-ai/dsh-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MediaUploadClient,
  prepareMediaUploadFromPath,
  prepareMediaUploadFromSession,
} from "../../../src/design/media-upload-client.js";

const temporaryDirectories: string[] = [];
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Modellix media upload", () => {
  it("submits one bounded multipart upload and returns credential-free metadata", async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-credential");
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({
        data: {
          file_id: "file_test_1",
          type: "image",
          url: "https://cdn.example.test/uploads/input.png",
          filename: "input.png",
          size: PNG_SIGNATURE.byteLength,
          created_at: "2026-08-31T01:02:03.000Z",
        },
      }), { headers: { "content-type": "application/json" } });
    });
    const client = new MediaUploadClient({ fetch: request as typeof fetch });

    const uploaded = await client.upload({
      apiKey: "test-credential",
      bytes: PNG_SIGNATURE,
      filename: "input.png",
      mimeType: "image/png",
    });

    expect(request).toHaveBeenCalledOnce();
    expect(uploaded).toEqual({
      fileId: "file_test_1",
      type: "image",
      url: "https://cdn.example.test/uploads/input.png",
      filename: "input.png",
      size: PNG_SIGNATURE.byteLength,
      createdAt: "2026-08-31T01:02:03.000Z",
    });
    expect(JSON.stringify(uploaded)).not.toContain("test-credential");
  });

  it("never replays an upload whose transport outcome is unknown", async () => {
    const request = vi.fn(async () => {
      throw new Error("connection ended after dispatch");
    });
    const client = new MediaUploadClient({ fetch: request as typeof fetch });

    await expect(client.upload({
      apiKey: "test-credential",
      bytes: PNG_SIGNATURE,
      filename: "input.png",
      mimeType: "image/png",
    })).rejects.toMatchObject({ code: "SUBMIT_UNKNOWN" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("reads only supported image files inside the session workspace", async () => {
    const workspace = await createTemporaryDirectory();
    const input = join(workspace, "input.png");
    const gif = join(workspace, "input.gif");
    const outside = await createTemporaryDirectory();
    await writeFile(input, PNG_SIGNATURE);
    await writeFile(gif, new TextEncoder().encode("GIF89a"));
    await writeFile(join(outside, "outside.png"), PNG_SIGNATURE);

    await expect(prepareMediaUploadFromPath(workspace, "input.png")).resolves.toMatchObject({
      filename: "input.png",
      mimeType: "image/png",
    });
    await expect(prepareMediaUploadFromPath(workspace, gif)).rejects.toThrow(
      "Unsupported media type; use PNG, JPEG, or WebP",
    );
    await expect(prepareMediaUploadFromPath(workspace, join(outside, "outside.png"))).rejects.toThrow(
      "Media path must stay inside the session workspace",
    );
  });

  it("resolves an image by attachment id from the current conversation", async () => {
    const attachment = {
      attachmentId: "attachment-1",
      mediaType: "image/png",
      name: "reference.png",
    } as const;
    const readImage = vi.fn(async () => ({ data: PNG_SIGNATURE }));
    const agent = {
      session: {
        deriveMessages: () => [{ content: [{ type: "image", attachment }] }],
      },
      ctx: { attachments: { readImage } },
    } as unknown as Agent;

    await expect(prepareMediaUploadFromSession(agent, "attachment-1")).resolves.toMatchObject({
      filename: "reference.png",
      mimeType: "image/png",
    });
    expect(readImage).toHaveBeenCalledOnce();
    await expect(prepareMediaUploadFromSession(agent, "missing")).rejects.toThrow(
      "The attachment is not present in this conversation",
    );
  });

  it("sanitizes path separators and control characters in attachment filenames", async () => {
    const attachment = {
      attachmentId: "attachment-unsafe-name",
      mediaType: "image/png",
      name: "nested/\u0000bad\"name.png",
    } as const;
    const agent = {
      session: {
        deriveMessages: () => [{ content: [{ type: "image", attachment }] }],
      },
      ctx: { attachments: { readImage: async () => ({ data: PNG_SIGNATURE }) } },
    } as unknown as Agent;

    await expect(prepareMediaUploadFromSession(agent, attachment.attachmentId))
      .resolves.toMatchObject({ filename: "nested__bad_name.png" });
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-modellix-media-"));
  temporaryDirectories.push(directory);
  return directory;
}
