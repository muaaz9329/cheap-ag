import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/** The Claude Code plugin's files (spec: Packaging): valid, pinned to this package's version, with the expected skills. */
const repo = join(import.meta.dirname, "..");
const plugin = join(repo, "plugin");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const { version } = json(join(repo, "package.json"));

/** A skill's frontmatter as key → raw value, and its body. */
function skill(name: string) {
  const text = readFileSync(join(plugin, "skills", name, "SKILL.md"), "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  expect(m, `${name}: frontmatter`).toBeTruthy();
  const front = Object.fromEntries(m![1].split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  return { front, body: m![2] };
}

test("marketplace lists the plugin from this repo, and the manifests agree on name and version", () => {
  const market = json(join(repo, ".claude-plugin", "marketplace.json"));
  expect(market).toMatchObject({ name: "cheap-agent", owner: { name: expect.any(String) } });
  expect(market.plugins).toEqual([expect.objectContaining({ name: "cheapag", source: "./plugin" })]);
  expect(json(join(plugin, ".claude-plugin", "plugin.json"))).toMatchObject({ name: "cheapag", version });
});

test("the MCP entry and every command run exactly this package version, so the pin cannot drift", () => {
  expect(json(join(plugin, ".mcp.json"))).toEqual({ mcpServers: { cheapag: { command: "npx", args: ["-y", `cheap-agent@${version}`] } } });
  const files = readdirSync(plugin, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
  const pins = files.flatMap((f) => readFileSync(join(f.parentPath, f.name), "utf8").match(/cheap-agent@[^\s`"')]+/g) ?? []);
  expect(pins.length).toBeGreaterThan(3);
  expect(new Set(pins)).toEqual(new Set([`cheap-agent@${version}`]));
});

test("skills: plan-writing for Claude; status, and user-only allow and clean wrapping the CLI", () => {
  expect(readdirSync(join(plugin, "skills")).sort()).toEqual(["allow", "clean", "plan-writing", "status"]);
  const plan = skill("plan-writing");
  expect(plan.front["disable-model-invocation"]).toBeUndefined(); // Claude loads it when planning
  expect(plan.front.description).toMatch(/plan/i);
  for (const rule of ["files:", "done-when:", "dont:", "needs:", "deps:", "## 1 ", "Size", "Grouping", "Fixing", "Packages"]) expect(plan.body).toContain(rule);

  const pin = `npx -y cheap-agent@${version}`;
  const status = skill("status");
  expect(status.front["disable-model-invocation"]).toBeUndefined();
  expect(status.body).toContain(`!\`${pin} status\``);
  expect(status.front["allowed-tools"]).toBe(`Bash(${pin} status)`);
  // Claude must never approve consent or delete worktrees itself: only the developer can invoke these
  for (const [name, cmd] of [["allow", "allow"], ["clean", "clean"]]) {
    const s = skill(name);
    expect(s.front["disable-model-invocation"]).toBe("true");
    expect(s.body).toContain(`!\`${pin} ${cmd} $ARGUMENTS\``);
    expect(s.front["allowed-tools"]).toBe(`Bash(${pin} ${cmd}) Bash(${pin} ${cmd} *)`);
    expect(s.front["argument-hint"]).toBeTruthy();
  }
});
