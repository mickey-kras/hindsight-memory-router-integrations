#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PACKAGE_VERSION } from "../shared/package-version.js";
import { loadMcpStack, scheduleQueueFlush, startupErrorMessage } from "./managed-config.js";
import { buildTools, type McpTool } from "./tools.js";

export { startupErrorMessage } from "./managed-config.js";

export const SERVER_NAME = "hindsight-memory-router-mcp";

export function buildMcpServer(tools: McpTool[]): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: PACKAGE_VERSION });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args) => tool.handler(args),
    );
  }
  return server;
}

// console.info writes to stdout and would corrupt the stdio JSON-RPC stream; all logs stay on stderr.
const STDERR_LOGGER = {
  info: (msg: string) => process.stderr.write(`${msg}\n`),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

async function main() {
  const stack = loadMcpStack(process.env, STDERR_LOGGER);
  scheduleQueueFlush(stack, process.env, STDERR_LOGGER);
  await buildMcpServer(buildTools(stack)).connect(new StdioServerTransport());
}

// The bin is usually invoked through an npm .bin symlink; resolve it before comparing.
function isDirectInvocation(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    await main();
  } catch (error: unknown) {
    console.error(`${SERVER_NAME} failed to start: ${startupErrorMessage(error)}`);
    process.exit(1);
  }
}
