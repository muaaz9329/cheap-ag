import { PassThrough } from "node:stream";
import { expect, onTestFinished, test, vi } from "vitest";
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

type Option = { label: string; hint?: string };
const ABC: Option[] = [{ label: "a" }, { label: "b", hint: "hint" }, { label: "c" }];
const FIFTEEN: Option[] = Array.from({ length: 15 }, (_, i) => ({ label: `o${i + 1}` }));
const UP = "\x1b[A";
const DOWN = "\x1b[B";

/** A fake terminal: every write is recorded, and `press` sends keys and waits until `select` has handled them. */
function openTerminal(opts: { options: Option[]; initial?: number; columns?: number }) {
  const input = Object.assign(new PassThrough(), { setRawMode: vi.fn() }) as any;
  const written: string[] = [];
  const output = {
    columns: opts.columns ?? 80,
    write: (text: string) => (written.push(text), true),
  } as any;
  const picked = select("Pick:", opts.options, opts.initial, { input, output });
  const press = async (keys: string) => {
    input.write(keys);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { picked, press, written, input };
}

/** The screen for rows `from`..`to` (1-based) of FIFTEEN with one row selected. */
function fifteenScreen(from: number, to: number, selected: number) {
  const rows = FIFTEEN.slice(from - 1, to).map((option, i) => {
    const row = from + i;
    return `${row === selected ? "❯" : " "} ${row}) ${option.label}`;
  });
  return ["Pick:", ...rows].join("\n") + "\n";
}

test("select: everything written for ↓ then Enter, and the terminal handed back", async () => {
  const { picked, press, written, input } = openTerminal({ options: ABC });
  expect(written).toEqual(["\x1b[?25l", "Pick:\n❯ 1) a\n  2) b  hint\n  3) c\n"]);
  expect(input.isPaused()).toBe(false);
  await press(DOWN);
  expect(written.slice(2)).toEqual(["\x1b[4A\x1b[J", "Pick:\n  1) a\n❯ 2) b  hint\n  3) c\n"]);
  await press("\r");
  expect(written.slice(4)).toEqual(["\x1b[?25h", "\x1b[4A\x1b[JPick: b\n"]);
  expect(await picked).toBe(1);
  expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
  expect(input.isPaused()).toBe(true);
  expect(input.listenerCount("keypress")).toBe(0);
});

test("select: an initial row outside the list is pulled back to the nearest end", async () => {
  const low = openTerminal({ options: ABC, initial: -5 });
  expect(low.written[1]).toBe("Pick:\n❯ 1) a\n  2) b  hint\n  3) c\n");
  const high = openTerminal({ options: ABC, initial: 99 });
  expect(high.written[1]).toBe("Pick:\n  1) a\n  2) b  hint\n❯ 3) c\n");
  await low.press("\r");
  await high.press("\r");
  expect([await low.picked, await high.picked]).toEqual([0, 2]);
});

test("select: ↑ on the first row wraps to the last, ↓ on the last wraps to the first", async () => {
  const up = openTerminal({ options: ABC });
  await up.press(UP + "\r");
  expect(await up.picked).toBe(2);
  const down = openTerminal({ options: ABC, initial: 2 });
  await down.press(DOWN + "\r");
  expect(await down.picked).toBe(0);
});

test("select: a long list shows 12 rows that scroll to keep the selected row in view", async () => {
  expect(openTerminal({ options: FIFTEEN }).written[1]).toBe(fifteenScreen(1, 12, 1));
  expect(openTerminal({ options: FIFTEEN, initial: 14 }).written[1]).toBe(fifteenScreen(4, 15, 15));
  const middle = openTerminal({ options: FIFTEEN, initial: 7 });
  expect(middle.written[1]).toBe(fifteenScreen(2, 13, 8));
  await middle.press(DOWN);
  expect(middle.written.slice(2)).toEqual(["\x1b[13A\x1b[J", fifteenScreen(3, 14, 9)]);
});

test("select: a row is cut one short of the terminal width, 100 columns when unknown; the question is not cut", () => {
  const option = [{ label: "abcdefghij", hint: "hint" }];
  expect(openTerminal({ options: option, columns: 10 }).written[1]).toBe("Pick:\n❯ 1) abcd\n");
  expect(openTerminal({ options: option, columns: 3 }).written[1]).toBe("Pick:\n❯ \n");
  const long = [{ label: "x".repeat(150) }];
  expect(openTerminal({ options: long, columns: 0 }).written[1]).toBe(
    `Pick:\n❯ 1) ${"x".repeat(94)}\n`,
  );
});

test.each([
  ["two digits make one row number", FIFTEEN, "12", 11],
  ["the number of the last row picks it", FIFTEEN, "15", 14],
  ["a number past the end starts over from its last digit", FIFTEEN, "129", 8],
  ["a leading zero is kept, so 05 is row 5", FIFTEEN, "05", 4],
  ["0 is no row, so the pick stays", FIFTEEN, "0", 3],
  ["an arrow key forgets the digits typed before it", FIFTEEN, `1${DOWN}2`, 1],
  ["a digit past the end of a short list is ignored", ABC, "7", 2],
  ["and the next digit starts a new number", ABC, "72", 1],
])("select: typed numbers: %s", async (_name, options, keys, expected) => {
  const initial = options === FIFTEEN ? 3 : 2;
  const { picked, press } = openTerminal({ options, initial });
  await press(keys + "\r");
  expect(await picked).toBe(expected);
});

test("select: any other key redraws the same screen", async () => {
  const { press, written } = openTerminal({ options: ABC });
  await press("x");
  expect(written.slice(2)).toEqual(["\x1b[4A\x1b[J", written[1]]);
});

test("select: Ctrl-C shows the cursor before it exits (and redraws when exit is mocked, as here)", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  onTestFinished(() => {
    exit.mockRestore();
  });
  const { press, written, input } = openTerminal({ options: ABC });
  await press("\x03");
  expect(exit.mock.calls).toEqual([[130]]);
  expect(written.slice(2)).toEqual(["\x1b[?25h", "\x1b[4A\x1b[J", written[1]]);
  expect(input.listenerCount("keypress")).toBe(0);
});

