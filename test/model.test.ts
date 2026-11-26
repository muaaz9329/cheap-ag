import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, onTestFinished, test, vi } from "vitest";
import { select } from "../src/prompt.js";
import { startFakeOpencode } from "./fake-opencode.js";
import * as prompt from "../src/prompt.js";
import { model } from "../src/model.js";
import { stopOpencode } from "../src/opencode.js";
import { hermeticHome, homeEnv, serverEntry, tempRepo, type Logins } from "./harness.js";

/** Runs the real `cheapag model <args>` against the fake OpenCode; async because the fake lives in this process. */
async function run(...args: string[]) {
  return runAs({ "opencode-go": "k" }, ...args);
}

/** The same with other saved logins. */
async function runAs(logins: Logins, ...args: string[]) {
  const fake = await startFakeOpencode();
  const { home, env } = hermeticHome(logins);
  onTestFinished(async () => {
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  });
  const exec = promisify(execFile)(process.execPath, [serverEntry, "model", ...args], {
    cwd: home,
    env: { ...env, CHEAPAG_OPENCODE_URL: fake.url },
  });
  const { stdout } = await exec.catch((e) => e);
  return {
    stdout: stdout as string,
    config: () => readFileSync(join(home, "config", "cheapag", "config.json"), "utf8"),
  };
}

test("--list prints the current models, the suggestions, and ends with the line about more models", async () => {
  const { stdout } = await run("--list");
  const lines = stdout.trim().split("\n");
  expect(lines.slice(0, 4)).toEqual([
    "Provider: OpenCode Go",
    "Main: deepseek-v4.1-flash (effort default)",
    "Fallback: qwen3.7-plus (effort default)",
    "Suggestions:",
  ]);
  expect(lines.slice(4)).toEqual([
    "small-flash · $0.14/$0.28 per M · 128K ctx · efforts: none",
    "big-reasoner · $0.9/$2.7 per M · 256K ctx · efforts: high, max",
    "For more models, exit Claude/Codex and run: npx cheap-agent model",
  ]);
});

test("--main with a valid id and effort saves the user config", async () => {
  const { stdout, config } = await run(
    "--main",
    "opencode-go/big-reasoner",
    "--effort",
    "max",
    "--fallback",
    "small-flash",
  );
  expect(stdout).toMatch(
    /^✓ main opencode-go\/big-reasoner \(effort max\), fallback opencode-go\/small-flash \(effort default\) — saved in .*; the next job uses it\n$/,
  );
  expect(JSON.parse(config()).models).toEqual({
    implement: "opencode-go/big-reasoner",
    research: "opencode-go/big-reasoner",
    fallback: ["opencode-go/small-flash"],
    variants: { "opencode-go/big-reasoner": "max" },
  });
});

test("an unknown id, a chat-only model and a wrong effort are refused", async () => {
  expect((await run("--main", "nope")).stdout).toBe(
    "✗ nope is not a tool-calling model on OpenCode Go; run npx cheap-agent model --list\n",
  );
  expect((await run("--main", "chat-only")).stdout).toContain(
    "chat-only is not a tool-calling model",
  );
  expect((await run("--main", "small-flash", "--effort", "high")).stdout).toBe(
    "✗ small-flash has no effort high; it has: none\n",
  );
  expect((await run("--main", "big-reasoner", "--effort", "low")).stdout).toBe(
    "✗ big-reasoner has no effort low; it has: high, max\n",
  );
});

/** A fake terminal: `select` reads these keys and writes its drawing to the sink. */
function drive(keys: string) {
  const input = Object.assign(new PassThrough(), { setRawMode: vi.fn(), isTTY: true }) as any;
  const output = Object.assign(new PassThrough(), { columns: 80 }) as any;
  const options = [{ label: "a" }, { label: "b", hint: "hint" }, { label: "c" }];
  const picked = select("Pick:", options, 0, { input, output });
  setImmediate(() => input.write(keys));
  return { picked, input };
}

test("select: arrows and Enter, Enter alone, a number jumps, and the terminal is restored", async () => {
  const down = drive("\x1b[B\x1b[B\r");
  expect(await down.picked).toBe(2);
  expect(down.input.setRawMode).toHaveBeenLastCalledWith(false);
  expect(await drive("\r").picked).toBe(0);
  expect(await drive("2\r").picked).toBe(1);
});

test("select: Ctrl-C restores the terminal and exits 130", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  onTestFinished(() => {
    exit.mockRestore();
  });
  const { input } = drive("\x03");
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
  expect(input.setRawMode).toHaveBeenLastCalledWith(false);
});

