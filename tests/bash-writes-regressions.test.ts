import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { extractWriteTargets } from "../lib/bash-writes.ts";
import { diffSnapshots, outsideSurfaces, takeSnapshot, type ExecFn } from "../lib/worktree-snapshot.ts";

const CWD = "/proj";
const targets = (command: string, cwd: string = CWD) => extractWriteTargets(command, cwd);

describe("bash write targets: shell syntax that is not a redirection", () => {
	it("ignores > inside arithmetic and [[ ]] comparisons", () => {
		assert.deepEqual(targets("if (( $# > 1 )); then echo many; fi"), []);
		assert.deepEqual(targets("n=3; (( n > 100 )) && echo long"), []);
		assert.deepEqual(targets("echo $(( 3 > 2 ))"), []);
		assert.deepEqual(targets("[[ a > b ]] && echo yes"), []);
	});
});

describe("bash write targets: cd scope", () => {
	it("does not carry a cd out of a subshell", () => {
		assert.deepEqual(targets("(cd src && npm test) > test.log 2>&1"), ["/proj/test.log"]);
		assert.deepEqual(targets("(cd src && touch a) && touch README.md"), ["/proj/src/a", "/proj/README.md"]);
	});

	it("does not carry a cd out of a sh -c script", () => {
		assert.deepEqual(targets("sh -c 'cd src && touch a'; touch README.md"), ["/proj/src/a", "/proj/README.md"]);
	});
});

