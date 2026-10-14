import { AuthenticatedClientFactory } from "./authenticated-client-factory.js";
import { AccessDeniedError, type BankAccess } from "./bank-access.js";
import { PrincipalCredentialResolver } from "./principal-credential-resolver.js";
import { RouterRequestError, type RouterTransport } from "./router-transport.js";

export { RouterUrlError } from "./router-url.js";
export type { BankAccess } from "./bank-access.js";
export { AccessDeniedError } from "./bank-access.js";
export { RouterRequestError } from "./router-transport.js";

export type FacadeObject = Record<string, unknown>;
export interface HostedRouterOptions extends BankAccess {
  routerUrl: string;
  principalId: string;
  token: string;
}
export interface RequestOptions {
  signal?: AbortSignal;
}
export interface RetainItem {
  content: string;
  document_id?: string;
  context?: string;
  timestamp?: string;
  metadata?: Record<string, string>;
  tags?: string[];
  update_mode?: "replace" | "append";
}
export interface RetainRequest {
  items: RetainItem[];
  async?: boolean;
  operation_id?: string;
  document_tags?: string[];
}
export interface RecallRequest {
  query: string;
  max_tokens?: number;
  budget?: "low" | "mid" | "high";
  types?: string[];
  tags?: string[];
  tags_match?: string;
  trace?: boolean;
}
export interface RecallResult extends FacadeObject {
  id: string;
  text: string;
}
export interface RecallResponse extends FacadeObject {
  results: RecallResult[];
}
// The router validates reflect with RecallBody; extension fields remain open.
export type ReflectRequest = RecallRequest & FacadeObject;
export interface ReflectResponse extends FacadeObject {
  text: string;
}
export interface Pagination {
  limit?: number;
  offset?: number;
}
export interface DocumentQuery extends Pagination {
  q?: string;
  tags?: string[];
  tags_match?: string;
  time_field?: string;
  start_date?: string;
  end_date?: string;
}
export interface KnowledgeQuery {
  tags?: string[];
  tags_match?: "any" | "all" | "any_strict" | "all_strict" | "exact";
  tag_groups?: string;
}
export interface KnowledgeSearchQuery extends KnowledgeQuery {
  q: string;
  limit?: number;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function segment(id: string): string {
  if (!id || id === "." || id === ".." || /[\\/%?#]/.test(id)) throw new AccessDeniedError();
  return encodeURIComponent(id);
}

function queryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

async function objectResponse(response: Response): Promise<FacadeObject> {
  if (response.status === 404) throw new RouterRequestError(404);
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new RouterRequestError(502);
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    if (!text.trim()) return {};
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new RouterRequestError(502);
    return data as FacadeObject;
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new RouterRequestError(502);
  } finally {
    reader.releaseLock();
  }
}

export class HostedRouterClient {
  readonly #transport: RouterTransport;

  constructor(options: HostedRouterOptions) {
    if (!Array.isArray(options.additionalReadBanks)) throw new AccessDeniedError();
    const resolver = new PrincipalCredentialResolver({
      principals: {
        [options.principalId]: {
          token: options.token,
          writeBank: options.writeBank,
          additionalReadBanks: options.additionalReadBanks,
        },
      },
    });
    const credentials = resolver.resolve(options.principalId);
    this.#transport = new AuthenticatedClientFactory({
      routerUrl: options.routerUrl,
      userAgent: "memory-router-hosted",
    }).transportFor(credentials);
  }

