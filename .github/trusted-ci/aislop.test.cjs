const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { prepare } = require("./scan-tree.cjs");

function duplicateFindings(directory) {
  const entry = require.resolve("aislop");
  const installed = JSON.parse(fs.readFileSync(path.resolve(path.dirname(entry), "../package.json"), "utf8"));
  assert.equal(installed.version, require("./package.json").dependencies.aislop);
  const scanner = pathToFileURL(entry).href;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { loadConfig, scanCommand } from ${JSON.stringify(scanner)};
       await scanCommand(process.argv[1], loadConfig(process.argv[2]), { sarif: true, command: "ci" });`,
      directory,
      __dirname,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AISLOP_NO_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        AISLOP_NO_HISTORY: "1",
        AISLOP_NO_UPDATE_NOTIFIER: "1",
      },
    },
  );
  return JSON.parse(output)
    .runs.flatMap((run) => run.results || [])
    .filter((result) => result.ruleId === "code-quality/duplicate-block").length;
}

test("preparation rejects every pinned duplicate-detector suppression form", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-suppression-"));
  try {
    const source = path.join(directory, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    const body = [
      "let amount = input.amount;",
      "amount += input.tax;",
      "amount -= input.discount;",
      "const rate = input.rate;",
      "const subtotal = amount * rate;",
      "const charge = subtotal + input.fee;",
      "const floor = Math.max(charge, input.min);",
      "const ceiling = Math.min(floor, input.max);",
      "const rounded = Math.round(ceiling);",
      "const label = String(rounded);",
      "return label;",
    ].join("\n");
    const content = `export function first(input) {\n${body}\n}\nexport function second(input) {\n${body}\n}\n`;
    const candidate = path.join(source, "main.js");
    fs.writeFileSync(candidate, content);
    const baseline = prepare(source, path.join(directory, "baseline"));
    assert.equal(duplicateFindings(baseline), 1);
    for (const separator of ["-", " "]) {
      for (const scope of ["", "-file", "-next-block"]) {
        const directive = `aislop${separator}ignore${scope} code-quality/duplicate-block`;
        const suppressed = `export const reason = ${JSON.stringify(directive)};\n${content}`;
        fs.writeFileSync(candidate, suppressed);
        assert.equal(duplicateFindings(source), 0, directive);
        assert.throws(
          () => prepare(source, path.join(directory, `rejected-${separator === "-" ? "hyphen" : "space"}${scope}`)),
          /inline scanner suppression/,
          directive,
        );
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
