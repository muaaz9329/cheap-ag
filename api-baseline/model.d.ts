export declare const MORE_MODELS = "For more models, exit Claude/Codex and run: npx cheap-agent model";
/** `cheapag model`: choose the worker's main and fallback models, each with an effort, from the provider's own catalog. */
export declare function model(args: string[]): Promise<number>;