  private async request(
    bank: string,
    suffix: string,
    method: string,
    body?: object,
    options?: RequestOptions,
  ): Promise<FacadeObject> {
    let serialized: string | undefined;
    try {
      serialized = body === undefined ? undefined : JSON.stringify(body);
    } catch {
      throw new RouterRequestError(400);
    }
    if (serialized !== undefined && Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw new RouterRequestError(413);
    const deadline = AbortSignal.timeout(15_000);
    const response = await this.#transport.request(this.#transport.bankUrl(bank, suffix), {
      method,
      body: serialized,
      signal: options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
    });
    return objectResponse(response);
  }

  retain(bank: string, body: RetainRequest, options?: RequestOptions): Promise<FacadeObject> {
    return this.request(bank, "/memories", "POST", body, options);
  }
  async recall(bank: string, body: RecallRequest, options?: RequestOptions): Promise<RecallResponse> {
    const data = await this.request(bank, "/memories/recall", "POST", body, options);
    if (
      !Array.isArray(data.results) ||
      !data.results.every(
        (item: unknown) =>
          item !== null &&
          typeof item === "object" &&
          "id" in item &&
          typeof item.id === "string" &&
          "text" in item &&
          typeof item.text === "string",
      )
    )
      throw new RouterRequestError(502);
    return { ...data, results: data.results as RecallResult[] };
  }
  async reflect(bank: string, body: ReflectRequest, options?: RequestOptions): Promise<ReflectResponse> {
    const data = await this.request(bank, "/reflect", "POST", body, options);
    if (typeof data.text !== "string") throw new RouterRequestError(502);
    return { ...data, text: data.text };
  }
  ingestDocument(
    bank: string,
    item: RetainItem & { document_id: string },
    options?: RequestOptions,
  ): Promise<FacadeObject> {
    return this.retain(bank, { items: [item], async: true }, options);
  }
  listDocuments(bank: string, query: DocumentQuery = {}, options?: RequestOptions): Promise<FacadeObject> {
    return this.request(bank, `/documents${queryString(query)}`, "GET", undefined, options);
  }
  getDocument(bank: string, id: string, options?: RequestOptions): Promise<FacadeObject> {
    return this.request(bank, `/documents/${segment(id)}`, "GET", undefined, options);
  }
  updateDocument(bank: string, id: string, body: FacadeObject, options?: RequestOptions): Promise<FacadeObject> {
    return this.request(bank, `/documents/${segment(id)}`, "PATCH", body, options);
  }
  deleteDocument(bank: string, id: string, options?: RequestOptions): Promise<FacadeObject> {
    return this.request(bank, `/documents/${segment(id)}`, "DELETE", undefined, options);
  }
  listDocumentChunks(
    bank: string,
    id: string,
    query: Pagination = {},
    options?: RequestOptions,
  ): Promise<FacadeObject> {
    return this.request(bank, `/documents/${segment(id)}/chunks${queryString(query)}`, "GET", undefined, options);
  }
  reprocessDocument(bank: string, id: string, options?: RequestOptions): Promise<FacadeObject> {
    return this.request(bank, `/documents/${segment(id)}/reprocess`, "POST", undefined, options);
  }
  listKnowledgePages(bank: string, query: KnowledgeQuery = {}, options?: RequestOptions): Promise<FacadeObject> {
    return this.request(bank, `/knowledge-base/tree${queryString(query)}`, "GET", undefined, options);
  }
  searchKnowledgePages(bank: string, query: KnowledgeSearchQuery, options?: RequestOptions): Promise<FacadeObject> {
    return this.request(bank, `/knowledge-base/search${queryString(query)}`, "GET", undefined, options);
  }
  createKnowledgePage(bank: string, body: FacadeObject, options?: RequestOptions): Promise<FacadeObject> {
    return this.request(bank, "/knowledge-base/pages", "POST", body, options);
  }
  getKnowledgePage(bank: string, pageId: string, options?: RequestOptions): Promise<FacadeObject> {
    return this.request(bank, `/knowledge-base/pages/${segment(pageId)}`, "GET", undefined, options);
  }
  updateKnowledgePage(
    bank: string,
    nodeId: string,
    body: FacadeObject,
    options?: RequestOptions,
  ): Promise<FacadeObject> {
    return this.request(bank, `/knowledge-base/nodes/${segment(nodeId)}`, "PATCH", body, options);
  }
  deleteKnowledgePage(bank: string, nodeId: string, options?: RequestOptions): Promise<FacadeObject> {
    return this.request(bank, `/knowledge-base/nodes/${segment(nodeId)}`, "DELETE", undefined, options);
  }
}
