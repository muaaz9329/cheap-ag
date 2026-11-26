import type { Provider } from "./credentials.js";
import { type Route } from "./routing.js";
export declare const OPENCODE_PIN: string;
/**
 * The binary comes from opencode-ai's platform package, never PATH. We skip opencode-ai/bin because
 * its postinstall (which fills it in) does not run under pnpm or npm's install-scripts gate.
 * shortcut: takes the first installed variant, not the avx2/musl-aware pick postinstall makes; mirror it if x64 baseline users report crashes.
 */
export declare function opencodeBinary(): string;
export declare const FINISH_TOOL_SOURCE = "export default {\n  description: \"Report the step as done. Call exactly once, as your last action.\",\n  args: {\n    summary: { type: \"string\", maxLength: 160, description: \"What you did, at most 160 characters\" },\n    risks: { type: \"array\", items: { type: \"string\" }, description: \"Assumptions, unverified conditions, edits outside files:\" },\n    review: { type: \"array\", items: { type: \"string\" }, maxItems: 5, description: \"Ranges worth a human look, as path:start-end\" },\n    missing: { type: \"array\", items: { type: \"string\" }, description: \"Anything the step asked for that you did not do\" },\n    repro: { type: \"string\", description: \"The exact command that runs your reproduction test (fails on the original code, passes now); 'none: <why>' if you could not reproduce the problem; 'n/a' if the step is not a fix\" },\n    disagree: { type: \"string\", description: \"Where the step's spec and the Source you were given disagree (direction, order, value, approach), or 'none'\" },\n  },\n  async execute() {\n    return \"Reported. Stop now.\";\n  },\n};\n";
/**
 * Runs inside OpenCode (Bun), for every session: grep returns matching lines, and the read deny on .env* does not
 * cover it (proven on 1.19, even with an explicit include: ".env*"), so .env* match blocks are cut from grep output
 * before the model sees them. .env.example and .env.sample stay visible. Glob and list only return names.
 */
export declare const SECRETS_PLUGIN = "const SECRET = /(^|[\\\\/])\\.env(?!\\.(example|sample)$)[^\\\\/]*$/;\n\nexport const CheapagSecrets = async () => ({\n  \"tool.execute.after\": async (input, output) => {\n    if (input.tool !== \"grep\" || typeof output.output !== \"string\") return;\n    let file = \"\";\n    let hidden = 0;\n    const kept = [];\n    for (const line of output.output.split(\"\\n\")) {\n      const header = line.match(/^(\\S.*):$/);\n      if (header) file = header[1];\n      else if (line === \"\") file = \"\";\n      if (SECRET.test(file)) {\n        if (header) hidden++;\n        continue;\n      }\n      kept.push(line);\n    }\n    if (hidden) output.output = kept.join(\"\\n\") + \"\\n(\" + hidden + \" .env file(s) hidden by cheapag)\";\n  },\n});\n";
/** Cheap Agent's own OpenCode config dir: worker and research agents, finish tool, secrets plugin, model pins and options. */
export declare function writeConfigDir(dir: string, config: string): void;
/** The bundled OpenCode's session database file, in OpenCode's data dir. */
export declare const OPENCODE_DB = "cheapag-opencode.db";
export type Opencode = {
    url: string;
    password: string;
    version: string;
};
/** Marks the server in use for a job's or research call's lifetime, so a config change never reboots it under them. Returns the release. */
export declare function holdOpencode(): () => void;
/** The header every request to the OpenCode server carries: its password as HTTP basic auth. */
export declare const authHeaders: (password: string) => {
    authorization: string;
};
/** The running server, if one is up; never boots one. */
export declare function runningOpencode(): Promise<Opencode | undefined>;
export declare function ensureOpencode(provider: Provider, projectDir?: string, route?: Route): Promise<Opencode>;
/**
 * Stops the OpenCode server's whole process group. Seen on 1.19.0: a SIGTERM shortly after boot, while it is still
 * busy, can be ignored for good, so a SIGKILL follows if it is still there after a grace period. On process exit
 * (`exiting`) there is no later: it is killed outright (its SQLite WAL survives that).
 */
export declare function stopOpencode(exiting?: boolean): void;
