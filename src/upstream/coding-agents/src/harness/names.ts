export const HARNESS_NAMES = [
  "opencode",
  // opencode v2 (binary `opencode2`) — a ground-up rewrite of the plugin API, loaded from the
  // package's root index.js (src/opencode2.ts). Like opencode it has NO hook binary.
  "opencode2",
  // Kilo CLI is an opencode fork loaded as a persistent plugin (src/kilo.ts), so like opencode it
  // has NO hook binary — deliberately absent from HOOK_BINS below.
  "kilo",
  // Cline CLI loads dist/cline.js through its native plugin manager; file hooks cannot inject.
  "cline-cli",
  // DeepSeek Harness loads dist/dsh.js as a native Cordis plugin (src/dsh.ts). Its Claude Code /
  // Codex hook bridges are optional packages, so there is no hook binary to install either.
  "dsh",
  // pi loads dist/pi.js as an extension (src/pi.ts), and Prime Agent — a fork of pi — loads
  // dist/prime-agent.js the same way (src/prime-agent.ts). Neither has a hook binary.
  "pi",
  "prime-agent",
  "claude-code",
  "cursor-cli",
  "codex",
  "dcode",
  "antigravity-cli",
  "devin-cli",
  "copilot-cli",
  "grok-build",
  "qwen-code",
  // Factory Droid is a per-prompt HOOK host: the installer wires ~/.factory/hooks.json and the
  // stdio MCP registration in ~/.factory/mcp.json (see src/installer.ts).
  "factory-droid",
  // ZCode is a per-prompt HOOK host too, registered in its own CLI config
  // (~/.zcode/cli/config.json) under `hooks.events` — never the user's real Claude Code settings.
  "zcode",
  // TraeCode is a per-prompt HOOK host registered in ~/.trae-cn/hooks.json (see src/installer.ts).
  "traecode",
  "kimi-code",
  // WorkBuddy is a per-prompt HOOK host too: the installer wires ~/.workbuddy/settings.json and
  // the stdio MCP registration in ~/.workbuddy/mcp.json (see src/installer.ts).
  "workbuddy",
  // CodeBuddy Code is the SAME @genie/agent-cli HOOK host, one product config apart (WorkBuddy only
  // renames the home folder): the installer wires ~/.codebuddy/settings.json and the stdio MCP
  // registration in CodeBuddy's priority-chained MCP file (see src/installer.ts). The CLI
  // writes WorkBuddy's transcript format; the CodeBuddy IDE has a reader of its own.
  "codebuddy",
];
