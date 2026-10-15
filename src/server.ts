import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { detectProvider, NO_PROVIDER, redact } from "./credentials.js";
import { delegate } from "./jobs.js";
import { ensureOpencode, stopOpencode } from "./opencode.js";
import { PLAN_FORMAT } from "./plan.js";
import { failBlock } from "./report.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** The MCP server over stdio: what Claude Code runs. */
export async function serve() {
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

  server.registerTool(
    "delegate",
    {
      description:
        `Hand plan steps to the cheap worker. It edits an isolated worktree; an OK result is already landed (uncommitted) in your working tree. ${PLAN_FORMAT}`,
      inputSchema: {
        plan: z.string().describe("Plan file path, relative to the repository root"),
        steps: z.string().describe('The plan step id to run, e.g. "3"'),
        note: z.string().max(300).optional().describe("Extra guidance for this run, at most 300 characters"),
      },
    },
    async (input, extra) => {
      const provider = detectProvider();
      if (!provider) return safeText(NO_PROVIDER);
      const progressToken = extra._meta?.progressToken;
      try {
        return safeText(
          await delegate(input, {
            provider,
            opencode: () => ensureOpencode(provider),
            progress: (progress, message) => {
              if (progressToken !== undefined) {
                void extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, message } });
              }
            },
          }),
        );
      } catch (err) {
        return safeText(failBlock((err as Error).message));
      }
    },
  );

  process.on("exit", stopOpencode);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit());
  // Claude Code closing our stdin is the normal shutdown
  process.stdin.on("end", () => process.exit());

  await server.connect(new StdioServerTransport());
}
