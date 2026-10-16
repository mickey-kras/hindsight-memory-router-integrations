const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const scannerLine = fs
  .readFileSync(path.resolve(__dirname, "../workflows/trusted-ci.yml"), "utf8")
  .split("\n")
  .find((line) => line.trim().startsWith('"$RUNNER_TEMP/gitleaks/gitleaks" git candidate '))
  .trim();

test("Gitleaks forces text patches across complete history", () => {
  assert.match(scannerLine, /--log-opts="--full-history --all --text"/);
});

for (const attribute of ["-diff", "binary"]) {
  test(`pinned Gitleaks finds historical secrets hidden by ${attribute}`, {
    skip: !process.env.GITLEAKS_BINARY && "set GITLEAKS_BINARY to the verified pinned Gitleaks executable",
  }, () => {
    const binary = path.resolve(process.env.GITLEAKS_BINARY);
    assert.equal(execFileSync(binary, ["version"], { encoding: "utf8" }).trim(), "8.24.3");
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gitleaks-history-"));
    const candidate = path.join(temporary, "candidate");
    const runner = path.join(temporary, "runner");
    const env = { ...process.env, RUNNER_TEMP: runner, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    try {
      fs.mkdirSync(candidate);
      fs.mkdirSync(path.join(runner, "gitleaks"), { recursive: true });
      fs.mkdirSync(path.join(runner, "reports"));
      fs.symlinkSync(binary, path.join(runner, "gitleaks/gitleaks"));
      fs.symlinkSync(path.resolve(__dirname, "../.."), path.join(temporary, "trusted"));
      const git = (...args) =>
        execFileSync("git", ["-C", candidate, ...args], { env, encoding: "utf8", stdio: "pipe" });
      git("init", "--quiet");
      git("config", "user.name", "Scanner regression");
      git("config", "user.email", "scanner@example.invalid");
      fs.writeFileSync(path.join(candidate, ".gitattributes"), `secret.txt ${attribute}\n`);
      git("add", ".");
      git("commit", "--quiet", "-m", "Set candidate attributes");
      // Assemble synthetic credentials so this regression is not itself a stored secret.
      fs.writeFileSync(path.join(candidate, "secret.txt"), `token = ghp_${"aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6"}\n`);
      git("add", ".");
      git("commit", "--quiet", "-m", "Historical synthetic secret");
      const secretCommit = git("rev-parse", "HEAD").trim();
      git("rm", "--quiet", "secret.txt");
      git("commit", "--quiet", "-m", "Remove secret from current tree");
      assert.equal(fs.existsSync(path.join(candidate, "secret.txt")), false);
      const report = path.join(runner, "reports/gitleaks.sarif");
      const scan = (line) =>
        spawnSync("bash", ["-euo", "pipefail", "-c", line], { cwd: temporary, env, encoding: "utf8" });
      const hidden = scan(scannerLine.replace("--full-history --all --text", "--full-history --all"));
      assert.equal(hidden.status, 0, hidden.stderr);
      assert.equal(JSON.parse(fs.readFileSync(report, "utf8")).runs[0].results.length, 0);
      const forced = scan(scannerLine);
      assert.equal(forced.status, 1, forced.stderr);
      const results = JSON.parse(fs.readFileSync(report, "utf8")).runs[0].results;
      assert.ok(
        results.some((result) =>
          result.locations.some((location) => location.physicalLocation.artifactLocation.uri === "secret.txt"),
        ),
      );
      assert.ok(JSON.stringify(results).includes(secretCommit), "report must identify the historical secret commit");
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}
