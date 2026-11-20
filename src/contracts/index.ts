/**
 * Public contract barrel.
 *
 * Consumers import from `@/contracts` rather than reaching into slice files, so
 * the exported surface stays reviewable in one place. Add a new slice by
 * re-exporting it here.
 */
export * from "./events";
