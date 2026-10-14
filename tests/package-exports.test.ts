import { execFileSync } from "node:child_process";
import { beforeAll, expect, it } from "vitest";

beforeAll(() => {
  execFileSync("npm", ["run", "build", "--silent"], { cwd: process.cwd() });
}, 120000);

it("loads the root plugin through its CommonJS package self-reference", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `
    const plugin = require("@mickey-kras/hindsight-memory-router-openclaw");
    if (typeof plugin.default !== "function") throw new Error("missing plugin entrypoint");
    process.stdout.write(plugin.PLUGIN_ID);
  `,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  expect(output).toBe("hindsight-memory-router");
});
