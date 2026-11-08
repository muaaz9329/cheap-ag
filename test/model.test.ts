import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, onTestFinished, test, vi } from "vitest";
import { select } from "../src/prompt.js";
import { startFakeOpencode } from "./fake-opencode.js";
import { hermeticHome, serverEntry } from "./harness.js";

/** Runs the real `cheapag model <args>` against the fake OpenCode; async because the fake lives in this process. */
async function run(...args: string[]) {
  const fake = await startFakeOpencode();
  const { home, env } = hermeticHome({ "opencode-go": "k" });
  onTestFinished(async () => {
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  });
  const exec = promisify(execFile)(process.execPath, [serverEntry, "model", ...args], { cwd: home, env: { ...env, CHEAPAG_OPENCODE_URL: fake.url } });
  const { stdout } = await exec.catch((e) => e);
  return { stdout: stdout as string, config: () => readFileSync(join(home, "config", "cheapag", "config.json"), "utf8") };
}

test("--list prints the current models, the suggestions, and ends with the line about more models", async () => {
  const { stdout } = await run("--list");
  const lines = stdout.trim().split("\n");
  expect(lines.slice(0, 4)).toEqual(["Provider: OpenCode Go", "Main: deepseek-v4.1-flash (effort default)", "Fallback: qwen3.7-plus (effort default)", "Suggestions:"]);
  expect(lines.slice(4)).toEqual([
    "small-flash · $0.14/$0.28 per M · 128K ctx · efforts: none",
    "big-reasoner · $0.9/$2.7 per M · 256K ctx · efforts: high, max",
    "For more models, exit Claude/Codex and run: npx cheap-agent model",
  ]);
});

test("--main with a valid id and effort saves the user config", async () => {
  const { stdout, config } = await run("--main", "opencode-go/big-reasoner", "--effort", "max", "--fallback", "small-flash");
  expect(stdout).toMatch(/^✓ main opencode-go\/big-reasoner \(effort max\), fallback opencode-go\/small-flash \(effort default\) — saved in .*; the next job uses it\n$/);
  expect(JSON.parse(config()).models).toEqual({ implement: "opencode-go/big-reasoner", research: "opencode-go/big-reasoner", fallback: ["opencode-go/small-flash"], variants: { "opencode-go/big-reasoner": "max" } });
});

test("an unknown id, a chat-only model and a wrong effort are refused", async () => {
  expect((await run("--main", "nope")).stdout).toBe("✗ nope is not a tool-calling model on OpenCode Go; run npx cheap-agent model --list\n");
  expect((await run("--main", "chat-only")).stdout).toContain("chat-only is not a tool-calling model");
  expect((await run("--main", "small-flash", "--effort", "high")).stdout).toBe("✗ small-flash has no effort high; it has: none\n");
  expect((await run("--main", "big-reasoner", "--effort", "low")).stdout).toBe("✗ big-reasoner has no effort low; it has: high, max\n");
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
  onTestFinished(() => void exit.mockRestore());
  const { input } = drive("\x03");
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
  expect(input.setRawMode).toHaveBeenLastCalledWith(false);
});
