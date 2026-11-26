import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  ensureOpencode,
  opencodeBinary,
  OPENCODE_PIN,
  runningOpencode,
  stopOpencode,
} from "../src/opencode.js";
import { isAlive } from "../src/platform.js";
import { slow } from "./harness.js";

/** What stands in for `opencode serve`: a Node script run in its place, and the CPU architecture reported. */
const stand = vi.hoisted(() => ({
  script: "",
  arch: undefined as string | undefined,
  pids: [] as number[],
}));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, args: string[], options: object) => {
      if (args?.[0] !== "serve") return actual.spawn(command, args, options);
      const child = actual.spawn(process.execPath, ["-e", stand.script], options);
      stand.pids.push(child.pid!);
      return child;
    }) as typeof actual.spawn,
  };
});
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, arch: () => stand.arch ?? actual.arch() };
});

const GO = { provider: "opencode-go", via: "login" } as const;

function projectDir() {
  const dir = mkdtempSync(join(tmpdir(), "cheapag-boot-"));
  vi.stubEnv("CHEAPAG_OPENCODE_URL", "");
  onTestFinished(() => {
    stopOpencode(true);
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A health endpoint answering as the pinned OpenCode would. */
async function health() {
  const server = createServer((_req, res) =>
    res.end(JSON.stringify({ healthy: true, version: OPENCODE_PIN })),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => void server.close());
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("opencode serve exiting before it listens fails the boot with its exit code and output; nothing counts as running", async () => {
  const dir = projectDir();
  stand.script = 'console.error("boom: bad flag"); process.exit(3)';
  const boot = ensureOpencode(GO, dir);
  const running = runningOpencode(); // asked while the boot is still in flight
  await expect(boot).rejects.toThrow("opencode serve exited (3): boom: bad flag");
  expect(await running).toBeUndefined();
  expect(await runningOpencode()).toBeUndefined();
});

test.skipIf(process.platform === "win32")(
  "stopOpencode ends the server's process group, and kills one that ignores the request after a grace period",
  async () => {
    const dir = projectDir();
    const url = await health();
    stand.script = `console.log("opencode server listening on ${url}"); setInterval(() => {}, 1000)`;
    expect(await ensureOpencode(GO, dir)).toMatchObject({ url, version: OPENCODE_PIN });
    expect((await runningOpencode())?.url).toBe(url);
    const polite = stand.pids.at(-1)!;
    stopOpencode();
    expect(await runningOpencode()).toBeUndefined();
    await vi.waitFor(() => expect(isAlive(polite)).toBe(false), slow(5_000));

    stand.script = `process.on("SIGTERM", () => {}); console.log("opencode server listening on ${url}"); setInterval(() => {}, 1000)`;
    await ensureOpencode(GO, dir);
    const stubborn = stand.pids.at(-1)!;
    stopOpencode();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(isAlive(stubborn)).toBe(true); // still within the grace period
    await vi.waitFor(() => expect(isAlive(stubborn)).toBe(false), {
      timeout: slow(6_000),
      interval: 100,
    });
  },
  slow(20_000),
);

test("with no OpenCode binary for this platform the error names it and says to reinstall", () => {
  expect(opencodeBinary()).toMatch(/opencode(\.exe)?$/);
  stand.arch = "nope";
  onTestFinished(() => void (stand.arch = undefined));
  expect(() => opencodeBinary()).toThrow(
    /^no OpenCode binary installed for opencode-\w+-nope; reinstall cheap-agent$/,
  );
});
