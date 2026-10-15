#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { detectProvider, NO_PROVIDER, redact } from "./credentials.js";
import { ensureOpencode, stopOpencode } from "./opencode.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const server = new McpServer({ name: "cheapag", version });

/** Every tool answers through here, so no key value can reach Claude. */
const safeText = (s: string) => ({ content: [{ type: "text" as const, text: redact(s) }] });

server.registerTool(
  "ping",
  { description: "Check that the Cheap Agent server is running and report its version." },
  async () => {
    const provider = detectProvider();
    if (!provider) return safeText(NO_PROVIDER);
    try {
      const opencode = await ensureOpencode(provider);
      return safeText(`OK cheapag ${version} opencode=${opencode.version} provider=${provider.provider} via=${provider.via}`);
    } catch (err) {
      return safeText(`FAIL reason: ${(err as Error).message}`);
    }
  },
);

process.on("exit", stopOpencode);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit());
// Claude Code closing our stdin is the normal shutdown
process.stdin.on("end", () => process.exit());

await server.connect(new StdioServerTransport());
