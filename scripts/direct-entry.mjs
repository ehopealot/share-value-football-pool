import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Compares a module URL with Node's direct-entry filesystem argument without URL-encoding ambiguity. */
export const isDirectExecution = (moduleUrl, argvEntry = process.argv[1]) =>
  Boolean(argvEntry) && fileURLToPath(moduleUrl) === resolve(argvEntry);
