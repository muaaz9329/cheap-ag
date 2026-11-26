import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { select } from "../src/prompt.js";

test("select: an error while redrawing gives the terminal back and rejects", async () => {
  const input = Object.assign(new PassThrough(), { setRawMode: vi.fn(), isTTY: true }) as any;
  const written: string[] = [];
  let failNext = false;
  const output = {
    columns: 80,
    write(text: string) {
      if (failNext) {
        failNext = false;
        throw new Error("terminal gone");
      }
      written.push(text);
      return true;
    },
  } as any;
  const picked = select("Pick:", [{ label: "a" }, { label: "b" }], 0, { input, output });
  failNext = true; // the redraw after the next key fails
  input.write("\x1b[B");
  await expect(picked).rejects.toThrow("terminal gone");
  expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  expect(written.at(-1)).toBe("\x1b[?25h"); // cursor shown again
  expect(input.listenerCount("keypress")).toBe(0);
});
