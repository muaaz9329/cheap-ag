import { emitKeypressEvents } from "node:readline";

type Option = { label: string; hint?: string };
type In = NodeJS.ReadStream & { setRawMode?: (on: boolean) => unknown };
type Key = { name?: string; ctrl?: boolean };
/** The selected row, and the digits typed so far to jump to a row by its number. */
type Selection = { index: number; typedNumber: string };

const MAX_VISIBLE_ROWS = 12;
const DEFAULT_COLUMNS = 100;
// what a shell reports for a program stopped by Ctrl-C: 128 + SIGINT (2)
const EXIT_CODE_INTERRUPTED = 130;
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** Moves the cursor up to the first drawn line and clears from there down. */
function eraseLinesAbove(lineCount: number) {
  return `\x1b[${lineCount}A\x1b[J`;
}

/** Keeps `value` between `low` and `high`. `high` wins when it is below `low` (an empty list). */
function clamp(value: number, low: number, high: number) {
  return Math.min(Math.max(value, low), high);
}

/** One list row: a marker on the selected row, the row number from 1, the label and its hint. */
function formatRow(option: Option, rowIndex: number, selectedIndex: number) {
  const marker = rowIndex === selectedIndex ? "❯" : " ";
  const hint = option.hint ? `  ${option.hint}` : "";
  return `${marker} ${rowIndex + 1}) ${option.label}${hint}`;
}

/** The `rowCount` rows to draw, scrolled to keep the selected row near the middle. */
function visibleRows(options: Option[], selectedIndex: number, rowCount: number) {
  const centred = selectedIndex - Math.floor(rowCount / 2);
  const first = clamp(centred, 0, options.length - rowCount);
  return options
    .slice(first, first + rowCount)
    .map((option, offset) => formatRow(option, first + offset, selectedIndex));
}

/** One row up or down, wrapping around at both ends. An arrow key forgets the typed digits. */
function moveSelection(selection: Selection, direction: "up" | "down", optionCount: number) {
  const step = direction === "up" ? -1 : 1;
  return { index: (selection.index + step + optionCount) % optionCount, typedNumber: "" };
}

/** Adds a digit to the typed number and selects that row, if the list has a row of that number. */
function typeDigit(selection: Selection, digit: string, optionCount: number) {
  const longer = selection.typedNumber + digit;
  // a number past the end of the list starts over from the digit just typed
  const typedNumber = Number(longer) > optionCount ? digit : longer;
  const row = Number(typedNumber);
  const isListed = row >= 1 && row <= optionCount;
  return { index: isListed ? row - 1 : selection.index, typedNumber };
}

/**
 * An arrow-key list on a terminal: ↑/↓ move, Enter picks, typing a number jumps to that row, Ctrl-C exits 130.
 * Redraws in place and always gives the terminal back (raw mode off, cursor shown) on Enter, Ctrl-C and errors.
 * `io` is for tests, which drive it with a fake stdin.
 */
export function select(
  question: string,
  options: Option[],
  initial = 0,
  io: { input?: In; output?: NodeJS.WriteStream } = {},
): Promise<number> {
  const input = io.input ?? (process.stdin as In);
  const output = io.output ?? process.stdout;
  return new Promise((resolve, reject) => {
    let selection: Selection = { index: clamp(initial, 0, options.length - 1), typedNumber: "" };
    let drawnLineCount = 0;
    // counted once, so the drawing keeps its height while the prompt is open
    const visibleRowCount = Math.min(options.length, MAX_VISIBLE_ROWS);

    function fitToWidth(row: string) {
      // one short of the width: a row filling the last column can wrap, and the redraw counts lines
      return row.slice(0, (output.columns || DEFAULT_COLUMNS) - 1);
    }

    function draw() {
      const rows = visibleRows(options, selection.index, visibleRowCount).map(fitToWidth);
      if (drawnLineCount) output.write(eraseLinesAbove(drawnLineCount));
      output.write([question, ...rows].join("\n") + "\n");
      drawnLineCount = rows.length + 1;
    }

    function takeTerminal() {
      emitKeypressEvents(input);
      input.setRawMode?.(true);
      input.resume();
      output.write(HIDE_CURSOR);
      input.on("keypress", onKeypress);
    }

    function releaseTerminal() {
      input.off("keypress", onKeypress);
      input.setRawMode?.(false);
      input.pause();
      output.write(SHOW_CURSOR);
    }

    function confirmSelection() {
      releaseTerminal();
      const picked = options[selection.index];
      output.write(`${eraseLinesAbove(drawnLineCount)}${question} ${picked.label}\n`);
      resolve(selection.index);
    }

    function onKeypress(character: string | undefined, key: Key = {}) {
      try {
        if (key.ctrl && key.name === "c") {
          releaseTerminal();
          process.exit(EXIT_CODE_INTERRUPTED);
        } else if (key.name === "return") {
          confirmSelection();
          return;
        } else if (key.name === "up" || key.name === "down") {
          selection = moveSelection(selection, key.name, options.length);
        } else if (character && /^\d$/.test(character)) {
          selection = typeDigit(selection, character, options.length);
        }
        draw();
      } catch (error) {
        releaseTerminal();
        reject(error);
      }
    }

    takeTerminal();
    draw();
  });
}
