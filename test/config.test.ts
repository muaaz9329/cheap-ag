import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { loadConfig, privateHost } from "../src/config.js";
import { hermeticHome, homeEnv, tempRepo } from "./harness.js";

/** Config validation for keys that only the user config may set. */

function setup(user: object, repoConfig?: object) {
  const h = hermeticHome({});
  const file = join(h.home, "config", "cheapag", "config.json");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(user));
  for (const [key, value] of Object.entries(homeEnv(h.home)))
    if (key.startsWith("XDG_")) vi.stubEnv(key, value);
  const repo = tempRepo();
  onTestFinished(() => {
    vi.unstubAllEnvs();
    repo.cleanup();
  });
  if (repoConfig) writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify(repoConfig));
  return { dir: repo.dir, file };
}

test("preset: a user config preset loads, an unknown one names the allowed values, a repo cannot set it", () => {
  expect(loadConfig(setup({ preset: "balanced" }).dir).preset).toBe("balanced");
  expect(() => loadConfig(setup({ preset: "fast" }).dir)).toThrow(
    "preset must be one of cheapest, balanced, strongest",
  );
  expect(() => loadConfig(setup({}, { preset: "balanced" }).dir)).toThrow(
    /preset can only be set in .*config\.json/,
  );
});

test("models.variants: a map of full model names to efforts loads; a non-string effort is refused", () => {
  const variants = { "opencode-go/deepseek-v4.1-flash": "high", "opencode-go/glm-5.3": "max" };
  expect(loadConfig(setup({ models: { variants } }).dir).models.variants).toEqual(variants);
  expect(() =>
    loadConfig(setup({ models: { variants: { "opencode-go/glm-5.3": 2 } } }).dir),
  ).toThrow(
    'models.variants must map provider/model names to an effort, e.g. {"opencode-go/deepseek-v4.1-flash": "high"}',
  );
});

test("on_blocked_command: ask is the default; deny stays; anything else is named", () => {
  expect(loadConfig(setup({}).dir).on_blocked_command).toBe("ask");
  expect(loadConfig(setup({ on_blocked_command: "deny" }).dir).on_blocked_command).toBe("deny");
  expect(() => loadConfig(setup({ on_blocked_command: "bogus" }).dir)).toThrow(
    "on_blocked_command must be one of ask, deny",
  );
});

test("takeover: ask is the default; sonnet and self stay; an unknown mode names all three", () => {
  expect(loadConfig(setup({}).dir).takeover).toBe("ask");
  expect(loadConfig(setup({ takeover: "sonnet" }).dir).takeover).toBe("sonnet");
  expect(loadConfig(setup({ takeover: "self" }).dir).takeover).toBe("self");
  expect(() => loadConfig(setup({ takeover: "bogus" }).dir)).toThrow(
    "takeover must be one of sonnet, self, ask",
  );
});

test("a config file that cannot be read or parsed fails naming the file and the cause", () => {
  const { dir } = setup({});
  writeFileSync(join(dir, "cheapag.json"), "{ not json");
  expect(() => loadConfig(dir)).toThrow(/cheapag\.json is not valid JSON: /);
  const unreadable = setup({}).dir;
  mkdirSync(join(unreadable, "cheapag.json")); // a folder where the file belongs
  expect(() => loadConfig(unreadable)).toThrow(/^cannot read .*cheapag\.json: /);
});

test("allow_commands, escalation_skip_at and guard_lines: valid values load, anything else is named", () => {
  expect(
    loadConfig(
      setup({ allow_commands: [" make test "], escalation_skip_at: 1, guard_lines: 5 }).dir,
    ),
  ).toMatchObject({ allow_commands: ["make test"], escalation_skip_at: 1, guard_lines: 5 });
  for (const bad of ["make", [""], [1]])
    expect(() => loadConfig(setup({ allow_commands: bad }).dir)).toThrow(
      "allow_commands must be a list of commands",
    );
  for (const bad of [0, 1.5, "0.5"])
    expect(() => loadConfig(setup({ escalation_skip_at: bad }).dir)).toThrow(
      "escalation_skip_at must be a number above 0 and at most 1",
    );
  for (const bad of [0, 2.5, "3"])
    expect(() => loadConfig(setup({ guard_lines: bad }).dir)).toThrow(
      "guard_lines must be a positive whole number",
    );
});

test("privateHost is false for something that is not a URL", () => {
  expect(privateHost("not a url")).toBe(false);
  expect(privateHost("")).toBe(false);
});
