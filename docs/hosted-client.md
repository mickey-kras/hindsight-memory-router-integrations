# Hosted application client

Download the OpenClaw `.tgz` from the [selected GitHub release](https://github.com/mickey-kras/hindsight-memory-router-integrations/releases).
Check it against that release's `PACKAGE_SHA256`.
Install the verified archive:

```sh
npm install --save-exact /absolute/path/verified-openclaw.tgz
```

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

Supply explicit bank access and a principal credential issued by the router operator. Every operation takes an explicit bank. The write bank is also readable. Local access checks constrain the caller.

Router scope grants for each bank control access and can reject any request. There is no bank provisioning, upstream Hindsight URL or client, credential lookup or fallback, automatic deployment fallback, queue or data synchronization. Each instance owns its authenticated factory and transport. Deployments share no credentials or denial state.

Keep coding-agents for the local harness integration.

All paths below are relative to `/v1/default/banks/{bank}`. Request fields use the router's snake_case wire names. Document and knowledge-base requests and responses with open schemas use `FacadeObject` (`Record<string, unknown>`). The client does not promise undocumented fields.

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

Knowledge pages here mean knowledge-base pages. Listing returns the router's tree shape. Updates and deletes need the router's node ID. This differs from a page ID.

The existing knowledge tools in the OpenClaw SDK use mental models. They remain a separate surface.

The client reuses `AuthenticatedClientFactory` and `RouterTransport`. These keep HTTPS validation, redirect rejection, bank checks, principal headers and sanitized errors. Requests have a 15-second deadline, including requests with a caller cancellation signal. They have a 1 MiB serialized body limit and a 4 MiB response limit.

Caller cancellation preserves the signal's reason before headers and during body reads. The deadline produces `TimeoutError`. Router quotas, scanning and quarantine still apply. A router 401/403 produces `AccessDeniedError` and disables that instance's credential.

After you resolve access, construct a new instance with a newly issued credential. Other failures produce `RouterRequestError` with status and a bounded retry delay. GET 404 becomes a sanitized 404 error. The transport tries to cancel discarded response bodies without replacing the original failure.

No retries are automatic.

The route review used `memory_router/request_dispatch.py`, `memory_router/facade_routes.py` and `openapi/openclaw.json` in `mickey-kras/hindsight-memory-router` at commit `e17a881184c89a4ed0030921ba5650d88fcd10a3`. Contract tests use synthetic fetch responses and independent synthetic deployments. They do not prove live router or upstream integration coverage.


