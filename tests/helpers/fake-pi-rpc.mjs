// TEST-ONLY fake `pi --mode rpc` child. Reads JSONL commands from stdin, answers the prompt with one assistant
// message, settles, and exits when stdin closes. The tests point `process.argv[1]` at this file, so the extension's own
// `piInvocation` spawns it instead of Pi.
//   - a task containing "BIG" answers with 250 000 characters (past the delivered message's size cap)
//   - any other task answers "small result"
// The answer always starts with the first line of the task, so a test can tell the launches apart.
const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const finish = (text) => {
	line({ type: "agent_start" });
	line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], provider: "p", model: "m", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
	line({ type: "agent_end", messages: [], willRetry: false });
	line({ type: "agent_settled", aborted: false });
};

const onCommand = (command) => {
	if (command.type !== "prompt") return;
	line({ type: "response", command: "prompt", success: true, data: { disposition: "started" } });
	const task = String(command.message).replace(/^## Task\n/, "");
	const first = task.split("\n")[0];
	finish(task.includes("BIG") ? `${first}\n${"x".repeat(250_000)}` : `${first}\nsmall result`);
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let at;
	while ((at = buffer.indexOf("\n")) >= 0) {
		const text = buffer.slice(0, at);
		buffer = buffer.slice(at + 1);
		if (text.trim()) onCommand(JSON.parse(text));
	}
});
process.stdin.on("end", () => process.exit(0));
