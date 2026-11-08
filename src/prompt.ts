import { emitKeypressEvents } from "node:readline";

type Option = { label: string; hint?: string };
type In = NodeJS.ReadStream & { setRawMode?: (on: boolean) => unknown };

const WINDOW = 12;

/**
 * An arrow-key list on a terminal: ↑/↓ move, Enter picks, typing a number jumps to that row, Ctrl-C exits 130.
 * Redraws in place and always gives the terminal back (raw mode off, cursor shown) on Enter, Ctrl-C and errors.
 * `io` is for tests, which drive it with a fake stdin.
 */
export function select(question: string, options: Option[], initial = 0, io: { input?: In; output?: NodeJS.WriteStream } = {}): Promise<number> {
  const input = io.input ?? (process.stdin as In);
  const output = io.output ?? process.stdout;
  return new Promise((resolve, reject) => {
    let index = Math.min(Math.max(initial, 0), options.length - 1);
    let typed = "";
    let drawn = 0;
    const size = Math.min(options.length, WINDOW);
    const fit = (line: string) => line.slice(0, (output.columns || 100) - 1);
    const draw = () => {
      const top = Math.min(Math.max(index - Math.floor(size / 2), 0), options.length - size);
      const rows = options.slice(top, top + size).map((o, i) => fit(`${top + i === index ? "❯" : " "} ${top + i + 1}) ${o.label}${o.hint ? `  ${o.hint}` : ""}`));
      if (drawn) output.write(`\x1b[${drawn}A\x1b[J`);
      output.write([question, ...rows].join("\n") + "\n");
      drawn = rows.length + 1;
    };
    const done = () => {
      input.off("keypress", onKey);
      input.setRawMode?.(false);
      input.pause();
      output.write("\x1b[?25h");
    };
    function onKey(str: string | undefined, key: { name?: string; ctrl?: boolean } = {}) {
      try {
        if (key.ctrl && key.name === "c") {
          done();
          process.exit(130);
        } else if (key.name === "return") {
          done();
          output.write(`\x1b[${drawn}A\x1b[J${question} ${options[index].label}\n`);
          return resolve(index);
        } else if (key.name === "up" || key.name === "down") {
          typed = "";
          index = (index + (key.name === "up" ? -1 : 1) + options.length) % options.length;
        } else if (str && /^\d$/.test(str)) {
          typed = Number(typed + str) > options.length ? str : typed + str;
          if (Number(typed) >= 1 && Number(typed) <= options.length) index = Number(typed) - 1;
        }
        draw();
      } catch (err) {
        done();
        reject(err);
      }
    }
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    output.write("\x1b[?25l");
    input.on("keypress", onKey);
    draw();
  });
}
