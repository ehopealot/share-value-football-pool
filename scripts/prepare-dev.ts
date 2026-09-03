import { unstable_getVarsForDev } from "wrangler";
import { assertRequiredSharedDevVars, ensureSharedDevVars, sharedDevVarsPath, worktreeDevConfigPath } from "./dev-state";

const projectDirectory = process.cwd();
const backupPath = await ensureSharedDevVars(projectDirectory, sharedDevVarsPath(projectDirectory));
if (backupPath) console.log(`Preserved worktree local config: ${backupPath}`);
const sharedVars = unstable_getVarsForDev(worktreeDevConfigPath(projectDirectory), undefined, {}, undefined, true);
assertRequiredSharedDevVars(Object.fromEntries(Object.entries(sharedVars).map(([name, binding]) => [name, String(binding.value)])));
