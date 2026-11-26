import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The worker's permission ruleset (spec E1, A12). Verified against OpenCode 1.19.0 with a scripted model:
 * - rules passed to `session.create` are enforced, the last matching rule winning; an agent file's `permission:`
 *   frontmatter is NOT applied, so the ruleset goes on every worker session;
 * - `OPENCODE_PERMISSION` (the server-wide baseline) applies too, but a session rule overrides it, so the session
 *   ruleset itself ends with the hard denylist;
 * - edit patterns are worktree-relative and cannot deny an absolute path outside it, so `external_directory` stays
 *   denied: linked dependency dirs are read through their in-worktree symlink, and edits under them are denied.
 * - OpenCode splits `;`, `|`, `&&`, `$(…)` and backticks into separate checked commands, but not redirection, so
 *   `>` is denied outright except the known stderr forms on already-allowed commands (below).
 *
 * This is a guardrail against commands the model types, not a sandbox: the worker can edit source and run allowed
 * test commands, so code it writes can still run anything the developer's user can (see STATUS carry-forward).
 */

export type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" };

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];

/**
 * Programs whose "always allow" prefix could write files or run arbitrary code: `sed -i`, awk/perl/python `system`,
 * `find -exec`, and the rest would get past the edit rules that protect .env, lockfiles and cheapag.json. They may
 * still be allowed once, never always.
 */
export const WRITE_OR_RUN = new Set([
  "sed",
  "awk",
  "perl",
  "python",
  "python3",
  "node",
  "ruby",
  "bash",
  "sh",
  "zsh",
  "find",
  "xargs",
  "env",
  "tee",
  "dd",
  "cp",
  "mv",
  "rm",
  "ln",
  "chmod",
  "git",
  "npx",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "make",
]);

/** Whether "always allow" may be offered for a command's prefix. */
export const canAlwaysAllow = (prefix: string) =>
  !WRITE_OR_RUN.has(prefix.trim().split(/\s+/)[0] ?? "");

/** Commands no project script or config may allow: always the last rules, so they always win. */
export const HARD_DENY = [
  ...PACKAGE_MANAGERS.flatMap((manager) => [
    `${manager} install*`,
    `${manager} i`,
    `${manager} i *`,
    `${manager} add*`,
    `${manager} ci*`,
  ]),
  "pip install*",
  "pip3 install*",
  "python -m pip install*",
  "python3 -m pip install*",
  "uv add*",
  "uv pip install*",
  "go get*",
  "go install*",
  "cargo add*",
  "cargo install*",
  "brew *",
  ...["commit", "push", "reset", "checkout", "switch", "rebase", "merge", "stash", "clean"].map(
    (verb) => `git ${verb}*`,
  ),
  "rm -rf*",
  "rm -fr*",
  "sudo*",
  "curl*",
  "wget*",
  "ssh*",
  "scp*",
  "npm publish*",
  "chmod -R*",
  // seen bypassing allowed prefixes against the real OpenCode: writes past the edit rules, or arbitrary programs
  "*>*",
  "git *--output*",
  "git *--ext-diff*",
  "go test*-exec*",
  "go test*-toolexec*",
  "cargo test*--config*",
  "npm exec*",
  "pnpm dlx*",
  "yarn dlx*",
  "bunx*",
  // find can execute or delete, and its output flags write files
  "find*-exec*",
  "find*-ok*",
  "find*-delete*",
  "find*-fprint*",
  "find*-fls*",
  // sed in place is a file write the edit rules never see; ordinary reads (`sed -n 1,3p README.md`) have no -i
  "sed *-i*",
  // bash segments naming a .env file (the read tool's deny does not cover bash) and rg flags that read gitignored files
  "* .env*",
  "*/.env*",
  "rg*--no-ignore*",
  "rg* -u*",
  // never asked about: a shell as a command or a pipe target, command substitution, installs written with extra spaces, rm flag spellings
  ...["sh", "bash", "zsh"].flatMap((shell) => [
    shell,
    `${shell} *`,
    ...["", " ", "  "].flatMap((gap) => [`*|${gap}${shell}`, `*|${gap}${shell} *`]),
  ]),
  "*$(*",
  "*`*",
  "rm -Rf*",
  "rm -fR*",
  "rm -r -f*",
  "rm -f -r*",
  ...PACKAGE_MANAGERS.flatMap((manager) => [
    `${manager} -*install*`,
    `${manager} -*add*`,
    `${manager} in`,
    `${manager} in *`,
    `${manager} isntall*`,
  ]),
  ...PACKAGE_MANAGERS.flatMap((manager) =>
    ["  ", "   "].flatMap((gap) =>
      ["install", "add", "ci", "i"].flatMap((verb) => [
        `${manager}${gap}${verb}`,
        `${manager}${gap}${verb} *`,
      ]),
    ),
  ),
];

