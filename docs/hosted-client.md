# Hosted application client

Hosted applications that own their process can import the shared HTTP client:

```ts
import { HostedRouterClient } from "@mickey-kras/hindsight-memory-router-openclaw/hosted";

const memory = new HostedRouterClient({
  routerUrl: "https://router.example",
  principalId: "app",
  token: principalToken,
  writeBank: "app-memory", // optional for read-only applications
  additionalReadBanks: ["reference-memory"],
});

await memory.retain("app-memory", { items: [{ content: "A project fact" }] });
const recalled = await memory.recall("reference-memory", { query: "Project facts", max_tokens: 1024 });
const reflection = await memory.reflect("reference-memory", { query: "What should we do next?", budget: "low" });
```

Supply explicit bank access and a principal credential issued by the router operator. Every operation takes an explicit bank. The write bank is also readable. Local access checks constrain the caller; router per-bank scope grants remain authoritative and may reject any request. There is no bank provisioning, upstream Hindsight URL/client, credential lookup/fallback, automatic deployment fallback, queue or data synchronization. Each instance owns its authenticated factory and transport; deployments share no credentials or denial state. Keep coding-agents for the local harness integration.

All paths below are relative to `/v1/default/banks/{bank}`. Request fields use the router's snake_case wire names. Documents and knowledge-base requests/responses with open schemas use `FacadeObject` (`Record<string, unknown>`), so the client does not promise undocumented fields.

| Methods | Supported facade routes |
| --- | --- |
| `retain`, `ingestDocument` | POST `/memories` (ingest sends one item with caller-provided `document_id`, asynchronously) |
| `recall`, `reflect` | POST `/memories/recall`, POST `/reflect` (read operations) |
| `listDocuments`, `getDocument` | GET `/documents`, GET `/documents/{document_id}` |
| `updateDocument`, `deleteDocument` | PATCH and DELETE `/documents/{document_id}` |
| `listDocumentChunks`, `reprocessDocument` | GET `/documents/{document_id}/chunks`, POST `/documents/{document_id}/reprocess` |
| `listKnowledgePages`, `searchKnowledgePages` | GET `/knowledge-base/tree`, GET `/knowledge-base/search` |
| `createKnowledgePage`, `getKnowledgePage` | POST `/knowledge-base/pages`, GET `/knowledge-base/pages/{page_id}` |
| `updateKnowledgePage`, `deleteKnowledgePage` | PATCH and DELETE `/knowledge-base/nodes/{node_id}` |

Knowledge pages here mean knowledge-base pages. Listing returns the router's tree shape; updates and deletes require the node ID returned by the router, which is distinct from a page ID. The existing OpenClaw SDK knowledge tools use mental models and remain a separate surface.

The client reuses `AuthenticatedClientFactory` and `RouterTransport`: HTTPS validation, redirect rejection, bank checks, principal headers and sanitized errors are preserved. Requests have a 15-second deadline even with a caller cancellation signal, a 1 MiB serialized body cap and a 4 MiB response cap. Router quotas, scanning and quarantine still apply. A router 401/403 produces `AccessDeniedError` and disables that instance's credential; construct a new instance with a newly issued credential after resolving access. Other failures produce `RouterRequestError` with status and bounded retry delay; GET 404 becomes a sanitized 404 error. No retries are automatic.

Routes were checked against `memory_router/request_dispatch.py`, `memory_router/facade_routes.py` and `openapi/openclaw.json` in `mickey-kras/hindsight-memory-router` at commit `e17a881184c89a4ed0030921ba5650d88fcd10a3`. Contract tests use synthetic fetch responses and independent synthetic deployments; they do not claim live router or upstream integration coverage.
