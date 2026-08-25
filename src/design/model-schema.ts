import { DesignError } from "./errors.js";
import type { FetchPort } from "./ports.js";
import { readBoundedResponseJson } from "../core/http.js";

const PUBLIC_ORIGIN = "https://www.modellix.ai";
const PREDICTION_ORIGIN = "https://api.modellix.ai";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SCHEMA_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface ModelSchemaDocument {
  readonly provider: string;
  readonly modelId: string;
  readonly source: "public-api-schema" | "portal-detail";
  readonly document: Readonly<Record<string, unknown>>;
  /** Null for portal metadata because it is not authoritative for submission. */
  readonly submitUrl: string | null;
}

export interface ModelSchemaClientOptions {
  readonly fetch: FetchPort;
  readonly allowPortalDetailFallback?: boolean;
}

export class ModelSchemaClient {
  readonly #fetch: FetchPort;
  readonly #allowPortalDetailFallback: boolean;

  constructor(options: ModelSchemaClientOptions) {
    this.#fetch = options.fetch;
    this.#allowPortalDetailFallback =
      options.allowPortalDetailFallback === true;
  }

  async load(
    provider: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<ModelSchemaDocument> {
    assertIdentifier(provider, "provider");
    assertIdentifier(modelId, "modelId");
    let result: ModelSchemaDocument;
    try {
      result = await this.#loadPublicSchema(provider, modelId, signal);
    } catch (caught) {
      if (!this.#allowPortalDetailFallback) {
        throw caught;
      }
      result = await this.#loadPortalDetail(provider, modelId, signal);
    }

    return result;
  }

  async #loadPublicSchema(
    provider: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<ModelSchemaDocument> {
    const url = new URL(
      `/models/${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}/api_schema`,
      PUBLIC_ORIGIN,
    );
    const document = await requestNoAuthorization(this.#fetch, url, signal);
    const submitUrl = extractAllowedSubmitUrl(document, provider, modelId);
    return {
      provider,
      modelId,
      source: "public-api-schema",
      document,
      submitUrl,
    };
  }

  async #loadPortalDetail(
    provider: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<ModelSchemaDocument> {
    const url = new URL(
      `/portal/v1/models/${encodeURIComponent(modelId)}`,
      PUBLIC_ORIGIN,
    );
    url.searchParams.set("provider", provider);
    const payload = await requestNoAuthorization(this.#fetch, url, signal);
    const data = asRecord(payload.data) ?? payload;
    const schemaData = parseSchemaData(data.schema_data ?? data.schemaData);
    return {
      provider,
      modelId,
      source: "portal-detail",
      document: schemaData,
      submitUrl: null,
    };
  }
}

/**
 * Submission is allowed only for the exact endpoint published by api_schema.
 * The path is independently bound to the requested provider/model and aliases
 * such as `/async`, query strings, fragments, userinfo, and redirects fail shut.
 */
export function extractAllowedSubmitUrl(
  document: Readonly<Record<string, unknown>>,
  provider: string,
  modelId: string,
): string {
  assertIdentifier(provider, "provider");
  assertIdentifier(modelId, "modelId");
  const servers = document.servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new DesignError(
      "SCHEMA_INVALID",
      "The public model schema does not publish a submission server",
    );
  }
  const server = asRecord(servers[0]);
  if (typeof server?.url !== "string") {
    throw new DesignError(
      "SCHEMA_INVALID",
      "The public model schema server URL is missing",
    );
  }

  let url: URL;
  try {
    url = new URL(server.url);
  } catch (cause) {
    throw new DesignError("ENDPOINT_NOT_ALLOWED", "The model endpoint is invalid", {
      cause,
    });
  }
  const expectedPath = `/api/v1/${provider}/${modelId}`;
  if (
    url.origin !== PREDICTION_ORIGIN ||
    url.pathname !== expectedPath ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new DesignError(
      "ENDPOINT_NOT_ALLOWED",
      "The model endpoint does not match the fixed Modellix prediction allowlist",
    );
  }
  return url.href;
}

function parseSchemaData(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === "string") {
    if (value.length > 2 * 1024 * 1024) {
      throw new DesignError("SCHEMA_INVALID", "schema_data exceeds the size limit");
    }
    try {
      const parsed: unknown = JSON.parse(value);
      const object = asRecord(parsed);
      if (object !== null) {
        return object;
      }
    } catch (cause) {
      throw new DesignError("SCHEMA_INVALID", "schema_data is not valid JSON", {
        cause,
      });
    }
  }
  const object = asRecord(value);
  if (object === null) {
    throw new DesignError(
      "SCHEMA_INVALID",
      "The portal model detail does not contain schema_data",
    );
  }
  return object;
}

async function requestNoAuthorization(
  fetchPort: FetchPort,
  url: URL,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  let response: Response;
  try {
    response = await fetchPort(url, {
      method: "GET",
      headers: new Headers({ accept: "application/json" }),
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    throw new DesignError("SCHEMA_UNAVAILABLE", "The model schema request failed", {
      cause,
    });
  }
  if (!response.ok) {
    throw new DesignError(
      "SCHEMA_UNAVAILABLE",
      `The model schema returned HTTP ${response.status}`,
      { status: response.status },
    );
  }
  let parsed: unknown;
  try {
    parsed = await readBoundedResponseJson(response, MAX_SCHEMA_RESPONSE_BYTES, signal);
  } catch (cause) {
    throw new DesignError("SCHEMA_INVALID", "The model schema is not valid JSON", {
      cause,
    });
  }
  const document = asRecord(parsed);
  if (document === null) {
    throw new DesignError("SCHEMA_INVALID", "The model schema must be an object");
  }
  return document;
}

function assertIdentifier(value: string, field: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new DesignError(
      "INVALID_ARGUMENT",
      `${field} must be a Modellix provider/model identifier`,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
