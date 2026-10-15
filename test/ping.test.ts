import { afterAll, beforeAll, expect, test } from "vitest";
import { createRequire } from "node:module";
import { callText, startServer } from "./harness.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer();
});
afterAll(() => server.close());

test("server identifies itself as cheapag", () => {
  expect(server.client.getServerVersion()).toMatchObject({ name: "cheapag", version });
});

test("ping returns a one-line status block beginning OK with the server version", async () => {
  const text = await callText(server.client, "ping");
  expect(text).toBe(`OK cheapag ${version}`);
  expect(text.split("\n")).toHaveLength(1);
});

test("every tool honours the MCP contract: name <= 64 chars, flat object input schema", async () => {
  const { tools } = await server.client.listTools();
  expect(tools.map((t) => t.name)).toContain("ping");
  for (const tool of tools) {
    expect(tool.name.length).toBeLessThanOrEqual(64);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema).not.toHaveProperty("anyOf");
    expect(tool.inputSchema).not.toHaveProperty("oneOf");
    expect(tool.inputSchema).not.toHaveProperty("allOf");
    for (const prop of Object.values(tool.inputSchema.properties ?? {}) as { type?: string }[]) {
      expect(["object", "array"]).not.toContain(prop.type);
    }
  }
});
