#!/usr/bin/env node
/** Generate the managed companion skill from its operational sources. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const managed = join(pkgRoot, "skill-src", "managed-router.md");
const preamble = join(pkgRoot, "skill-src", "preamble.md");
const skill = join(pkgRoot, "skill", "SKILL.md");

const BEGIN = /^<!--\s*skill:begin(?:\s+title="([^"]*)")?\s*-->$/;
const END = /^<!--\s*skill:end\s*-->$/;

/** The marked regions of the README, in file order, with heading levels normalised. */
export function regions(src) {
  const out = [];
  let current = null;
  for (const line of src.split("\n")) {
    const begin = BEGIN.exec(line);
    if (begin) {
      if (current) throw new Error("nested <!-- skill:begin -->");
      current = { title: begin[1], lines: [] };
      continue;
    }
    if (END.test(line)) {
      if (!current) throw new Error("<!-- skill:end --> without a begin");
      out.push(render(current));
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) throw new Error("unterminated <!-- skill:begin -->");
  if (!out.length) throw new Error("no <!-- skill:begin --> regions in the README");
  return out;
}

function render({ title, lines }) {
  const body = lines.join("\n").trim();
  const first = /^(#{1,6})\s/m.exec(body);
  if (!first) {
    if (!title) throw new Error("a region with no heading must declare title=");
    return `## ${title}\n\n${body}`;
  }
  const shift = 2 - first[1].length;
  const shifted = body.replaceAll(/^(#{1,6})(\s)/gm, (_, hashes, space) => {
    const level = Math.min(6, Math.max(1, hashes.length + shift));
    return "#".repeat(level) + space;
  });
  return title ? `## ${title}\n\n${shifted}` : shifted;
}

export function build() {
  const head = readFileSync(preamble, "utf8").trimEnd();
  const marker =
    "<!-- GENERATED from skill-src/preamble.md + skill-src/managed-router.md.\n" +
    "     Edit those, then run: node scripts/build-skill.mjs -->";
  // The frontmatter block has to stay first for the host to parse the skill at all.
  const fm = /^---\n[\s\S]*?\n---\n/.exec(head);
  if (!fm) throw new Error("skill-src/preamble.md must start with a frontmatter block");
  const withMarker = `${fm[0]}\n${marker}\n\n${head.slice(fm[0].length).trimStart()}`;
  const body = [withMarker, readFileSync(managed, "utf8").trim()].join("\n\n");
  return `${body.replaceAll(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// Guarded so the test can import regions()/build() without the CLI running on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const generated = build();
  if (process.argv.includes("--check")) {
    if (readFileSync(skill, "utf8") !== generated) {
      console.error(
        "[coding-agents] ❌ skill/SKILL.md is out of date with the managed skill sources.\n" +
          "  Run: node scripts/build-skill.mjs"
      );
      process.exit(1);
    }
    console.log("[coding-agents] ✅ skill/SKILL.md matches the managed skill sources.");
  } else {
    writeFileSync(skill, generated);
    console.log(`[coding-agents] wrote ${skill} from managed skill sources.`);
  }
}
