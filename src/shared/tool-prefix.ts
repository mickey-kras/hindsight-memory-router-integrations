export class ToolPrefixError extends Error {}

export const DEFAULT_TOOL_PREFIX = "hindsight_";
const PREFIX_PATTERN = /^[a-z][a-z0-9_]*_$/;
export const TOOL_SUFFIXES = [
  "retain",
  "recall",
  "list_pages",
  "get_page",
  "create_page",
  "update_page",
  "delete_page",
  "ingest",
  "list_banks",
  "read_bank_config",
  "sync_status",
  "diagnose",
  "search_knowledge_pages",
  "list_knowledge_pages",
  "read_knowledge_page",
  "reflect",
  "capture_initiative",
  "ingest_document",
];

export function validatedToolPrefix(value: unknown): string {
  if (value === undefined) return DEFAULT_TOOL_PREFIX;
  if (typeof value !== "string" || value.length > 32 || !PREFIX_PATTERN.test(value)) {
    throw new ToolPrefixError(
      "invalid toolPrefix: expected 2-32 lowercase letters, digits or underscores, ending in underscore",
    );
  }
  return value;
}

export function toolName(name: string, prefix: string): string {
  const source = ["memory_router_", "agent_knowledge_", DEFAULT_TOOL_PREFIX].find((part) => name.startsWith(part));
  if (!source) throw new ToolPrefixError("inconsistent tool prefix");
  return validatedToolPrefix(prefix) + name.slice(source.length);
}

export function renderToolText(text: string, prefix: string, sourcePrefix = DEFAULT_TOOL_PREFIX): string {
  const target = validatedToolPrefix(prefix);
  const source = validatedToolPrefix(sourcePrefix);
  const references = new RegExp(
    String.raw`${source}(${[...TOOL_SUFFIXES].sort((a, b) => b.length - a.length).join("|")})\b`,
    "g",
  );
  return text.replace(references, (_match, suffix: string) => target + suffix);
}

export function prefixTools<T extends { name: string; description: string }>(
  tools: T[],
  prefix: string,
  reservedNames: readonly string[] = [],
): T[] {
  const target = validatedToolPrefix(prefix);
  const names = new Set(reservedNames);
  return tools.map((tool) => {
    const name = toolName(tool.name, target);
    if (names.has(name)) throw new ToolPrefixError(`tool name collision: ${name}`);
    names.add(name);
    return { ...tool, name, description: renderBrandText(tool.description, target) };
  });
}

function assertSkillPrefix(text: string, prefix: string): void {
  const references = new RegExp(
    String.raw`\b([a-z][a-z0-9_]*_)(${[...TOOL_SUFFIXES].sort((a, b) => b.length - a.length).join("|")})\b`,
    "g",
  );
  for (const match of text.matchAll(references)) {
    // Hook diagnostic event names are not registered tools.
    if (match[0] === "inject_recall") continue;
    if (match[1] !== prefix) throw new ToolPrefixError("inconsistent skill/tool prefixes; reinstall to migrate");
  }
}

const SKILL_MARKER = /<!-- hindsight-tool-prefix: ([^\n]+) -->/;
export function renderCompanionSkill(raw: string, prefix: string, installed?: string): string {
  const target = validatedToolPrefix(prefix);
  const configured = SKILL_MARKER.exec(raw)?.[1] ?? DEFAULT_TOOL_PREFIX;
  assertSkillPrefix(raw, configured);
  if (configured !== DEFAULT_TOOL_PREFIX && configured !== target)
    throw new ToolPrefixError("inconsistent packaged skill/tool prefixes");
  if (installed !== undefined) {
    const existing = SKILL_MARKER.exec(installed)?.[1];
    assertSkillPrefix(installed, existing ?? DEFAULT_TOOL_PREFIX);
    if (existing !== undefined && existing !== target)
      throw new ToolPrefixError("installed skill/tool prefix mismatch; reinstall to migrate");
    if (existing === undefined && target !== DEFAULT_TOOL_PREFIX)
      throw new ToolPrefixError("installed skill/tool prefix mismatch; reinstall to migrate");
  }
  const body = raw.replace(SKILL_MARKER, "");
  return `${renderBrandText(body, target, configured)}\n<!-- hindsight-tool-prefix: ${target} -->\n`;
}

export function assertUniqueToolNames(tools: readonly { name: string }[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new ToolPrefixError(`tool name collision: ${tool.name}`);
    names.add(tool.name);
  }
}

export interface ToolBrand {
  prefix: string;
  id: string;
  skillName: string;
  displayName: string;
}

export function toolBrand(value: unknown = undefined): ToolBrand {
  const prefix = validatedToolPrefix(value);
  const id = prefix.slice(0, -1).replaceAll(/_+/g, "-").replace(/-$/, "");
  return {
    prefix,
    id,
    skillName: `${id}-coding-agent`,
    displayName: prefix === DEFAULT_TOOL_PREFIX ? "Hindsight" : id,
  };
}

export function renderBrandText(text: string, prefix: string, sourcePrefix = DEFAULT_TOOL_PREFIX): string {
  const brand = toolBrand(prefix);
  if (prefix === DEFAULT_TOOL_PREFIX && sourcePrefix === DEFAULT_TOOL_PREFIX) return text;
  return renderToolText(text, prefix, sourcePrefix)
    .replaceAll("Hindsight", brand.displayName)
    .replaceAll(/\bhindsight-coding-agent\b/g, brand.skillName)
    .replaceAll("in hindsight", `in ${brand.id}`);
}

export function skillPrefix(raw: string): string | undefined {
  const match = SKILL_MARKER.exec(raw)?.[1];
  return match === undefined ? undefined : validatedToolPrefix(match);
}
