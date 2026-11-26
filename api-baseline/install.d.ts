export declare const MARKETPLACE = "cheapag";
/** Where setup keeps the launcher and the generated marketplace: next to the user config. */
export declare const installPaths: () => {
    launcher: string;
    marketplace: string;
};
/** Writes the launcher and the plugin's marketplace; returns the marketplace directory. */
export declare function writePlugin(entry: string, _node: string, platform?: NodeJS.Platform): string;
/** Generates the plugin and adds it to Claude Code (or updates it); prints the manual commands when a step fails. */
export declare function installPlugin(out: (line?: string) => void, { update }?: {
    update?: boolean;
}): boolean;
/** A `node` on PATH resolving to this same binary (e.g. Homebrew's bin symlink) survives upgrades; the versioned execPath doesn't. */
export declare function stableNode(): string;
