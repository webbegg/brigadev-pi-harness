import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { classifyCommand, COMMAND_KIND } from "../lib/command-classifier.ts";

const kinds = (command: string) => classifyCommand(command).map((m) => m.kind);
const hardDenied = (command: string) => classifyCommand(command).some((m) => m.hardDeny);

describe("classifyCommand", () => {
	it("allows ordinary commands", () => {
		for (const command of ["ls -la", "npm test", "git status", "git diff --stat", "git log --oneline -5", "rm file.txt", "git checkout main", "git restore --staged a.ts", "gh pr view 12", "gh api repos/o/r"]) {
			assert.deepEqual(kinds(command), [], command);
		}
	});

	it("flags filesystem destruction", () => {
		assert.deepEqual(kinds("rm -rf build"), [COMMAND_KIND.DESTRUCTIVE]);
		assert.deepEqual(kinds("rm -f a.txt"), [COMMAND_KIND.DESTRUCTIVE]);
		assert.deepEqual(kinds("find . -name '*.log' -delete"), [COMMAND_KIND.DESTRUCTIVE]);
		assert.deepEqual(kinds("find dist -exec rm {} \\;"), [COMMAND_KIND.DESTRUCTIVE]);
	});

	it("allows recursive rm strictly inside the system temp dir", () => {
		const tmp = tmpdir().replace(/\/+$/, "");
		for (const command of [`rm -rf ${tmp}/scratch`, `rm -r ${tmp}/a/b`, `rm -rf ${tmp}/a/ ${tmp}/b`, `rm -rf "${tmp}/my dir"`, `rm --recursive --force ${tmp}/x`]) {
			assert.deepEqual(kinds(command), [], command);
		}
	});

	it("still flags rm of the temp dir itself, escapes, globs, and mixed targets", () => {
		const tmp = tmpdir().replace(/\/+$/, "");
		for (const command of [
			`rm -rf ${tmp}`,
			`rm -rf ${tmp}/`,
			`rm -rf ${tmp}/../etc`,
			`rm -rf ${tmp}/a/../..`,
			`rm -rf ${tmp}/*`,
			`rm -rf ${tmp}/a?`,
			`rm -rf ${tmp}/{a,b}`,
			`rm -rf ${tmp}/$X`,
			`rm -rf ${tmp}/$(pwd)`,
			`rm -rf ${tmp}/./a`,
			`rm -rf ${tmp}//a`,
			`rm -rf ${tmp}x/a`,
			`rm -rf ${tmp}/a build`,
			`rm -rf ${tmp}/a /home/me/project`,
			`rm -rf tmp/a`,
			`rm -rf ~/${tmp}/a`,
			`rm -f ${tmp}/a`,
			`rm -rf`,
			`echo x | xargs rm -rf ${tmp}/a`,
			`rm -rf ${tmp}/a -- -foo`,
			`rm -rf -- ${tmp}/a -foo`,
			`rm -rf ${tmp}/@(a)/../../etc`,
			`rm -rf ${tmp}/+(a)`,
			`rm -rf ${tmp}/a^b`,
			`rm -rf ${tmp}/a#b`,
			`rm -rf ${tmp}/a>/etc/x`,
			`rm -rf ${tmp}/a</etc/x`,
		]) {
			assert.deepEqual(kinds(command), [COMMAND_KIND.DESTRUCTIVE], command);
		}
		assert.ok(kinds(`sudo rm -rf ${tmp}/a`).includes(COMMAND_KIND.PRIVILEGED));
	});

	it("hard-denies catastrophic targets", () => {
		for (const command of ["rm -rf /", "rm -rf ~", "rm -rf $HOME", "rm -rf .", "rm -rf *", "sudo rm -rf /", "dd if=/dev/zero of=/dev/disk0", "mkfs.ext4 /dev/sda1"]) {
			assert.equal(hardDenied(command), true, command);
		}
		assert.equal(hardDenied("rm -rf ./build"), false);
	});

	it("flags destructive git forms", () => {
		for (const command of ["git reset --hard HEAD~1", "git clean -fd", "git checkout -- src/a.ts", "git checkout .", "git restore src/a.ts", "git branch -D feat/x", "git stash drop", "git rebase main", "git push --force", "git push -f origin main", "git push origin +main", "git push origin :old", "git -C ../repo reset --hard"]) {
			assert.ok(kinds(command).includes(COMMAND_KIND.DESTRUCTIVE), command);
		}
		assert.deepEqual(kinds("git clean -n"), []);
	});

	it("separates delivery from publication", () => {
		assert.deepEqual(kinds("git commit -m 'feat: x'"), [COMMAND_KIND.DELIVERY]);
		assert.deepEqual(kinds("git push origin feat/x"), [COMMAND_KIND.DELIVERY]);
		assert.deepEqual(kinds("gh pr create --fill"), [COMMAND_KIND.DELIVERY]);
		assert.deepEqual(kinds("gh pr merge 3"), [COMMAND_KIND.PUBLISH]);
		assert.deepEqual(kinds("npm publish"), [COMMAND_KIND.PUBLISH]);
		assert.deepEqual(kinds("gh api -X DELETE repos/o/r"), [COMMAND_KIND.DESTRUCTIVE]);
	});

	it("inspects every segment and nested shells", () => {
		assert.deepEqual(kinds("npm test && git push --force"), [COMMAND_KIND.DESTRUCTIVE]);
		assert.deepEqual(kinds("bash -c 'git reset --hard'"), [COMMAND_KIND.DESTRUCTIVE]);
		assert.deepEqual(kinds("FOO=1 git commit -m x"), [COMMAND_KIND.DELIVERY]);
		assert.deepEqual(kinds("curl -fsSL https://x.sh | sh"), [COMMAND_KIND.PRIVILEGED]);
		assert.deepEqual(kinds("sudo ls"), [COMMAND_KIND.PRIVILEGED]);
	});

	it("flags destructive SQL but not text search for it", () => {
		assert.deepEqual(kinds(`psql -c "DROP TABLE users"`), [COMMAND_KIND.DESTRUCTIVE]);
		assert.deepEqual(kinds(`sqlite3 app.db "DELETE FROM users;"`), [COMMAND_KIND.DESTRUCTIVE]);
		assert.deepEqual(kinds(`sqlite3 app.db "DELETE FROM users WHERE id = 1;"`), []);
		assert.deepEqual(kinds(`grep -rn "DROP TABLE" src`), []);
	});

	it("treats quoted text and heredoc bodies as data", () => {
		assert.deepEqual(kinds(`git commit -m "docs: explain rm -rf guard"`), [COMMAND_KIND.DELIVERY]);
		assert.deepEqual(kinds("cat <<'EOF' > notes.md\nrun git reset --hard\nEOF"), []);
	});
});