const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
];

/** Paths the worker may never edit: git internals, Cheap Agent state, env files, lockfiles. */
export const PROTECTED = [
  ".git",
  ".git/**",
  "**/.git",
  "**/.git/**",
  ".cheapag/**",
  ".env*",
  "**/.env*",
  // the worker must not loosen its own (or a later job's) rules
  "cheapag.json",
  ...LOCKFILES.flatMap((lockfile) => [lockfile, `**/${lockfile}`]),
];

/** Always-allowed commands, each as typed and with arguments: read-only basics, git, and the common test runners. */
const ALWAYS = [
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "echo",
  "find",
  "node --version",
  "node -v",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git -C * diff",
  "git -C * status",
  "git -C * log",
  "git -C * show",
  "git --no-pager diff",
  "git --no-pager status",
  "git --no-pager log",
  "git --no-pager show",
  "rg",
  "npx eslint",
  "npx tsc",
  "npx prettier",
  "pytest",
  "python -m pytest",
  "python3 -m pytest",
  "go test",
  "cargo test",
  "bun test",
];

/** Commands allowed only in these exact forms (`git branch` otherwise creates or deletes branches). */
const EXACT_ALWAYS = ["git branch", "git branch --show-current"];

const allow = (permission: string, pattern = "*"): Rule => ({
  permission,
  pattern,
  action: "allow",
});
const deny = (permission: string, pattern = "*"): Rule => ({ permission, pattern, action: "deny" });
const ask = (permission: string, pattern = "*"): Rule => ({ permission, pattern, action: "ask" });
/** A command allowed as typed, and with any arguments after it. */
const command = (prefix: string) => [allow("bash", prefix), allow("bash", `${prefix} *`)];
/** Stderr suppression on commands already allowed: never a bare `<anything> 2>/dev/null`. */
const stderr = (prefix: string, withArguments: boolean) =>
  ["2>/dev/null", "2>&1"].flatMap((redirect) => [
    allow("bash", `${prefix} ${redirect}`),
    ...(withArguments ? [allow("bash", `${prefix} * ${redirect}`)] : []),
  ]);

/** Secrets: OpenCode's default does not cover .env reads under these rulesets; examples stay readable (last match wins). */
const ENV_READS = [
  ...[".env*", "**/.env*"].map((path) => deny("read", path)),
  ...[".env.example", "**/.env.example", ".env.sample", "**/.env.sample"].map((path) =>
    allow("read", path),
  ),
];

/**
 * The bash rules both rulesets end with, after their own catch-all bash rule: the allowed commands, the redirect rules
 * (`>` denied except stderr suppression on an allowed command), then the hard denylist, which always wins.
 */
function bashRules(options: {
  scripts?: string[];
  exact?: string[];
  allowCommands?: string[];
}): Rule[] {
  const commands = [...ALWAYS, ...(options.scripts ?? []), ...(options.allowCommands ?? [])];
  const exact = [...EXACT_ALWAYS, ...(options.exact ?? [])];
  return [
    ...commands.flatMap(command),
    ...exact.map((exactCommand) => allow("bash", exactCommand)),
    deny("bash", "*>*"),
    ...commands.flatMap((prefix) => stderr(prefix, true)),
    ...exact.flatMap((exactCommand) => stderr(exactCommand, false)),
    deny("bash", "*>*>*"),
    // `*>*` already sits before the stderr allows: repeating it last would deny them again
    ...HARD_DENY.filter((pattern) => pattern !== "*>*").map((pattern) => deny("bash", pattern)),
  ];
}

/**
 * The full ruleset for one worker session: catch-all deny first, then explicit allows and denies for every key,
 * then the hard denylist. `scripts` and `allowCommands` are allowed with any arguments; `exact` only as written
 * (make targets, the step's done-when checks); `linked` are dependency dirs in the worktree (readable, never editable).
 */
export function workerRuleset(
  opts: {
    scripts?: string[];
    exact?: string[];
    allowCommands?: string[];
    linked?: string[];
    onBlockedCommand?: "ask" | "deny";
  } = {},
): Rule[] {
  return [
    deny("*"),
    // `finish` is Cheap Agent's own tool (tools/finish.ts): custom tools are permission-checked by name, so the
    // catch-all would otherwise hide it from the worker
    ...["read", "glob", "grep", "list", "lsp", "todowrite", "question", "finish"].map(
      (permission) => allow(permission),
    ),
    ...ENV_READS,
    ...["external_directory", "webfetch", "websearch", "task", "skill", "doom_loop"].map(
      (permission) => deny(permission),
    ),
    allow("edit"),
    ...PROTECTED.map((path) => deny("edit", path)),
    ...(opts.linked ?? []).flatMap((directory) => [
      deny("edit", directory),
      deny("edit", `${directory}/**`),
    ]),
    opts.onBlockedCommand === "ask" ? ask("bash") : deny("bash"),
    ...bashRules(opts),
  ];
}

