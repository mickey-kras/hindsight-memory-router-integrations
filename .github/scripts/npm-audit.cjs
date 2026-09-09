const { spawnSync } = require("node:child_process");

const SEVERITY = { low: 1, moderate: 2, high: 3, critical: 4 };
const ADVISORY = "https://github.com/advisories/GHSA-vwc7-r8mq-g2x9";
const EXPIRES_AT = Date.parse("2026-10-09T00:00:00Z");

function waived(name, vulnerability, now = Date.now()) {
  if (now >= EXPIRES_AT || vulnerability.fixAvailable !== false) return false;
  if (name === "adm-zip") {
    return (
      vulnerability.isDirect === false &&
      vulnerability.effects?.length === 1 &&
      vulnerability.effects[0] === "aislop" &&
      vulnerability.via?.length > 0 &&
      vulnerability.via.every((item) => item.url === ADVISORY)
    );
  }
  return (
    name === "aislop" &&
    vulnerability.isDirect === true &&
    vulnerability.effects?.length === 0 &&
    vulnerability.via?.length === 1 &&
    vulnerability.via[0] === "adm-zip"
  );
}

function findings(report, now = Date.now()) {
  return Object.entries(report.vulnerabilities || {}).filter(
    ([name, vulnerability]) =>
      SEVERITY[vulnerability.severity] >= SEVERITY.moderate &&
      !waived(name, vulnerability, now),
  );
}

function audit(directory = ".") {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = spawnSync(
      "npm",
      ["audit", "--json", "--audit-level=moderate"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 90000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          npm_config_fetch_timeout: "60000",
          npm_config_fetch_retries: "1",
        },
      },
    );
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      // Retry registry or npm failures.
    }
    if (report && !report.error) {
      const failures = findings(report);
      for (const [name, vulnerability] of Object.entries(
        report.vulnerabilities || {},
      )) {
        if (waived(name, vulnerability)) {
          console.warn(
            `${name}: temporarily accepted ${ADVISORY}; expires 2026-10-09`,
          );
        }
      }
      if (!failures.length) return;
      console.error(JSON.stringify(Object.fromEntries(failures), null, 2));
      process.exitCode = 1;
      return;
    }
    if (attempt === 3) {
      process.stderr.write(
        result.stderr ||
          result.stdout ||
          "npm audit failed without diagnostics\n",
      );
      process.exitCode = 1;
      return;
    }
    console.warn(
      `npm audit could not reach the registry; retrying (${attempt}/3)`,
    );
  }
}

module.exports = { EXPIRES_AT, findings, waived };
if (require.main === module) audit(process.argv[2]);
