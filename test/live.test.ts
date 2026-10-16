import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import { expect, onTestFinished, test } from "vitest";
import { opencodeBinary } from "../src/opencode.js";
import { callText, startServer, tempRepo } from "./harness.js";

/**
 * Opt-in live checks against the real bundled OpenCode and a real model. They cost money:
 *   CHEAPAG_LIVE=1 OPENROUTER_API_KEY=… npx vitest run test/live.test.ts --silent=false
 * The product never reads that variable (ADR-0004): the harness seeds it as a saved login in the hermetic store.
 * Each test prints what it observed and spent, for the ticket ledger.
 */
const key = process.env.OPENROUTER_API_KEY;
const live = test.skipIf(!process.env.CHEAPAG_LIVE || !key);

live("a one-step delegate on OpenRouter lands OK, uncommitted", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, ".plan"));
  writeFileSync(join(repo.dir, ".plan", "live.md"), [
    "# Live smoke",
    "## 1 greeting file",
    "files: hello.txt",
    "do: create hello.txt containing exactly the line: hello from cheapag",
    "done-when: `grep -qx \"hello from cheapag\" hello.txt` succeeds",
    "",
  ].join("\n"));
  const server = await startServer({ cwd: repo.dir, logins: { openrouter: key! }, allow: [] });
  onTestFinished(server.close);

  const progress: string[] = [];
  const result = await server.client.callTool({ name: "delegate", arguments: { plan: ".plan/live.md", steps: "1" } }, undefined, {
    onprogress: (p) => void progress.push(p.message ?? ""),
    timeout: 300_000,
  });
  const text = (result.content as { text: string }[])[0].text;
  console.log(`LIVE delegate block:\n${text}\nprogress: ${JSON.stringify(progress)}`);
  expect(text).toMatch(/^OK j[0-9a-z]{4} step=1 .* tests=pass /);
  const reported = !text.includes("worker did not report");
  expect(readFileSync(join(repo.dir, "hello.txt"), "utf8").trim()).toBe("hello from cheapag");
  expect(repo.git("log", "--oneline").trim().split("\n")).toHaveLength(1);
  expect(repo.git("status", "--porcelain", "--", "hello.txt")).toBe("?? hello.txt\n");

  // protocol facts ticket 03 inferred from the SDK types, as observed on the real server
  const job = text.match(/^OK (j[0-9a-z]{4})/)![1];
  const events = readFileSync(join(repo.dir, ".cheapag", "jobs", job, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Event);
  const costs = new Map<string, number[]>();
  for (const e of events) if (e.type === "message.updated" && e.properties.info.role === "assistant") costs.set(e.properties.info.id, [...(costs.get(e.properties.info.id) ?? []), e.properties.info.cost]);
  const finish = events.find((e) => e.type === "message.part.updated" && e.properties.part.type === "tool" && e.properties.part.tool === "finish" && e.properties.part.state.status === "completed");
  const calls = events.flatMap((e) => (e.type === "message.part.updated" && e.properties.part.type === "tool" && e.properties.part.state.status !== "pending" && e.properties.part.state.status !== "running" ? [`${e.properties.part.tool}:${e.properties.part.state.status}:${JSON.stringify(e.properties.part.state.input).slice(0, 80)}`] : []));
  console.log(`LIVE tool calls: ${JSON.stringify([...new Set(calls)])}`);
  console.log(`LIVE message.updated cost series per assistant message: ${JSON.stringify([...costs.values()])}`);
  console.log(`LIVE finish part state.input: ${JSON.stringify(finish && (finish.properties as any).part.state.input)}`);
  console.log(`LIVE event types: ${JSON.stringify([...new Set(events.map((e) => e.type))])}`);
  // a real model sometimes just stops after checking its work; the placeholder covers that, so this is logged, not
  // asserted. That `finish` is allowed at all is pinned in delegate.test.ts.
  console.log(`LIVE worker called finish: ${reported}`);
}, 300_000);

