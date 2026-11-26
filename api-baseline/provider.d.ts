/**
 * `cheapag provider`: lists the providers already set up, or switches the worker to one of them with no key prompt
 * (ticket 47). The switch moves this repo's consent to the new provider with the same mode and prints what it now
 * covers, then live-checks the new provider; a failed check puts the previous provider and consent back.
 */
export declare function provider(args: string[]): Promise<number>;
