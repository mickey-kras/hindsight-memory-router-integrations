const { spawnSync } = require("node:child_process");

const SEVERITY = { low: 1, moderate: 2, high: 3, critical: 4 };

function findings(report) {
  return Object.entries(report.vulnerabilities || {}).filter(([, vulnerability]) =>
    SEVERITY[vulnerability.severity] >= SEVERITY.moderate);
}

function audit(directory = ".") {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = spawnSync("npm", ["audit", "--json", "--audit-level=moderate"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, npm_config_fetch_timeout: "60000", npm_config_fetch_retries: "1" },
    });
    let report;
    try { report = JSON.parse(result.stdout); } catch { /* Retry registry or npm failures. */ }
    if (report && !report.error) {
      const failures = findings(report);
      if (!failures.length) return;
      console.error(JSON.stringify(Object.fromEntries(failures), null, 2));
      process.exitCode = 1;
      return;
    }
    if (attempt === 3) {
      process.stderr.write(result.stderr || result.stdout || "npm audit failed without diagnostics\n");
      process.exitCode = 1;
      return;
    }
    console.warn(`npm audit could not reach the registry; retrying (${attempt}/3)`);
  }
}

module.exports = { findings };
if (require.main === module) audit(process.argv[2]);
