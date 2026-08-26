import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const tag = "share-value-pool-owned-";
const leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith(tag));
const processes = [];
try {
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name)).slice(0, 100_000);
  for (const pid of pids) {
    try {
      const command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
      if (command.includes(tag) && /(workerd|wrangler|playwright|node)/i.test(command)) processes.push(`${pid}:${command.slice(0, 300)}`);
    } catch { /* process exited or is inaccessible */ }
  }
} catch (error) {
  throw new Error(`cannot verify tagged owned processes: ${String(error).slice(0, 500)}`);
}
if (leftovers.length || processes.length) throw new Error(`owned resources remain: directories=[${leftovers.join(", ")}], processes=[${processes.join("; ").slice(0, 2_000)}]`);
console.log("No tagged local process groups or persistence directories remain");
