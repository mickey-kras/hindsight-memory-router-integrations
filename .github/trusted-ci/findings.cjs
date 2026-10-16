const { readFileSync } = require("node:fs");
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const findings = report.runs
  .flatMap((run) => run.results || [])
  .filter((finding) => finding.ruleId !== "security/vulnerable-dependency");
if (findings.length) {
  console.error(`Aislop reported ${findings.length} finding(s)`);
  process.exitCode = 1;
}
