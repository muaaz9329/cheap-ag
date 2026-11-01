import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { allowRepo, callText, homeEnv, startServer as startHost, tempRepo } from "./harness.js";
import { startFakeOpencode } from "./fake-opencode.js";

const serverEntry = join(import.meta.dirname, "..", "dist", "codex.js");
const startServer = (opts: Parameters<typeof startHost>[0] = {}) => startHost({ ...opts, entry: serverEntry });

test("Codex consent and cleanup leave Claude project state and Git excludes untouched", async () => {
  const repo = tempRepo();
  const claude = join(repo.dir, ".cheapag");
  mkdirSync(claude, { recursive: true });
  const original = JSON.stringify({ provider: "deepseek", mode: "all", approvedAt: new Date().toISOString() });
  writeFileSync(join(claude, "consent.json"), original);
  writeFileSync(join(claude, "marker.txt"), "claude state");
  const excludes = join(repo.dir, ".git", "info", "exclude");
  const before = readFileSync(excludes, "utf8");
  writeFileSync(join(repo.dir, "cheapag.json"), "not valid JSON");
  const server = await startServer({ cwd: repo.dir, logins: { deepseek: "fake" } });
  try {
    const blocked = await callText(server.client, "research", { question: "What is this?" });
    expect(blocked).toContain("CONSENT");
    expect(blocked).toContain("cheapcode allow");
    expect(existsSync(join(repo.dir, ".cheapcode", "consent.json"))).toBe(false);
    allowRepo(repo.dir, homeEnv(server.home), [], serverEntry);
    expect(existsSync(join(repo.dir, ".cheapcode", "consent.json"))).toBe(true);
    expect(repo.git("status", "--porcelain", "--untracked-files=all")).not.toContain(".cheapcode");
    execFileSync(process.execPath, [serverEntry, "clean", "--all"], { cwd: repo.dir, env: homeEnv(server.home) });
    expect(readFileSync(join(claude, "consent.json"), "utf8")).toBe(original);
    expect(readFileSync(join(claude, "marker.txt"), "utf8")).toBe("claude state");
    expect(readFileSync(excludes, "utf8")).toBe(before);
  } finally { await server.close(); repo.cleanup(); }
});

test("Codex ignores a Claude XDG credential store inherited from the environment", async () => {
  const repo = tempRepo();
  const bait = join(repo.dir, "claude-data");
  mkdirSync(join(bait, "opencode"), { recursive: true });
  writeFileSync(join(bait, "opencode", "auth.json"), JSON.stringify({ deepseek: { type: "api", key: "fake" } }));
  const server = await startServer({ cwd: repo.dir, env: { XDG_DATA_HOME: bait } });
  try { expect(await callText(server.client, "ping")).toContain("no worker provider"); }
  finally { await server.close(); repo.cleanup(); }
});
// Exercise the full MCP → worker → checks → landing path without paid provider requests.
test("Codex exposes host-appropriate instructions and lands a simulated worker edit in its own state", async () => {
  const repo = tempRepo();
  repo.git("config", "core.autocrlf", "false");
  const fake = await startFakeOpencode();
  mkdirSync(join(repo.dir, ".cheapag"));
  writeFileSync(join(repo.dir, ".cheapag", "private"), "Claude private data");
  writeFileSync(join(repo.dir, "cheapcode.json"), JSON.stringify({ models: { implement: "deepseek/codex-custom" } }));
  fake.script({ edit: "src/codex.ts", content: "export const codex = 1;\n" }, { usage: { cost: 0.001 } }, { finish: { summary: "added export; cheapag.json and .cheapag/ remain unchanged", risks: [], review: [], missing: [] } });
  const server = await startServer({ cwd: repo.dir, logins: { deepseek: "fake" }, allow: [], env: { CHEAPCODE_OPENCODE_URL: fake.url, CHEAPAG_OPENCODE_URL: "http://127.0.0.1:1" } });
  try {
    expect(server.client.getServerVersion()?.name).toBe("cheapcode");
    const instructions = server.client.getInstructions()!;
    expect(instructions).toContain("Review");
    expect(instructions).toContain("Never grant repository consent");
    expect(instructions).not.toContain("model: sonnet");
    const tools = (await server.client.listTools()).tools;
    expect(tools.find(t => t.name === "delegate")?.description).not.toContain("instead of re-checking");
    expect(tools.find(t => t.name === "delegate")?._meta?.["anthropic/alwaysLoad"]).toBeUndefined();
    const result = await callText(server.client, "delegate", { task: "Add src/codex.ts exporting codex = 1", files: "src/codex.ts" });
    expect(result).toMatch(/^OK j/);
    expect(result).toContain(".cheapcode/jobs/");
    expect(result).toContain("cheapag.json and .cheapag/ remain unchanged");
    expect(fake.recorded.sessions[0].model).toEqual({ providerID: "deepseek", id: "codex-custom" });
    expect(readFileSync(join(repo.dir, "src", "codex.ts"), "utf8")).toBe("export const codex = 1;\n");
    expect(readFileSync(join(repo.dir, ".cheapag", "private"), "utf8")).toBe("Claude private data");
    expect(existsSync(join(repo.dir, ".cheapag", "jobs"))).toBe(false);
    expect(existsSync(join(server.home, "state", "cheapcode", "spend.jsonl"))).toBe(true);
    expect(existsSync(join(server.home, "state", "cheapag"))).toBe(false);
    const claudeConfig = join(server.home, "claude");
    const transcriptDir = join(claudeConfig, "projects", repo.dir.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(transcriptDir, "session.jsonl"), JSON.stringify({ message: { id: "test", usage: { input_tokens: 1234 } } }));
    const status = execFileSync(process.execPath, [serverEntry, "status"], { cwd: repo.dir, env: { ...homeEnv(server.home), CLAUDE_CONFIG_DIR: claudeConfig } }).toString();
    expect(status).toContain("cheapcode");
    expect(status).not.toContain("/cheapag:");
    expect(status).not.toContain("claude prefix:");
  } finally { await server.close(); await fake.close(); repo.cleanup(); }
});

