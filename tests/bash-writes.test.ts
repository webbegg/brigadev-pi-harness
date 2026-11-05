import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractWriteTargets, writesOutsideSurfaces } from "../lib/bash-writes.ts";

const CWD = "/proj";
const targets = (command: string, cwd: string = CWD) => extractWriteTargets(command, cwd);

describe("bash write targets: redirections", () => {
	it("finds >, >>, >| and &> targets", () => {
		assert.deepEqual(targets("echo hi > a.txt"), ["/proj/a.txt"]);
		assert.deepEqual(targets("echo hi >> a.txt"), ["/proj/a.txt"]);
		assert.deepEqual(targets("echo hi >| a.txt"), ["/proj/a.txt"]);
		assert.deepEqual(targets("make &> build.log"), ["/proj/build.log"]);
		assert.deepEqual(targets("echo hi >a.txt"), ["/proj/a.txt"]);
	});

	it("finds fd-prefixed redirections with a file target", () => {
		assert.deepEqual(targets("cmd 2> err.log"), ["/proj/err.log"]);
		assert.deepEqual(targets("cmd 1>out.log 2>err.log"), ["/proj/out.log", "/proj/err.log"]);
	});

	it("finds a redirection that has no command", () => {
		assert.deepEqual(targets("> empty.txt"), ["/proj/empty.txt"]);
	});

	it("finds cat heredocs written to a file and ignores the body", () => {
		const command = "cat > src/a.ts <<'EOF'\necho x > not-a-target.txt\nEOF";
		assert.deepEqual(targets(command), ["/proj/src/a.ts"]);
	});

	it("ignores descriptor duplication, /dev sinks and quoted operators", () => {
		assert.deepEqual(targets("npm test 2>&1"), []);
		assert.deepEqual(targets("cmd >&2"), []);
		assert.deepEqual(targets("cmd > /dev/null 2>&1"), []);
		assert.deepEqual(targets("cmd &> /dev/null"), []);
		assert.deepEqual(targets("cmd > /dev/stdout"), []);
		assert.deepEqual(targets("cmd 2> /dev/stderr"), []);
		assert.deepEqual(targets('grep ">" src/a.ts'), []);
		assert.deepEqual(targets("awk '$1 > 3' data.txt"), []);
		assert.deepEqual(targets("echo a\\>b"), []);
	});

	it("handles quoted targets with spaces", () => {
		assert.deepEqual(targets('echo hi > "my file.txt"'), ["/proj/my file.txt"]);
	});

	it("skips variable, substitution and glob targets", () => {
		assert.deepEqual(targets('echo hi > "$F"'), []);
		assert.deepEqual(targets("echo hi > $(mktemp)"), []);
		assert.deepEqual(targets("echo hi > `mktemp`"), []);
		assert.deepEqual(targets("echo hi > out*.txt"), []);
	});

	it("keeps absolute targets as they are, including scratch dirs", () => {
		assert.deepEqual(targets("grep -rn x src > /tmp/out"), ["/tmp/out"]);
		assert.deepEqual(targets("echo hi > ~/x.txt").length, 1);
	});
});

