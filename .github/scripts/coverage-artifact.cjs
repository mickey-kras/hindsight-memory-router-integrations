const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");

function coverageIdentity(env) {
  assert.match(env.COVERAGE_SHA || "", /^[a-f0-9]{40}$/, "Coverage requires an exact source SHA");
  assert.match(env.GITHUB_RUN_ID || "", /^[1-9][0-9]*$/, "Coverage requires its workflow run");
  return { sha: env.COVERAGE_SHA, run: env.GITHUB_RUN_ID };
}

function coverageDigest(report) {
  assert.ok(report.includes("SF:") && report.includes("end_of_record"), "Coverage report is missing or empty");
  return createHash("sha256").update(report).digest("hex");
}

function verifyCoverage(manifest, report, env) {
  assert.deepEqual(
    manifest,
    { ...coverageIdentity(env), sha256: coverageDigest(report) },
    "Coverage provenance mismatch",
  );
}

if (require.main === module) {
  const identity = coverageIdentity(process.env);
  const report = readFileSync("coverage/lcov.info", "utf8");
  const path = "coverage/provenance.json";
  if (process.argv[2] === "record") {
    writeFileSync(path, `${JSON.stringify({ ...identity, sha256: coverageDigest(report) })}\n`);
  } else {
    assert.equal(process.argv[2], "verify", "Expected record or verify");
    verifyCoverage(JSON.parse(readFileSync(path, "utf8")), report, process.env);
  }
}

module.exports = { coverageIdentity, coverageDigest, verifyCoverage };
