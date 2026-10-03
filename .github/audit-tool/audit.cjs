const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { Allowlist } = require("audit-ci");

const advisory = "GHSA-vfj7-8cjw-p6xm";
const allowedPath = `${advisory}|aislop>micromatch>braces`;
const severities = ["info", "low", "moderate", "high", "critical"];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

function evaluate(result, config, lock) {
  if (result.error || result.signal || ![0, 1].includes(result.status))
    throw new Error("npm audit did not complete normally");
  const report = JSON.parse(result.stdout);
  if (
    !record(report) ||
    report.error ||
    report.message ||
    report.auditReportVersion !== 2 ||
    !record(report.vulnerabilities) ||
    !record(report.metadata?.vulnerabilities)
  ) {
    throw new Error("Invalid npm audit v2 report");
  }
  const entries = Object.entries(report.vulnerabilities);
  const counts = Object.fromEntries(severities.map((level) => [level, 0]));
  for (const [name, value] of entries) {
    if (
      !record(value) ||
      value.name !== name ||
      !severities.includes(value.severity) ||
      typeof value.isDirect !== "boolean" ||
      !Array.isArray(value.via) ||
      !value.via.length ||
      !Array.isArray(value.nodes) ||
      !value.nodes.length ||
      !value.nodes.every((node) => typeof node === "string") ||
      !Array.isArray(value.effects) ||
      !value.effects.every((effect) => typeof effect === "string")
    ) {
      throw new Error(`Invalid audit vulnerability: ${name}`);
    }
    for (const via of value.via) {
      if (typeof via === "string") {
        if (!Object.hasOwn(report.vulnerabilities, via)) throw new Error("Unresolved audit dependency");
        if (severities.indexOf(report.vulnerabilities[via].severity) > severities.indexOf(value.severity))
          throw new Error("Inconsistent dependency severity");
      } else if (
        !record(via) ||
        typeof via.source !== "number" ||
        typeof via.name !== "string" ||
        !severities.includes(via.severity) ||
        typeof via.url !== "string"
      ) {
        throw new Error("Invalid audit advisory");
      } else if (severities.indexOf(via.severity) > severities.indexOf(value.severity)) {
        throw new Error("Inconsistent advisory severity");
      }
    }
    if (value.effects.some((effect) => !Object.hasOwn(report.vulnerabilities, effect)))
      throw new Error("Unresolved audit effect");
    counts[value.severity]++;
  }
  for (const level of severities) {
    if (report.metadata.vulnerabilities[level] !== counts[level]) throw new Error("Inconsistent audit severity counts");
  }
  if (
    report.metadata.vulnerabilities.total !== entries.length ||
    result.status !== (entries.some(([, value]) => value.severity !== "info") ? 1 : 0)
  )
    throw new Error("Inconsistent npm audit exit status or total");
  const blocking = entries.filter(([, value]) => ["moderate", "high", "critical"].includes(value.severity));
  if (!blocking.length) return report;
  for (const [name, version] of Object.entries({ aislop: "0.16.1", micromatch: "4.0.8", braces: "3.0.3" })) {
    if (!record(lock?.packages) || lock.packages[`node_modules/${name}`]?.version !== version) {
      throw new Error("Approved exception dependency version changed");
    }
  }
  const active = new Allowlist(config.allowlist);
  const vulnerabilities = report.vulnerabilities;
  const expected = {
    aislop: { via: ["micromatch"], effects: [], direct: true },
    micromatch: { via: ["braces"], effects: ["aislop"], direct: false },
    braces: { effects: ["micromatch"], direct: false },
  };
  if (
    !active.paths.includes(allowedPath) ||
    blocking.length !== 3 ||
    !blocking.every(([name]) => Object.hasOwn(expected, name))
  )
    throw new Error("Unapproved npm vulnerability");
  for (const [name, shape] of Object.entries(expected)) {
    const value = vulnerabilities[name];
    if (
      value.severity !== "high" ||
      value.isDirect !== shape.direct ||
      !same(value.nodes, [`node_modules/${name}`]) ||
      !same(value.effects, shape.effects) ||
      (shape.via && !same(value.via, shape.via))
    )
      throw new Error("Approved advisory dependency path changed");
  }
  const via = vulnerabilities.braces.via;
  if (
    via.length !== 1 ||
    !record(via[0]) ||
    via[0].name !== "braces" ||
    via[0].severity !== "high" ||
    via[0].url !== `https://github.com/advisories/${advisory}`
  ) {
    throw new Error("Unapproved braces advisory");
  }
  return report;
}

function main(directory) {
  if (!directory) throw new Error("Audit target directory is required");
  const config = JSON.parse(readFileSync(join(__dirname, "audit-ci.json"), "utf8"));
  const result = spawnSync("npm", ["audit", "--json", "--audit-level=low", "--include=dev"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(directory, "npm-shrinkwrap.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    lock = JSON.parse(readFileSync(join(directory, "package-lock.json"), "utf8"));
  }
  evaluate(result, config, lock);
  console.log("Audit passed; any temporary exception is limited to the configured advisory path and expiry.");
}

if (require.main === module) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { evaluate };