live("abort on a real session: observed event sequence", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const server = await startServer({ cwd: repo.dir, logins: { openrouter: key! }, allow: [] });
  onTestFinished(server.close);
  expect(await callText(server.client, "ping")).toMatch(/^OK .* provider=openrouter via=login$/);

  // a second, test-owned OpenCode on the config ping just generated, so the test holds the password
  const opencode = spawn(opencodeBinary(), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    detached: true,
    // same hermetic credential store the server uses
    env: { ...process.env, XDG_DATA_HOME: join(server.home, "data"), OPENCODE_SERVER_PASSWORD: "live", OPENCODE_CONFIG_DIR: join(repo.dir, ".cheapag", "opencode"), OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
  });
  onTestFinished(() => {
    try {
      process.kill(-opencode.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  });
  const url = await new Promise<string>((resolve, reject) => {
    opencode.stdout.on("data", (d) => {
      const m = String(d).match(/(http:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    opencode.on("error", reject);
    opencode.on("exit", (code) => reject(new Error(`opencode serve exited (${code}) before listening`)));
  });
  const client = createOpencodeClient({ baseUrl: url, directory: repo.dir, headers: { authorization: `Basic ${Buffer.from("opencode:live").toString("base64")}` } });
  const { stream } = await client.event.subscribe({ directory: repo.dir });
  await stream.next();
  const session = (await client.session.create({ directory: repo.dir, agent: "cheapag-worker", model: { providerID: "openrouter", id: "deepseek/deepseek-v4.1-flash" } })).data!;
  await client.session.promptAsync({ sessionID: session.id, directory: repo.dir, parts: [{ type: "text", text: "Write a 400-word story about a lighthouse. Do not use tools." }] });

  const seen: string[] = [];
  let aborted = false;
  for await (const raw of stream) {
    const e = raw as Event;
    if ((e.properties as { sessionID?: string }).sessionID !== session.id) continue;
    seen.push(e.type === "session.status" ? `session.status:${e.properties.status.type}` : e.type === "session.error" ? `session.error:${(e.properties.error as any)?.name}` : e.type);
    if (!aborted && e.type === "message.part.updated") {
      aborted = true;
      seen.push("--abort--");
      await client.session.abort({ sessionID: session.id, directory: repo.dir });
    }
    if (aborted && e.type === "session.idle") break;
  }
  console.log(`LIVE abort sequence: ${JSON.stringify(seen.filter((t, i) => t !== seen[i - 1] || !t.startsWith("message.part")))}`);
  expect(seen).toContain("session.idle");
}, 120_000);

live("a worker question → BLOCKED; after a long wait a free-text reply resumes the same session and lands", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, ".plan"));
  writeFileSync(join(repo.dir, ".plan", "ask.md"), [
    "# Live question",
    "## 1 named greeting",
    "files: greeting.txt",
    "do: BEFORE writing anything, use the question tool to ask which name to greet, with the options Ada and Linus.",
    "  Then create greeting.txt containing exactly: hello <name>",
    "done-when: `test -s greeting.txt`",
    "",
  ].join("\n"));
  const server = await startServer({ cwd: repo.dir, logins: { openrouter: key! }, allow: [] });
  onTestFinished(server.close);
  const call = async (name: string, args: Record<string, string>) =>
    ((await server.client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })).content as { text: string }[])[0].text;

  const blocked = await call("delegate", { plan: ".plan/ask.md", steps: "1" });
  console.log(`LIVE blocked block:\n${blocked}`);
  expect(blocked).toMatch(/^BLOCKED j[0-9a-z]{4} step=1 /);
  const job = blocked.match(/^BLOCKED (j[0-9a-z]{4})/)![1];
  await new Promise((r) => setTimeout(r, 30_000)); // an idle event stream held open across a slow answer
  const done = await call("reply", { job, answer: "Grace" }); // free text, not one of the options
  console.log(`LIVE after reply:\n${done}`);
  expect(done).toMatch(new RegExp(`^OK ${job} step=1 .* tests=pass `));
  expect(readFileSync(join(repo.dir, "greeting.txt"), "utf8").trim()).toBe("hello Grace");
}, 300_000);

live("research answers from the main checkout with refs, read-only", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src", "auth.ts"), "export function login(user: string) {\n  return user === \"admin\";\n}\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "auth");
  const before = repo.git("status", "--porcelain", "--untracked-files=all");
  const server = await startServer({ cwd: repo.dir, logins: { openrouter: key! }, allow: [] });
  onTestFinished(server.close);
  const text = ((await server.client.callTool({ name: "research", arguments: { question: "Where is the login function defined, and what does it return?" } }, undefined, { timeout: 300_000 })).content as { text: string }[])[0].text;
  console.log(`LIVE research block:\n${text}`);
  expect(text).toMatch(/^(ANSWER|UNSURE) r[0-9a-z]{4} /);
  expect(text).toContain("src/auth.ts");
  expect(repo.git("status", "--porcelain", "--untracked-files=all")).toBe(before); // read-only (.cheapag is excluded)
}, 300_000);

live("a landing conflict on a real model: one redo in the same session (worktree recreated) → OK redo=1, or CONFLICT", async () => {
  const repo = tempRepo(); // README.md is tracked: "# fixture"
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, ".plan"));
  writeFileSync(join(repo.dir, ".plan", "redo.md"), [
    "# Live redo",
    "## 1 title",
    "files: README.md",
    "do: replace the first line of README.md with exactly: # Cheap Agent",
    "done-when: `grep -q 'Cheap Agent' README.md` succeeds",
    "",
  ].join("\n"));
  const server = await startServer({ cwd: repo.dir, logins: { openrouter: key! }, allow: [] });
  onTestFinished(server.close);
  const pending = server.client.callTool({ name: "delegate", arguments: { plan: ".plan/redo.md", steps: "1" } }, undefined, { timeout: 300_000 });
  // the developer edits the same line in the main checkout once the worker has made its change, before it lands
  const worktrees = join(repo.dir, ".cheapag", "worktrees");
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      const [job] = existsSync(worktrees) ? readdirSync(worktrees) : [];
      if (job && readFileSync(join(worktrees, job, "README.md"), "utf8").includes("Cheap Agent")) {
        clearInterval(poll);
        writeFileSync(join(repo.dir, "README.md"), "# Mine\n");
        resolve();
      }
    }, 20);
  });
  const text = ((await pending).content as { text: string }[])[0].text;
  console.log(`LIVE redo block:\n${text}`);
  expect(text).toMatch(/^(OK j[0-9a-z]{4} .* redo=1|CONFLICT j[0-9a-z]{4} )/);
  if (text.startsWith("CONFLICT")) expect(readFileSync(join(repo.dir, "README.md"), "utf8")).toBe("# Mine\n"); // untouched
}, 300_000);