test("an unknown or incomplete argument prints it with the usage; a catalog error is printed and exits 1", async () => {
  const usage =
    "usage: cheapag model [--list | --main <id> [--effort <e>] [--fallback <id|none>] [--fallback-effort <e>]]\n";
  expect((await run("--bogus")).stdout).toBe(`✗ unknown or incomplete argument --bogus\n${usage}`);
  expect((await run("--main")).stdout).toBe(`✗ unknown or incomplete argument --main\n${usage}`);
  // the fake's catalog only lists OpenCode Go
  expect((await runAs({ deepseek: "k" }, "--list")).stdout).toBe(
    "✗ OpenCode lists no models for deepseek\n",
  );
});

/** `cheapag model` in this process on a terminal, with the picker answering `answers` in order; returns what it printed and each question asked. */
async function pickInteractively(
  answers: number[],
  opts: {
    logins?: Logins;
    providers?: Parameters<typeof startFakeOpencode>[0] extends infer O
      ? O extends { providers?: infer P }
        ? P
        : never
      : never;
    cwd?: string;
  } = {},
) {
  const fake = await startFakeOpencode({ providers: opts.providers });
  const { home } = hermeticHome(opts.logins ?? { "opencode-go": "k" });
  for (const [key, value] of Object.entries(homeEnv(home)))
    if (key.startsWith("XDG_")) vi.stubEnv(key, value);
  vi.stubEnv("CHEAPAG_OPENCODE_URL", fake.url);
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(opts.cwd ?? home);
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  const questions: { question: string; options: string[]; initial: number }[] = [];
  const select = vi
    .spyOn(prompt, "select")
    .mockImplementation(async (question, options, initial = 0) => {
      questions.push({ question, options: options.map((o) => o.label), initial });
      return answers.shift()!;
    });
  let printed = "";
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => ((printed += chunk), true));
  onTestFinished(async () => {
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    stopOpencode();
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  });
  const code = await model([]);
  stdout.mockRestore();
  select.mockRestore();
  cwd.mockRestore();
  const file = join(home, "config", "cheapag", "config.json");
  return { code, printed, questions, config: () => JSON.parse(readFileSync(file, "utf8")) };
}

test("on a terminal the picker asks main, its effort, and the fallback (no effort question for a model without efforts), then saves", async () => {
  // catalog order is cheapest first: small-flash, big-reasoner
  const r = await pickInteractively([1, 2, 1]);
  expect(r.code).toBe(0);
  expect(r.questions).toEqual([
    {
      question: "Main model on OpenCode Go (writes the code):",
      options: ["small-flash", "big-reasoner"],
      initial: 0,
    },
    { question: "Effort for main big-reasoner:", options: ["default", "high", "max"], initial: 0 },
    {
      question: "Fallback model (used on a rate limit):",
      options: ["none", "small-flash", "big-reasoner"],
      initial: 0,
    },
  ]);
  expect(r.printed).toMatch(
    /^✓ main opencode-go\/big-reasoner \(effort max\), fallback opencode-go\/small-flash \(effort default\) — saved in .*; the next job uses it\n$/,
  );
  expect(r.config().models).toEqual({
    implement: "opencode-go/big-reasoner",
    research: "opencode-go/big-reasoner",
    fallback: ["opencode-go/small-flash"],
    variants: { "opencode-go/big-reasoner": "max" },
  });
});

test("the picker's default effort and no fallback save neither", async () => {
  const r = await pickInteractively([1, 0, 0]);
  expect(r.printed).toMatch(/^✓ main opencode-go\/big-reasoner \(effort default\), fallback none /);
  expect(r.config().models).toEqual({
    implement: "opencode-go/big-reasoner",
    research: "opencode-go/big-reasoner",
    fallback: [],
  });
});

test("on OpenRouter a pick inside a repo with consent re-accepts the route, so the new model needs no second approval", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const consentFile = join(repo.dir, ".cheapag", "consent.json");
  const providers = [
    {
      id: "openrouter",
      models: [
        { id: "acme/coder", name: "Coder", toolcall: true, input: 1, output: 2, context: 100_000 },
      ],
    },
  ];
  expect(
    (await pickInteractively([0, 0], { logins: { openrouter: "k" }, providers, cwd: repo.dir }))
      .code,
  ).toBe(0);
  expect(existsSync(consentFile)).toBe(false); // no consent yet: picking a model never creates one
  mkdirSync(join(repo.dir, ".cheapag"), { recursive: true });
  writeFileSync(
    consentFile,
    JSON.stringify({
      mode: "all",
      provider: "openrouter",
      route: ["openrouter/old/model"],
      approvedAt: "2026-11-01T00:00:00Z",
    }),
  );
  expect(
    (await pickInteractively([0, 0], { logins: { openrouter: "k" }, providers, cwd: repo.dir }))
      .code,
  ).toBe(0);
  const consent = JSON.parse(readFileSync(consentFile, "utf8"));
  expect(consent).toMatchObject({
    mode: "all",
    provider: "openrouter",
    approvedAt: "2026-11-01T00:00:00Z",
  });
  expect(consent.route).toContain("openrouter/acme/coder");
  expect(consent.route).not.toContain("openrouter/old/model");
});
