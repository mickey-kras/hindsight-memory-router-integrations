const { mkdirSync, symlinkSync, realpathSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");

function safePath(directory) {
  mkdirSync(directory, { recursive: true });
  for (const name of ["node", "npm", "git", "which"]) {
    const executable = realpathSync(execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim());
    const link = join(directory, name);
    if (!existsSync(link)) symlinkSync(executable, link);
    assert.equal(realpathSync(link), executable, "Scanner tool path was replaced");
  }
  return directory;
}
module.exports = { safePath };
