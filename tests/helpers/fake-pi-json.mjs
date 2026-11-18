// TEST-ONLY fake `pi --mode json` child. The task is the last argv entry (after `--`); the child streams one assistant
// message, settles, and exits on its own, like Pi's JSON mode. The tests point `process.argv[1]` at this file, so the
// extension's own `piInvocation` spawns it instead of Pi.
//   - a task containing "LIMIT" ends with a rate-limit error from the model
// The answer starts with the first line of the task after the heading, so a test can tell the launches apart.
const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const message = (extra) => ({ role: "assistant", content: [{ type: "text", text: "" }], provider: "p", model: "m", usage, ...extra });

const task = String(process.argv.at(-1)).replace(/^## Task\n/, "");
const first = task.split("\n")[0];

line({ type: "session", version: 3, id: "fake", timestamp: new Date().toISOString(), cwd: process.cwd() });
line({ type: "agent_start" });
if (task.includes("LIMIT")) line({ type: "message_end", message: message({ content: [], stopReason: "error", errorMessage: "429 rate limit exceeded" }) });
else line({ type: "message_end", message: message({ content: [{ type: "text", text: `${first}\nsmall result` }], stopReason: "stop" }) });
line({ type: "agent_end", messages: [], willRetry: false });
line({ type: "agent_settled", aborted: false });
