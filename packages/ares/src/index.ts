#!/usr/bin/env node
/**
 * stdio entry — for Claude Desktop / Cursor / local MCP clients.
 * Run via:  claude_desktop_config.json → command: "node", args: [".../dist/index.js"]
 *          or:  npx @czagents/ares
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildAresServer } from './server.js';

async function main() {
  const server = buildAresServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is reserved for MCP protocol
  console.error('[cz-agents/ares] MCP server ready on stdio');
}

main().catch((err) => {
  console.error('[cz-agents/ares] fatal:', err);
  process.exit(1);
});
