#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PACKAGE_VERSION } from "../shared/package-version.js";
import { loadMcpStack, scheduleQueueFlush, startupErrorMessage } from "./managed-config.js";
import { buildTools, type McpTool, type ToolResult } from "./tools.js";

export { startupErrorMessage } from "./managed-config.js";

export const SERVER_NAME = "hindsight-memory-router-mcp";

export function buildMcpServer(tools: McpTool[]): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: PACKAGE_VERSION });
  server.server.registerCapabilities({ tools: { listChanged: false } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ToolResult> => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: "unknown tool" }], isError: true };
    }
    const args = request.params.arguments;
    return tool.handler(args !== null && typeof args === "object" ? args : {});
  });
  return server;
}

async function main() {
  const stack = loadMcpStack(process.env, console);
  scheduleQueueFlush(stack, process.env, console);
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