/**
 * The research worker's ruleset (spec E1, research; ticket 23.4): read, search, and run the same test commands as the
 * implementation worker (to reproduce a failure it is asked about), never edit. It runs in a throwaway worktree (src/research.ts),
 * so a command that writes files cannot touch the developer's tree. Env files are unreadable; outside the repo is denied.
 */
export function researchRuleset(
  opts: { scripts?: string[]; exact?: string[]; allowCommands?: string[] } = {},
): Rule[] {
  return [
    deny("*"),
    ...["read", "glob", "grep", "list"].map((permission) => allow(permission)),
    ...ENV_READS,
    ...[
      "edit",
      "question",
      "lsp",
      "todowrite",
      "finish",
      "external_directory",
      "webfetch",
      "websearch",
      "task",
      "skill",
      "doom_loop",
    ].map((permission) => deny(permission)),
    deny("bash"),
    ...bashRules(opts),
  ];
}

/** The same static rules in OpenCode's config form, for the server-wide `OPENCODE_PERMISSION` baseline. */
export function baselinePermission() {
  const config: Record<string, string | Record<string, string>> = {};
  // the server-wide baseline never pauses: a session that can be asked carries its own ruleset with `ask`
  for (const rule of workerRuleset({ onBlockedCommand: "deny" })) {
    if (rule.pattern === "*" && !(rule.permission in config)) {
      config[rule.permission] = rule.action;
      continue;
    }
    const current = config[rule.permission];
    const patterns = typeof current === "string" ? { "*": current } : current;
    config[rule.permission] = { ...patterns, [rule.pattern]: rule.action };
  }
  return config;
}

/**
 * The project's own runnable scripts: package.json scripts under each package manager (`scripts`, arguments allowed)
 * and make targets (`exact`: `make -f`/`--eval` would run anything). Names with spaces or wildcards are skipped.
 */
export function projectScripts(dir: string): { scripts: string[]; exact: string[] } {
  return { scripts: [...new Set(packageScripts(dir))], exact: [...new Set(makeTargets(dir))] };
}

/** A script or target name with no spaces or wildcards. */
function isPlainName(name: string) {
  return /^[\w:@./-]+$/.test(name);
}

/** The `scripts` object of package.json, or none when the file is missing, unreadable or not JSON. */
function readPackageScripts(directory: string): Record<string, string> {
  const path = join(directory, "package.json");
  if (!existsSync(path)) return {};
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return manifest.scripts ?? {};
  } catch {
    // an unreadable package.json contributes no scripts
    return {};
  }
}

/** Each package.json script under every package manager, plus the short forms of `test`. */
function packageScripts(directory: string): string[] {
  const names = Object.keys(readPackageScripts(directory)).filter(isPlainName);
  const commands = names.flatMap((name) => [
    ...PACKAGE_MANAGERS.map((manager) => `${manager} run ${name}`),
    `yarn ${name}`,
  ]);
  if (names.includes("test"))
    commands.push("npm test", "npm t", "pnpm test", "yarn test", "bun run test");
  return commands;
}

/** `make <target>` for each target, then bare `make`, for every makefile present. */
function makeTargets(directory: string): string[] {
  const commands: string[] = [];
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    const targets = readFileSync(path, "utf8").matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm);
    for (const [, target] of targets) if (isPlainName(target)) commands.push(`make ${target}`);
    commands.push("make");
  }
  return commands;
}

/** The program a command names, plus a bare second word (`git branch`, `npm run`), for an "always allow" prefix. */
export function commandPrefix(command: string): string {
  const [first, second] = command.trim().split(/\s+/);
  if (first && second && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(second)) return `${first} ${second}`;
  return first ?? command.trim();
}

function globToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}
const HARD_DENY_MATCHERS = HARD_DENY.map(globToRegExp);
/** The command segments OpenCode checks separately, plus the whole line. */
const commandSegments = (command: string) => [
  command,
  ...command.split(/&&|\|\||;|\||\n|\$\(|`/).map((part) => part.trim().replace(/\)+$/, "")),
];

/** Whether any part of a command is on `HARD_DENY`: those are refused, never put to the user. */
export function isHardDenied(command: string): boolean {
  return commandSegments(command).some(
    (part) => part && HARD_DENY_MATCHERS.some((matcher) => matcher.test(part)),
  );
}

/** What a worker sees when a permission request is auto-rejected (spec E1). */
export const rejectionMessage = (what: string) =>
  `Not allowed in cheapag: \`${what}\`. If you need a dependency, use the question tool. Otherwise finish and list it in risks.`;
