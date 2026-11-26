import { type Provider } from "./credentials.js";
export declare function login(args?: string[], { setup }?: {
    setup?: boolean;
}): Promise<number>;
/** Sets one key of the user config, other keys kept; undefined removes it. False (and said) when the file cannot be written. */
export declare function setUserKey(key: string, value: unknown, out: (line?: string) => void): boolean;
/** One tiny real call to the implement model the user's config now picks, through the bundled OpenCode, in a throwaway directory. */
export declare function liveCheck(provider: Provider): Promise<{
    ok: boolean;
    line: string;
}>;
/** The fix for OpenCode Go's Global-region error, when the live check hit it. */
export declare function regionHint(line: string): string | undefined;
