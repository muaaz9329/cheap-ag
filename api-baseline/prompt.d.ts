type Option = {
    label: string;
    hint?: string;
};
type In = NodeJS.ReadStream & {
    setRawMode?: (on: boolean) => unknown;
};
/**
 * An arrow-key list on a terminal: ↑/↓ move, Enter picks, typing a number jumps to that row, Ctrl-C exits 130.
 * Redraws in place and always gives the terminal back (raw mode off, cursor shown) on Enter, Ctrl-C and errors.
 * `io` is for tests, which drive it with a fake stdin.
 */
export declare function select(question: string, options: Option[], initial?: number, io?: {
    input?: In;
    output?: NodeJS.WriteStream;
}): Promise<number>;
export {};