const exec: ExecFn = async (command, args, options) => {
	try {
		const stdout = execFileSync(command, args, { cwd: options.cwd, timeout: options.timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { stdout, stderr: "", code: 0 };
	} catch (error) {
		return { stdout: "", stderr: String(error), code: 1 };
	}
};

describe("takeSnapshot against a real repository", () => {
	const repo = mkdtempSync(join(tmpdir(), "brigadev-snap-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
	mkdirSync(join(repo, "sub/src"), { recursive: true });
	for (const file of ["dirty.txt", "stay.txt", "gone.txt", "sub/x.txt"]) writeFileSync(join(repo, file), `${file}\n`);
	git("init", "-q");
	git("add", "-A");
	git("commit", "-qm", "init");
	appendFileSync(join(repo, "dirty.txt"), "pre\n");
	appendFileSync(join(repo, "stay.txt"), "pre\n");

	const changed = async (root: string, mutate: () => void) => {
		const before = await takeSnapshot(exec, root);
		mutate();
		const after = await takeSnapshot(exec, root);
		assert.ok(before && after);
		return outsideSurfaces(diffSnapshots(before, after), ["src/**"]);
	};

	it("ignores files that were already dirty and did not change", async () => {
		assert.deepEqual(await changed(repo, () => {}), []);
	});

	it("reports a further change to a dirty file, a deletion and an odd file name", async () => {
		const result = await changed(repo, () => {
			appendFileSync(join(repo, "dirty.txt"), "more\n");
			rmSync(join(repo, "gone.txt"));
			writeFileSync(join(repo, "a b\nc.txt"), "x");
		});
		assert.deepEqual(result, ["a b\nc.txt", "dirty.txt", "gone.txt"]);
	});

	it("reports paths relative to a project root below the repository root", async () => {
		const result = await changed(join(repo, "sub"), () => {
			writeFileSync(join(repo, "sub/src/in.txt"), "x");
			appendFileSync(join(repo, "sub/x.txt"), "x");
			writeFileSync(join(repo, "above.txt"), "x");
		});
		assert.deepEqual(result, ["x.txt"]);
	});

	it("returns undefined outside a repository", async () => {
		const plain = mkdtempSync(join(tmpdir(), "brigadev-plain-"));
		assert.equal(await takeSnapshot(exec, plain), undefined);
		rmSync(plain, { recursive: true, force: true });
	});

	it("cleans up", () => rmSync(repo, { recursive: true, force: true }));
});

describe("bash write targets: regressions of conditional blanking and cd scope", () => {
	it("keeps a real redirect after an arithmetic or [[ ]] test", () => {
		assert.deepEqual(targets("(( x > 1 )) && echo y > README.md"), ["/proj/README.md"]);
		assert.deepEqual(targets("[[ a > b ]] && echo y > README.md"), ["/proj/README.md"]);
	});

	it("still finds writes in command substitutions inside conditionals", () => {
		assert.deepEqual(targets("[[ -n $(echo x > README.md) ]]"), ["/proj/README.md"]);
		assert.deepEqual(targets("echo $(( $(touch README.md) + 1 ))"), ["/proj/README.md"]);
	});

	it("does not treat a case pattern ) as the end of a subshell", () => {
		assert.deepEqual(targets("(cd other; case x in a) ;; esac; touch ../README.md)"), ["/proj/README.md"]);
		assert.deepEqual(targets("(cd src; case x in a) touch b;; esac; touch c)"), ["/proj/src/b", "/proj/src/c"]);
	});
});

describe("bash write targets: case patterns and substitutions in conditionals", () => {
	it("keeps subshell cd scope across (a) patterns, multiple arms and newlines", () => {
		assert.deepEqual(targets("(cd src; case x in (a) touch b;; (b|c) touch d;; esac; touch c); touch e"), ["/proj/src/b", "/proj/src/d", "/proj/src/c", "/proj/e"]);
		assert.deepEqual(targets("(cd src; case x in a) touch b;; b) touch c;; *) touch d;; esac; touch e); touch f"), ["/proj/src/b", "/proj/src/c", "/proj/src/d", "/proj/src/e", "/proj/f"]);
		assert.deepEqual(targets("(cd src\ncase x in\na) touch b;;\nesac\ntouch c\n); touch d"), ["/proj/src/b", "/proj/src/c", "/proj/d"]);
	});

	it("closes the subshell right after esac", () => {
		assert.deepEqual(targets("(cd src; case x in a) touch b;; esac); touch README.md"), ["/proj/src/b", "/proj/README.md"]);
		assert.deepEqual(targets("(cd src; case x in a) touch b;; esac > ../README.md); touch d"), ["/proj/src/b", "/proj/README.md", "/proj/d"]);
	});

	it("tracks a case nested in a subshell inside a case arm", () => {
		assert.deepEqual(
			targets("(cd other; case x in a) (cd ../src; case y in b) touch q;; esac; touch r); touch s;; esac; touch t); touch u"),
			["/proj/src/q", "/proj/src/r", "/proj/other/s", "/proj/other/t", "/proj/u"],
		);
		assert.deepEqual(targets("(cd src; case x in a) case y in b) touch q;; esac; touch r;; esac; touch s); touch t"), ["/proj/src/q", "/proj/src/r", "/proj/src/s", "/proj/t"]);
	});

	it("treats case and esac as plain words when they are arguments", () => {
		assert.deepEqual(targets("echo esac > README.md"), ["/proj/README.md"]);
		assert.deepEqual(targets("(cd src; case x in a) echo esac;; esac; touch c); touch d"), ["/proj/src/c", "/proj/d"]);
		assert.deepEqual(targets("(cd src; echo case; touch c); touch d"), ["/proj/src/c", "/proj/d"]);
	});

	it("handles a case statement inside a command substitution", () => {
		assert.deepEqual(targets("(cd src; echo $(case x in a) echo;; esac); touch c); touch d"), ["/proj/src/c", "/proj/d"]);
		assert.deepEqual(targets("cd src; x=$(case y in a) cd ..;; esac); touch c"), ["/proj/src/c"]);
	});

	it("finds writes in substitutions inside conditionals, but not in quoted or escaped text", () => {
		assert.deepEqual(targets("[[ $(echo ']]') ]] > README.md"), ["/proj/README.md"]);
		assert.deepEqual(targets("[[ \"$(touch README.md)\" ]]"), ["/proj/README.md"]);
		assert.deepEqual(targets("[[ $(echo a > b) > c ]]"), ["/proj/b"]);
		assert.deepEqual(targets("[[ $(cd other; touch q) ]]; touch r"), ["/proj/other/q", "/proj/r"]);
		assert.deepEqual(targets("[[ $(echo $(touch README.md)) ]]"), ["/proj/README.md"]);
		assert.deepEqual(targets("[[ '$(touch README.md)' ]]"), []);
		assert.deepEqual(targets("[[ \\$(touch README.md) ]]"), []);
		assert.deepEqual(targets("[[ $(echo ']] > other/q') ]]"), []);
	});
});
