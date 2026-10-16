import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { detectProvider, NO_PROVIDER, redact } from "./credentials.js";
import { delegate, jobs, recoverJobs, reply } from "./jobs.js";
import { ensureOpencode, stopOpencode } from "./opencode.js";
import { PLAN_FORMAT } from "./plan.js";
import { isSupported, UNSUPPORTED } from "./platform.js";
import { failBlock } from "./report.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** The MCP server over stdio: what Claude Code runs. */
export async function serve() {
  const server = new McpServer({ name: "cheapag", version });

  /** Every tool answers through here, so no key value can reach Claude. */
  const safeText = (s: string) => ({ content: [{ type: "text" as const, text: redact(s) }] });
  /** Answers every tool with the unsupported-platform FAIL on native Windows (spec A18). */
  const supported = <A extends unknown[]>(handler: (...args: A) => Promise<ReturnType<typeof safeText>>) =>
    (...args: A) => (isSupported() ? handler(...args) : Promise.resolve(safeText(UNSUPPORTED)));
  /** Worker progress as MCP progress notifications to the calling request, when it asked for them. */
  const progressTo = (extra: { _meta?: { progressToken?: string | number }; sendNotification: (n: ServerNotification) => Promise<void> }) =>
    (progress: number, message: string) => {
      const progressToken = extra._meta?.progressToken;
      if (progressToken !== undefined) void extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, message } });
    };

  server.registerTool(
    "ping",
    { description: "Check that the Cheap Agent server is running and report its version." },
    supported(async () => {
      const provider = detectProvider();
      if (!provider) return safeText(NO_PROVIDER);
      try {
        const opencode = await ensureOpencode(provider);
        return safeText(`OK cheapag ${version} opencode=${opencode.version} provider=${provider.provider} via=${provider.via}`);
      } catch (err) {
        return safeText(`FAIL reason: ${(err as Error).message}`);
      }
    }),
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
    supported(async (input, extra) => {
      const provider = detectProvider();
      if (!provider) return safeText(NO_PROVIDER);
      try {
        return safeText(await delegate(input, { provider, opencode: (route) => ensureOpencode(provider, process.cwd(), route), progress: progressTo(extra) }));
      } catch (err) {
        return safeText(failBlock((err as Error).message));
      }
    }),
  );

  server.registerTool(
    "reply",
    {
      description:
        "Answer a BLOCKED job's question and resume its worker in the same session. Returns the job's next result block (OK, FAIL, or BLOCKED again).",
      inputSchema: {
        job: z.string().describe('The BLOCKED job id, e.g. "j6a90"'),
        answer: z.string().max(500).describe('An option letter (a-d), or a short free-text answer'),
      },
    },
    supported(async (input, extra) => {
      if (!detectProvider()) return safeText(NO_PROVIDER);
      try {
        return safeText(await reply(input, progressTo(extra)));
      } catch (err) {
        return safeText(failBlock((err as Error).message));
      }
    }),
  );

  server.registerTool(
    "jobs",
    {
      description: "List jobs, show a job's last result block again, or cancel a running job (keeps its worktree).",
      inputSchema: {
        action: z.enum(["list", "show", "cancel"]).describe("list: one line per job; show: a job's last block; cancel: stop a running job"),
        job: z.string().optional().describe("Job id, e.g. j7f3a (show and cancel)"),
      },
    },
    supported(async (input) => {
      if (!detectProvider()) return safeText(NO_PROVIDER);
      try {
        return safeText(await jobs(input));
      } catch (err) {
        return safeText(failBlock((err as Error).message));
      }
    }),
  );

  // jobs a previous server left running or blocked can never finish now
  try {
    recoverJobs(process.cwd());
  } catch (err) {
    // recovery is housekeeping: a failure must not stop the server from starting
    process.stderr.write(`cheapag: job recovery failed: ${(err as Error).message}\n`);
  }
  process.on("exit", () => stopOpencode(true));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit());
  // Claude Code closing our stdin is the normal shutdown
  process.stdin.on("end", () => process.exit());

  await server.connect(new StdioServerTransport());
}