test("Codex resets inherited worker paths and overrides before loading configuration", () => {
  const repo = tempRepo();
  try {
    const script = `
      const runtime = await import('./dist/runtime.js');
      runtime.configureCodex();
      const { userConfigFile } = await import('./dist/config.js');
      const { ledgerFile } = await import('./dist/routing.js');
      console.log(JSON.stringify({
        config: userConfigFile(), ledger: ledgerFile(),
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(XDG_|OPENCODE_|CHEAPAG_|TMPDIR$|TEMP$|TMP$)/i.test(key)))
      }));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...homeEnv(repo.dir), opencode_config: "claude.json", OPENCODE_CONFIG_DIR: "claude-config", OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_SERVER_PASSWORD: "fixture", cheapag_opencode_url: "http://127.0.0.1:1" },
    }).toString());
    expect(result.config).toBe(join(repo.dir, "config", "cheapcode", "config.json"));
    expect(result.ledger).toBe(join(repo.dir, "state", "cheapcode", "spend.jsonl"));
    for (const [key, dir] of Object.entries({ XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", TMPDIR: "tmp", TEMP: "tmp", TMP: "tmp" })) expect(result.env[key]).toBe(join(repo.dir, dir));
    expect(Object.fromEntries(Object.entries(result.env).filter(([key]) => /^(OPENCODE_|CHEAPAG_)/i.test(key)))).toEqual({
      OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    });
  } finally { repo.cleanup(); }
});

test("Codex starts the bundled worker engine in its private home without a paid model call", async () => {
  const repo = tempRepo();
  const server = await startServer({ cwd: repo.dir, logins: { deepseek: "fake" } });
  try {
    expect(await callText(server.client, "ping")).toMatch(/^OK cheapcode .* opencode=.* provider=deepseek/);
    expect(existsSync(join(repo.dir, ".cheapcode", "opencode", "opencode.json"))).toBe(true);
    expect(existsSync(join(repo.dir, ".cheapag"))).toBe(false);
    const help = spawnSync(process.execPath, [serverEntry, "login", "--help"], { cwd: repo.dir, env: homeEnv(server.home), timeout: 30_000, encoding: "utf8" });
    expect(help.error).toBeUndefined();
    expect(help.status).toBe(0);
    expect(help.stdout + help.stderr).toContain("--provider");
  } finally { await server.close(); repo.cleanup(); }
});

test("Codex rejects relative homes and Claude-only commands", () => {
  const repo = tempRepo();
  try {
    expect(() => execFileSync(process.execPath, [serverEntry, "status"], { cwd: repo.dir, env: { ...homeEnv(repo.dir), CHEAPCODE_HOME: "relative" }, stdio: "pipe" })).toThrow(/absolute path/);
    expect(() => execFileSync(process.execPath, [serverEntry, "hook"], { cwd: repo.dir, env: homeEnv(repo.dir), stdio: "pipe" })).toThrow(/usage: cheapcode/);
  } finally { repo.cleanup(); }
});
