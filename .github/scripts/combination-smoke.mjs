import assert from "node:assert/strict";
import { constants, createDecipheriv, createHash, privateDecrypt, randomBytes } from "node:crypto";
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
  const ADMIN_READ_TOKEN = "test-admin-read-token-012345678901";
  const adminGet = (path) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: 8890,
          path,
          method: "GET",
          headers: { authorization: `Bearer ${ADMIN_READ_TOKEN}` },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  // RFC 8785 canonicalization for the flat string objects used as envelope AAD.
  const jcs = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`)
      .join(",")}}`;
  };
  // Quarantine envelopes are AES-256-GCM with an RSA-OAEP-SHA256 wrapped key;
  // CI generates the keypair per run, so the smoke can read back what the
  // router's response scanner convicted instead of guessing.
  const decryptEnvelope = (envelope) => {
    const enc = envelope.encryption;
    const key = privateDecrypt(
      {
        key: readFileSync(join(state, "key.pem")),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(enc.wrapped_key_b64, "base64"),
    );
    const aad = {
      version: envelope.version,
      quarantine_id: envelope.quarantine_id,
      created_at: envelope.created_at,
      reason: envelope.reason,
      ...(envelope.writer_id !== undefined ? { writer_id: envelope.writer_id } : {}),
      ...(envelope.source !== undefined ? { source: envelope.source } : {}),
      sha256: envelope.sha256,
      encryption: {
        algorithm: enc.algorithm,
        key_wrap: enc.key_wrap,
        aad: enc.aad,
        wrapped_key_b64: enc.wrapped_key_b64,
        iv_b64: enc.iv_b64,
      },
    };
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv_b64, "base64"));
    decipher.setAAD(Buffer.from(jcs(aad), "utf8"));
    decipher.setAuthTag(Buffer.from(enc.tag_b64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext_b64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  };
  const securityEventDump = async () => {
    try {
      const queue = await adminGet("/admin/quarantine/queue?limit=500");
      if (queue.status !== 200) return `queue=${queue.status}:${queue.body.slice(0, 300)}`;
      const parsed = JSON.parse(queue.body);
      const items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
      const events = items.filter((item) => item.kind === "security_event");
      if (events.length === 0) return "no security events";
      const dumps = [];
      for (const event of events.slice(-3)) {
        const detail = await adminGet(`/admin/quarantine/items/${encodeURIComponent(event.quarantine_id)}`);
        if (detail.status !== 200) {
          dumps.push(`item=${event.quarantine_id} status=${detail.status}`);
          continue;
        }
        dumps.push(decryptEnvelope(JSON.parse(detail.body).encrypted).slice(0, 4096));
      }
      return dumps.join("\n---\n");
    } catch (error) {
      return `security dump failed: ${error.message}`;
    }
  };
  const server = createServer(
    { key: readFileSync(join(state, "key.pem")), cert: readFileSync(join(state, "cert.pem")) },
    (incoming, outgoing) => {
      const upstream = request(
        { hostname: "127.0.0.1", port: 8890, path: incoming.url, method: incoming.method, headers: incoming.headers },
        (response) => {
          const trace = { method: incoming.method, path: incoming.url, status: response.statusCode };
          traces.push(trace);
          outgoing.writeHead(response.statusCode, response.headers);
          if (response.statusCode >= 400) {
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
              if (size < 4096) {
                chunks.push(chunk);
                size += chunk.length;
              }
              outgoing.write(chunk);
            });
            response.on("end", () => {
              trace.body = Buffer.concat(chunks).toString("utf8").slice(0, 4096);
              outgoing.end();
            });
            response.on("error", () => outgoing.end());
            return;
          }
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
    let diagTail = "";
    try {
      diagTail = readFileSync(join(state, "diag.jsonl"), "utf8").slice(-2000);
    } catch {
      // Diagnostics are best-effort; the assertions below carry the gate.
    }
    const reflectOk = traces.some(
      (item) => item.method === "POST" && item.path === `/v1/default/banks/${bank}/reflect` && item.status === 200,
    );
    const securityDump = reflectOk ? "" : await securityEventDump();
    assert.ok(
      reflectOk,
      `Packaged Codex hook must reflect through the real router; traces=${JSON.stringify(traces)} stderr=${stderr.slice(-2000)} diag=${diagTail} security=${securityDump}`,
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
