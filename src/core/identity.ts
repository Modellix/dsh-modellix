import { createHash } from "node:crypto";

const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_SOURCE_ID_LENGTH = 4_096;

export function deriveModellixUserId(harnessAnonymousId: string): string {
  return deriveIdentity("mdlx_u_", "dsh-modellix:user:v1", harnessAnonymousId);
}

export function deriveModellixSessionId(harnessSessionId: string): string {
  return deriveIdentity(
    "mdlx_s_",
    "dsh-modellix:session:v1",
    harnessSessionId,
  );
}

export function isValidModellixIdentity(value: string): boolean {
  return ID_PATTERN.test(value);
}

function deriveIdentity(
  prefix: "mdlx_u_" | "mdlx_s_",
  domain: string,
  sourceId: string,
): string {
  assertSourceId(sourceId);
  const digest = createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(sourceId, "utf8")
    .digest("base64url");
  const result = `${prefix}${digest}`;
  if (!isValidModellixIdentity(result)) {
    throw new Error("Derived Modellix identity violates the public contract");
  }
  return result;
}

function assertSourceId(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SOURCE_ID_LENGTH ||
    value.trim().length === 0
  ) {
    throw new TypeError(
      "Harness identity must be a non-empty string no longer than 4096 characters",
    );
  }
}
