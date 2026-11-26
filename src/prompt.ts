import { emitKeypressEvents } from "node:readline";

type Option = { label: string; hint?: string };
type RawInput = NodeJS.ReadStream & { setRawMode?: (on: boolean) => unknown };
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

/** Keeps `value` between `low` and `high`. `high` wins when it is below `low`, as for an empty list. */
function clamp(value: number, low: number, high: number) {
  return Math.min(Math.max(value, low), high);
}

/** One list row: a marker on the selected row, the row number counted from 1, the label and its hint. */
function formatRow(option: Option, rowIndex: number, selectedIndex: number) {
  const marker = rowIndex === selectedIndex ? "❯" : " ";
  const hint = option.hint ? `  ${option.hint}` : "";
  return `${marker} ${rowIndex + 1}) ${option.label}${hint}`;
}

/** The rows to draw: at most MAX_VISIBLE_ROWS, scrolled so the selected row stays near the middle. */
function visibleRows(options: Option[], selectedIndex: number, columns: number) {
  const rowCount = Math.min(options.length, MAX_VISIBLE_ROWS);
  const centred = selectedIndex - Math.floor(rowCount / 2);
  const first = clamp(centred, 0, options.length - rowCount);
  return options.slice(first, first + rowCount).map((option, offset) => {
    const row = formatRow(option, first + offset, selectedIndex);
    // one short of the width: a row that reaches the last column can wrap, and the redraw counts lines
    return row.slice(0, columns - 1);
  });
}

/** One row up or down, wrapping around at both ends. An arrow key forgets the digits typed before it. */
function moveSelection(selection: Selection, direction: "up" | "down", optionCount: number) {
  const step = direction === "up" ? -1 : 1;
  return { index: (selection.index + step + optionCount) % optionCount, typedNumber: "" };
}

/** Adds a digit to the typed number and selects that row. A number that names no row leaves the row as it is. */
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
  io: { input?: RawInput; output?: NodeJS.WriteStream } = {},
): Promise<number> {
  const input = io.input ?? (process.stdin as RawInput);
  const output = io.output ?? process.stdout;
  return new Promise((resolve, reject) => {
    let selection: Selection = { index: clamp(initial, 0, options.length - 1), typedNumber: "" };
    let drawnLineCount = 0;
    const draw = () => {
      const rows = visibleRows(options, selection.index, output.columns || DEFAULT_COLUMNS);
      if (drawnLineCount) output.write(eraseLinesAbove(drawnLineCount));
      output.write([question, ...rows].join("\n") + "\n");
      drawnLineCount = rows.length + 1;
    };
    const releaseTerminal = () => {
      input.off("keypress", onKeypress);
      input.setRawMode?.(false);
      input.pause();
      output.write(SHOW_CURSOR);
    };
    function onKeypress(
      character: string | undefined,
      key: { name?: string; ctrl?: boolean } = {},
    ) {
      try {
        if (key.ctrl && key.name === "c") {
          releaseTerminal();
          process.exit(EXIT_CODE_INTERRUPTED);
        } else if (key.name === "return") {
          releaseTerminal();
          const picked = options[selection.index];
          output.write(`${eraseLinesAbove(drawnLineCount)}${question} ${picked.label}\n`);
          return resolve(selection.index);
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
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    output.write(HIDE_CURSOR);
    input.on("keypress", onKeypress);
    draw();
  });
}
