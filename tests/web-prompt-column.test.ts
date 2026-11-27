// The web page files a guard prompt for a commit, push, or PR under the "commit" column by its command. The guard's dialog body
// now starts with WHAT IT WILL DO and shows the command on its `  $ ` line, so the page reads that line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { classifyCommand } from "../lib/command-classifier.ts";
import { commandDialog } from "../lib/permission-dialog.ts";
import { ASSETS_ROOT } from "../lib/runtime.ts";

const page = readFileSync(join(ASSETS_ROOT, "web-ui", "index.html"), "utf8");
const source = (pattern: RegExp) => {
	const found = pattern.exec(page);
	assert.ok(found, `${pattern} is in the page`);
	return found[0];
};
const isCommitPrompt = new Function(`${source(/var COMMIT_CMD = .*;/)}\n${source(/function promptCommand\(body\) \{.*\}/)}\nreturn (body) => COMMIT_CMD.test(promptCommand(body));`)() as (body: string) => boolean;

test("a guard prompt for a commit, push, or PR lands in the commit column; other prompts do not", () => {
	for (const command of ["git commit -m x", "# why: ship it\ngit push", "gh pr create --fill"]) {
		assert.equal(isCommitPrompt(commandDialog(command, classifyCommand(command)).body), true, command);
	}
	assert.equal(isCommitPrompt(commandDialog("rm -rf build", classifyCommand("rm -rf build")).body), false);
	assert.equal(isCommitPrompt("git push"), true, "a body that is only the command still works");
});
