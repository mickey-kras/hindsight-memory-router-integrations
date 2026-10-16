const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { safePath } = require("./safe-path.cjs");

test("scanner subprocesses cannot discover candidate Cargo/Ruby/PHP/npx canaries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-path-"));
  try {
    const bin = safePath(path.join(dir, "safe"));
    const marker = path.join(dir, "executed");
    const hostile = path.join(dir, "hostile");
    fs.mkdirSync(hostile);
    for (const command of ["cargo", "ruby", "php", "npx", "dotnet", "rubocop"]) {
      fs.writeFileSync(path.join(hostile, command), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      const result = spawnSync(command, [], { cwd: hostile, env: { ...process.env, PATH: bin } });
      assert.equal(result.error.code, "ENOENT");
    }
    assert.equal(fs.existsSync(marker), false);
    assert.equal(spawnSync("node", ["--version"], { env: { ...process.env, PATH: bin } }).status, 0);
    assert.equal(safePath(bin), bin);
    fs.unlinkSync(path.join(bin, "node"));
    fs.symlinkSync("/bin/false", path.join(bin, "node"));
    assert.throws(() => safePath(bin), /replaced/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
