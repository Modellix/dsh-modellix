import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  DOCUMENTATION_WEBP_LIMITS,
  verifySafeDocumentationWebp,
} from "../../../scripts/webp-verifier.mjs";

async function screenshot(): Promise<Buffer> {
  return sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: 24, g: 80, b: 160 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="320" height="240"><text x="20" y="80" font-size="24" fill="white">Modellix safe screenshot verifier</text></svg>',
        ),
      },
    ])
    .webp({ quality: 90 })
    .toBuffer();
}

function appendChunk(input: Buffer, id: string, payload: Buffer): Buffer {
  const padding = payload.length & 1;
  const chunk = Buffer.alloc(8 + payload.length + padding);
  chunk.write(id, 0, 4, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  const output = Buffer.concat([input, chunk]);
  output.writeUInt32LE(output.length - 8, 4);
  return output;
}

describe("documentation WebP verifier", () => {
  it("decodes a bounded still WebP without metadata", async () => {
    const input = await screenshot();
    const result = await verifySafeDocumentationWebp(input);
    expect(result).toMatchObject({ width: 320, height: 240 });
    expect(result.bytes).toBeGreaterThanOrEqual(
      DOCUMENTATION_WEBP_LIMITS.minimumBytes,
    );
  });

  it("rejects metadata chunks and trailing bytes", async () => {
    const input = await screenshot();
    await expect(
      verifySafeDocumentationWebp(
        appendChunk(input, "EXIF", Buffer.from("synthetic metadata")),
      ),
    ).rejects.toThrow(/forbidden WebP chunk/u);
    await expect(
      verifySafeDocumentationWebp(Buffer.concat([input, Buffer.from("tail")])),
    ).rejects.toThrow(/trailing or truncated RIFF data/u);
  });

  it("rejects undersized dimensions and non-WebP data", async () => {
    const pixels = Buffer.alloc(319 * 240 * 3);
    let state = 0x12345678;
    for (let index = 0; index < pixels.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[index] = state & 0xff;
    }
    const small = await sharp(pixels, {
      raw: { width: 319, height: 240, channels: 3 },
    })
      .webp({ lossless: true })
      .toBuffer();
    expect(small.length).toBeGreaterThanOrEqual(
      DOCUMENTATION_WEBP_LIMITS.minimumBytes,
    );
    await expect(verifySafeDocumentationWebp(small)).rejects.toThrow(
      /dimensions 319x240/u,
    );
    await expect(
      verifySafeDocumentationWebp(Buffer.alloc(DOCUMENTATION_WEBP_LIMITS.minimumBytes)),
    ).rejects.toThrow(/not a WebP RIFF container/u);
  });
});