test("select: an input without raw mode still works", async () => {
  const input = new PassThrough() as any;
  const output = { columns: 80, write: () => true } as any;
  const picked = select("Pick:", ABC, 0, { input, output });
  setImmediate(() => input.write(DOWN + "\r"));
  expect(await picked).toBe(1);
});

test("select: Enter on an empty list rejects and gives the terminal back", async () => {
  const { picked, press, written, input } = openTerminal({ options: [] });
  expect(written).toEqual(["\x1b[?25l", "Pick:\n"]);
  const rejected = expect(picked).rejects.toThrow(TypeError);
  await press("\r");
  await rejected;
  expect(written.slice(2)).toEqual(["\x1b[?25h", "\x1b[?25h"]);
  expect(input.setRawMode.mock.calls).toEqual([[true], [false], [false]]);
  expect(input.listenerCount("keypress")).toBe(0);
});

// Pins what happens today, not what the doc comment promises: only later draws give the terminal back.
test("select: an error on the first draw rejects and leaves the terminal taken", async () => {
  const input = Object.assign(new PassThrough(), { setRawMode: vi.fn() }) as any;
  const written: string[] = [];
  const output = {
    columns: 80,
    write(text: string) {
      if (written.length === 1) throw new Error("terminal gone");
      written.push(text);
      return true;
    },
  } as any;
  await expect(select("Pick:", ABC, 0, { input, output })).rejects.toThrow("terminal gone");
  expect(written).toEqual(["\x1b[?25l"]);
  expect(input.setRawMode.mock.calls).toEqual([[true]]);
  expect(input.listenerCount("keypress")).toBe(1);
});
