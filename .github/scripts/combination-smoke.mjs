import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const state = process.env.COMBINATION_STATE;
assert.ok(state);
const put = (name, value) => writeFileSync(join(state, name), `${JSON.stringify(value, null, 2)}\n`);
const bank = "release-smoke";
const routerUrl = "https://localhost:9443";

if (process.argv[2] === "prepare") {
  const principals = {};
  const credentials = {};
  for (const id of ["openclaw", "codex"]) {
    const secret = randomBytes(32).toString("hex");
    const token = `mr_${id}_${secret}`;
    credentials[id] = token;
    principals[id] = {
      keys: [{ id, sha256: createHash("sha256").update(secret).digest("hex"), created_at: new Date().toISOString() }],
      grants: [{ bank, scopes: ["bank.list", "memory.retain", "memory.recall", "memory.reflect"] }],
    };
  }
  put("credentials.json", credentials);
  put("principals.json", { principals });
  put("override.json", {
    services: {
      hindsight: { image: process.env.HINDSIGHT_TEST_IMAGE },
      "memory-router": {
        environment: {
          MEMORY_ROUTER_PRINCIPALS: "/app/release-principals.json",
          MEMORY_ROUTER_TOKEN: "",
          MEMORY_ROUTER_REGISTRY: "",
        },
        volumes: [`${state}/principals.json:/app/release-principals.json:ro`],
      },
    },
  });
} else {
  const credentials = JSON.parse(readFileSync(join(state, "credentials.json"), "utf8"));
  const traces = [];
  const server = createServer(
    { key: readFileSync(join(state, "key.pem")), cert: readFileSync(join(state, "cert.pem")) },
    (incoming, outgoing) => {
      const upstream = request(
        { hostname: "127.0.0.1", port: 8890, path: incoming.url, method: incoming.method, headers: incoming.headers },
        (response) => {
          traces.push({ method: incoming.method, path: incoming.url, status: response.statusCode });
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => {
        outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(9443, "localhost", resolve);
  });
  try {
    const live = await (await fetch(`${routerUrl}/health/live`)).json();
    if (process.env.ROUTER_TEST_VERSION) assert.equal(live.version, process.env.ROUTER_TEST_VERSION);
    const { AuthenticatedClientFactory } = await import(
      pathToFileURL(join(state, "openclaw/package/dist/shared/authenticated-client-factory.js"))
    );
    const factory = new AuthenticatedClientFactory({ routerUrl, userAgent: "release-smoke" });
    const client = factory.forAgent({
      principalId: "openclaw",
      token: credentials.openclaw,
      access: { writeBank: bank, additionalReadBanks: [] },
    });
    const retained = await client.retain(bank, "The release test project uses Python and TypeScript.", { async: true });
    assert.equal(retained.queued, undefined, "Benign memory must reach Hindsight rather than quarantine");
    const recalled = await client.recall(bank, "What languages does the project use?");
    assert.ok(Array.isArray(recalled.results));
    await assert.rejects(client.recall("unassigned", "private memory"));

    put("managed.json", {
      routerUrl,
      principals: {
        codex: {
          writeBank: bank,
          additionalReadBanks: [],
          tokenEnv: "COMBINATION_CODEX_TOKEN",
          mapPathToBank: { [state]: bank },
        },
      },
    });
    put("normal.json", { autoSeed: false, codebaseSurvey: false, autoReflect: true, pageRefreshEveryTurns: 1 });
    const child = spawn(process.execPath, [join(state, "coding/package/dist/codex-hook.js")], {
      env: {
        ...process.env,
        HINDSIGHT_ROUTER_CONFIG: join(state, "managed.json"),
        HINDSIGHT_CONFIG: join(state, "normal.json"),
        HINDSIGHT_DIAG_FILE: join(state, "diag.jsonl"),
        COMBINATION_CODEX_TOKEN: credentials.codex,
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 90_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(
      JSON.stringify({
        prompt: "What languages does this project use?",
        session_id: "release-smoke",
        cwd: state,
        harness: "opencode",
        bankId: "unassigned",
      }),
    );
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(status, 0, stderr);
    assert.ok(
      traces.some(
        (item) => item.method === "POST" && item.path === `/v1/default/banks/${bank}/reflect` && item.status === 200,
      ),
      "Packaged Codex hook must reflect through the real router",
    );
    assert.ok(
      !traces.some((item) => item.path.includes("unassigned")),
      "Untrusted bank input must not reach the router",
    );
    assert.ok(!traces.some((item) => item.status >= 400 && item.status !== 404), JSON.stringify(traces));
    assert.equal(typeof JSON.parse(stdout).hookSpecificOutput.additionalContext, "string");
    console.log("Packaged OpenClaw retain/recall and Codex reflect passed against the pinned router and Hindsight.");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