describe("bash write targets: commands", () => {
	it("tee, with and without -a", () => {
		assert.deepEqual(targets("echo x | tee a.txt b.txt"), ["/proj/a.txt", "/proj/b.txt"]);
		assert.deepEqual(targets("echo x | tee -a log.txt"), ["/proj/log.txt"]);
		assert.deepEqual(targets("echo x | tee"), []);
	});

	it("sed in place: -i, -i.bak, --in-place, clustered flags, BSD empty suffix", () => {
		assert.deepEqual(targets("sed -i 's/a/b/' src/a.ts src/b.ts"), ["/proj/src/a.ts", "/proj/src/b.ts"]);
		assert.deepEqual(targets("sed -i.bak 's/a/b/' src/a.ts"), ["/proj/src/a.ts"]);
		assert.deepEqual(targets("sed --in-place 's/a/b/' src/a.ts"), ["/proj/src/a.ts"]);
		assert.deepEqual(targets("sed --in-place=.bak 's/a/b/' src/a.ts"), ["/proj/src/a.ts"]);
		assert.deepEqual(targets("sed -ni 's/a/b/p' src/a.ts"), ["/proj/src/a.ts"]);
		assert.deepEqual(targets("sed -i '' 's/a/b/' src/a.ts"), ["/proj/src/a.ts"]);
		assert.deepEqual(targets("sed -i -e 's/a/b/' src/a.ts"), ["/proj/src/a.ts"]);
	});

	it("sed without in-place only reads", () => {
		assert.deepEqual(targets("sed 's/a/b/' src/a.ts"), []);
		assert.deepEqual(targets("sed -n -e 's/i/x/p' src/a.ts"), []);
		assert.deepEqual(targets("sed -n '/in/p' src/a.ts"), []);
	});

	it("cp, mv, install and ln use the destination", () => {
		assert.deepEqual(targets("cp a.txt b.txt"), ["/proj/b.txt"]);
		assert.deepEqual(targets("cp -r src dist"), ["/proj/dist"]);
		assert.deepEqual(targets("mv a.txt src/b.txt"), ["/proj/src/b.txt"]);
		assert.deepEqual(targets("install -m 755 tool bin/tool"), ["/proj/bin/tool"]);
		assert.deepEqual(targets("ln -s ../a.txt link.txt"), ["/proj/link.txt"]);
		assert.deepEqual(targets("cp a.txt b.txt dir/"), ["/proj/dir"]);
	});

	it("honors -t / --target-directory", () => {
		assert.deepEqual(targets("cp -t out a.txt b.txt"), ["/proj/out"]);
		assert.deepEqual(targets("mv --target-directory=out a.txt"), ["/proj/out"]);
		assert.deepEqual(targets("cp --target-directory out a.txt"), ["/proj/out"]);
	});

	it("touch, mkdir and truncate", () => {
		assert.deepEqual(targets("touch a.txt b.txt"), ["/proj/a.txt", "/proj/b.txt"]);
		assert.deepEqual(targets("mkdir -p src/new/deep"), ["/proj/src/new/deep"]);
		assert.deepEqual(targets("truncate -s 0 a.log b.log"), ["/proj/a.log", "/proj/b.log"]);
		assert.deepEqual(targets("truncate --size=0 a.log"), ["/proj/a.log"]);
	});

	it("looks through wrappers and shell -c scripts", () => {
		assert.deepEqual(targets("sudo tee a.txt"), ["/proj/a.txt"]);
		assert.deepEqual(targets("env FOO=1 cp a b"), ["/proj/b"]);
		assert.deepEqual(targets("bash -c 'echo x > a.txt'"), ["/proj/a.txt"]);
	});

	it("collects targets across separators", () => {
		assert.deepEqual(targets("touch a && echo x > b; cp c d"), ["/proj/a", "/proj/b", "/proj/d"]);
		assert.deepEqual(targets("if true; then echo x > a; fi"), ["/proj/a"]);
	});

	it("does not flag commands that only read", () => {
		assert.deepEqual(targets("npm test"), []);
		assert.deepEqual(targets("git status"), []);
		assert.deepEqual(targets("cat src/a.ts | grep foo"), []);
		assert.deepEqual(targets("ls -la"), []);
		assert.deepEqual(targets("cp"), []);
	});

	it("skips unresolvable arguments", () => {
		assert.deepEqual(targets('cp a "$DEST"'), []);
		assert.deepEqual(targets("touch src/*.ts"), []);
		assert.deepEqual(targets("tee $(pwd)/x"), []);
	});
});

describe("writesOutsideSurfaces", () => {
	const surfaces = ["src/a.ts", "tests"];
	const violations = (command: string, cwd: string = CWD) => writesOutsideSurfaces(command, cwd, CWD, surfaces);

	it("allows writes inside the surfaces", () => {
		assert.deepEqual(violations("echo x > src/a.ts"), []);
		assert.deepEqual(violations("sed -i 's/a/b/' tests/x.test.ts"), []);
		assert.deepEqual(violations("cd tests && touch new.test.ts"), []);
	});

	it("reports project paths outside the surfaces, relative to the root", () => {
		assert.deepEqual(violations("cat > src/b.ts <<'E'\nx\nE"), ["src/b.ts"]);
		assert.deepEqual(violations("cp tests/a.ts README.md"), ["README.md"]);
		assert.deepEqual(violations("touch a b", "/proj/src"), ["src/a", "src/b"]);
		assert.deepEqual(violations("echo x > ../sibling/file", "/proj/src"), ["sibling/file"]);
		assert.deepEqual(violations("echo x > ../../outside/file", "/proj/src"), []);
	});

	it("leaves targets outside the project root alone, including scratch dirs", () => {
		assert.deepEqual(violations("grep -rn x src > /tmp/out"), []);
		assert.deepEqual(violations("echo x > /tmp/scratch/a.txt && cp /tmp/a /tmp/b"), []);
		assert.deepEqual(violations("cd /elsewhere && touch a"), []);
	});

	it("does not report the project root itself", () => {
		assert.deepEqual(violations("mkdir -p ."), []);
	});

	it("skips unresolvable targets", () => {
		assert.deepEqual(violations('echo x > "$F"'), []);
	});
});

describe("bash write targets: working directory", () => {
	it("resolves against a literal cd prefix", () => {
		assert.deepEqual(targets("cd src && echo x > a.ts"), ["/proj/src/a.ts"]);
		assert.deepEqual(targets("cd /other && touch a"), ["/other/a"]);
		assert.deepEqual(targets("cd src; cd .. && touch a"), ["/proj/a"]);
	});

	it("uses the given cwd when there is no cd", () => {
		assert.deepEqual(targets("touch a", "/proj/sub"), ["/proj/sub/a"]);
	});

	it("drops relative targets after an unresolvable cd, keeps absolute ones", () => {
		assert.deepEqual(targets('cd "$DIR" && touch a /abs/b'), ["/abs/b"]);
		assert.deepEqual(targets("cd && touch a"), []);
	});
});
