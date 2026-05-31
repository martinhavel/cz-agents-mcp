#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildPayqrServer } from './server.js';

async function main() {
  const server = buildPayqrServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[cz-agents/payqr] MCP server ready on stdio');
}

main().catch((err) => {
  console.error('[cz-agents/payqr] fatal:', err);
  process.exit(1);
});
