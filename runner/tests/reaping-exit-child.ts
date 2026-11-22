// A process for tests/reaping-env.test.ts: it runs one bash call whose background process ignores SIGTERM, prints `bg=<pid>`, and exits at once, inside the SIGTERM-to-SIGKILL
// grace and without closing the environment (what `main` does when the last call of the loop returns). The process must not be left behind.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ReapingExecutionEnv } from "../src/reaping-env.ts";

const [cwd, graceMs] = process.argv.slice(2);
const env = new ReapingExecutionEnv({ cwd, graceMs: Number(graceMs) });
// The background shell has installed its SIGTERM trap (`ready`) before the call returns, so the process really ignores the TERM that follows.
const command = `sh -c 'trap "" TERM; : > ready; sleep 30' & echo bg=$!; n=0; while [ ! -e ready ] && [ $n -lt 1000 ]; do n=$((n+1)); sleep 0.01; done`;
const result = await env.exec(command, { onOutput: (text) => void process.stdout.write(text) }, BACKGROUND_CONTEXT);
process.exit(result.ok ? 0 : 1);
