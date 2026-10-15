#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const server = new McpServer({ name: "cheapag", version });

server.registerTool(
  "ping",
  { description: "Check that the Cheap Agent server is running and report its version." },
  async () => ({ content: [{ type: "text", text: `OK cheapag ${version}` }] }),
);

await server.connect(new StdioServerTransport());
