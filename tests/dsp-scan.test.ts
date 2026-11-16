// S6b: running a script, Makefile target, or package.json script that contains a remote form asks; unreadable or too large asks.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { classifyDsp, MAX_SCRIPT_BYTES } from "../lib/dsp-classify.ts";
import { realTmp, remoteLabels, unknownReasons, writeTree } from "./dsp-fixtures.test.ts";

describe("script scanning", () => {
	let dir: string;
	before(() => {
		dir = realTmp("dsp-scan-");
		writeTree(dir, {
			"push.sh": "#!/bin/sh\nset -e\ngit push origin main\n",
			"clean.sh": "#!/bin/sh\necho hello\nnpm install\nrm -rf build\n",
			"outer.sh": "#!/bin/sh\nbash push.sh\n",
			"x.js": "const { execSync } = require('child_process');\nexecSync(\"git push origin main\");\n",
			"y.py": "import subprocess\nsubprocess.run([\"git\", \"push\"])\n",
			"gh.rb": "system('gh pr merge 1')\n",
			"safe.js": "console.log('hello');\n",
			"big.sh": `#!/bin/sh\n${"echo hi\n".repeat(MAX_SCRIPT_BYTES / 8 + 10)}`,
			"sub/inner.sh": "#!/bin/sh\ngit push\n",
			Makefile: "build:\n\tnpm run build\n\ntest:\n\tnpm test\n\nrelease: test\n\tgit push\n\tgh release create v1\n\nship: release\n\t@echo shipped\n",
			"pkg/package.json": JSON.stringify({ scripts: { test: "node --test", release: "gh pr merge 1", prerelease: "git push", build: "tsc", ship: "npm run release" } }),
			"bad/package.json": "{ not json",
			"nopkg/readme": "x",
		});
		writeFileSync(join(dir, "bin.dat"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 0, 3]));
		chmodSync(join(dir, "bin.dat"), 0o755);
		chmodSync(join(dir, "push.sh"), 0o755);
		chmodSync(join(dir, "clean.sh"), 0o755);
		mkdirSync(join(dir, "makeless"), { recursive: true });
		mkdirSync(join(dir, "notafile.sh"), { recursive: true });
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	const labels = (command: string, cwd = dir) => remoteLabels(classifyDsp(command, { cwd }));
	const unknown = (command: string, cwd = dir) => unknownReasons(classifyDsp(command, { cwd }));

	it("flags shell scripts run by an interpreter or directly", () => {
		for (const command of ["bash push.sh", "sh push.sh", "zsh push.sh", "bash ./push.sh", `bash ${join(dir, "push.sh")}`, "./push.sh", "source push.sh", ". ./push.sh", "bash -x push.sh arg", "time bash push.sh"]) {
			assert.ok(labels(command).length > 0, command);
		}
	});

	it("flags scripts in other languages", () => {
		for (const command of ["node x.js", "python y.py", "python3 y.py", "ruby gh.rb", "node --no-warnings x.js", "tsx x.js"]) {
			assert.ok(labels(command).length > 0, command);
		}
	});

	it("names the script in the label", () => {
		assert.ok(labels("bash push.sh").some((label) => label.includes("push.sh")), JSON.stringify(labels("bash push.sh")));
	});

	it("follows a script that runs another script", () => {
		assert.ok(labels("bash outer.sh").length > 0);
	});

	it("resolves the script against a literal cd", () => {
		assert.ok(labels("cd sub && bash inner.sh").length > 0);
		assert.ok(labels("cd sub && bash ../push.sh").length > 0);
	});

	it("leaves harmless scripts alone", () => {
		for (const command of ["bash clean.sh", "./clean.sh", "node safe.js", "bash bin.dat"]) {
			assert.deepEqual([labels(command), unknown(command)], [[], []], command);
		}
	});

	it("does not treat other risky commands in a script as remote", () => {
		assert.deepEqual(labels("bash clean.sh"), []);
	});

	it("asks when the script cannot be read", () => {
		const matches = classifyDsp("bash push.sh", { cwd: dir, readFile: () => ({ error: "EACCES: permission denied" }) });
		assert.equal(unknownReasons(matches).length, 1);
		assert.match(unknownReasons(matches)[0], /cannot read script/);
	});

	it("a directory is not a script (the shell itself refuses it)", () => {
		assert.deepEqual([labels("bash notafile.sh"), unknown("bash notafile.sh")], [[], []]);
	});

	it("asks when the script is too large", () => {
		const reasons = unknown("bash big.sh");
		assert.equal(reasons.length, 1);
		assert.match(reasons[0], /too large/);
	});

	it("a binary is not a script", () => {
		assert.deepEqual(unknown("./bin.dat"), []);
	});

	it("a script that does not exist yet and is not written here is left to fail", () => {
		assert.deepEqual([labels("bash missing.sh"), unknown("bash missing.sh")], [[], []]);
	});

	it("asks when the same command writes the script it runs", () => {
		assert.equal(unknown("echo 'git push' > new.sh && sh new.sh").length, 1);
		assert.equal(unknown("printf 'git push\\n' | tee new.sh; bash new.sh").length, 1);
		assert.equal(unknown("echo 'git push' >> clean.sh && bash clean.sh").length, 1, "an existing script it appends to is not the scanned text");
		assert.equal(unknown("cat > new.sh <<'EOF'\ngit push\nEOF\nbash new.sh").length, 1);
		assert.equal(unknown("chmod +x clean.sh && ./clean.sh").length, 1);
	});

	it("scans inline code of an interpreter", () => {
		assert.ok(labels(`node -e 'require("child_process").execSync("git push")'`).length > 0);
		assert.ok(labels(`python3 -c 'import os; os.system("gh pr merge 1")'`).length > 0);
		assert.deepEqual(labels(`node -e 'console.log(1)'`), []);
	});

	describe("make", () => {
		it("flags a target whose recipe, or whose prerequisite's recipe, is remote", () => {
			assert.ok(labels("make release").length > 0);
			assert.ok(labels("make ship").length > 0);
			assert.ok(labels("make -j4 release").length > 0);
			assert.ok(labels("make -f Makefile release").length > 0);
			assert.ok(labels("make -C . release").length > 0);
		});
		it("leaves other targets alone", () => {
			assert.deepEqual([labels("make test"), unknown("make test")], [[], []]);
			assert.deepEqual(labels("make build"), []);
		});
		it("the default goal is the first target", () => {
			assert.deepEqual(labels("make"), []);
		});
		it("asks when the Makefile cannot be read as a Makefile", () => {
			assert.equal(unknown("make -f notafile.sh x").length, 1);
		});
		it("without a Makefile there is nothing to scan", () => {
			assert.deepEqual([labels("make x", join(dir, "makeless")), unknown("make x", join(dir, "makeless"))], [[], []]);
		});
	});

	describe("package scripts", () => {
		it("flags npm/pnpm/yarn/bun scripts that are remote, including pre and post hooks", () => {
			const cwdPkg = join(dir, "pkg");
			for (const command of ["npm run release", "npm run-script release", "pnpm run release", "pnpm release", "yarn release", "yarn run release", "bun run release", "npm run ship"]) {
				assert.ok(labels(command, cwdPkg).length > 0, command);
			}
		});
		it("leaves other scripts alone", () => {
			const cwdPkg = join(dir, "pkg");
			for (const command of ["npm test", "npm run test", "npm run build", "pnpm test", "yarn build", "npm run missing"]) {
				assert.deepEqual([labels(command, cwdPkg), unknown(command, cwdPkg)], [[], []], command);
			}
		});
		it("asks when package.json cannot be parsed", () => {
			assert.equal(unknown("npm run build", join(dir, "bad")).length, 1);
		});
		it("without package.json there is nothing to scan", () => {
			assert.deepEqual(unknown("npm run build", join(dir, "nopkg")), []);
		});
	});
});

describe("script scanning: verifier regressions apply inside a scanned script", () => {
	let dir: string;
	const remoteScripts: Record<string, string> = {
		"merge-main.sh": "#!/bin/sh\ngit switch main\ngit merge feat/x\n",
		"merge-one-line.sh": "git checkout main && git merge feat/x\n",
		"rebase-after-switch.sh": "git checkout main\ngit rebase feat/x\n",
		"sendpack.sh": "git send-pack origin main\n",
		"helper.sh": "git remote-https origin https://example.com/x.git\n",
		"herestring.sh": "bash <<< 'git push'\n",
		"su.sh": "su -c 'git push'\n",
		"script-cmd.sh": "script -q /dev/null git push\n",
		"parallel.sh": "parallel ::: 'git push'\n",
		"osa.sh": "osascript -e 'do shell script \"git push\"'\n",
		"curlk.sh": "curl -K cfg https://api.github.com/x\n",
		"ssh.sh": "set -e\nssh deploy@example.com 'git pull'\n",
		"scp.sh": "scp build.tar deploy@example.com:/srv/\n",
		"rsync.sh": "rsync -a dist/ deploy@example.com:/srv/\n",
		"nc.sh": "nc example.com 80 < req.txt\n",
		"tcp.sh": "exec 3<>/dev/tcp/example.com/80\n",
		"ssh.js": "const { execSync } = require('child_process');\nexecSync(\"ssh host true\");\n",
		"args.py": "import subprocess\nsubprocess.run([\"git\", \"push\"])\n",
	};
	const askingScripts: Record<string, string> = {
		"xargs.sh": "echo push | xargs git\n",
		"xargs-replace.sh": "echo push | xargs -I{} git {}\n",
		"herestring-var.sh": "bash <<< \"$CMD\"\n",
		"parallel-file.sh": "parallel < cmds.txt\n",
		"osa-concat.sh": "osascript -e 'do shell script \"git \" & \"push\"'\n",
		"inline-spawn.sh": "python3 -c \"import os; os.system(c)\"\n",
		"inline-node.sh": "node -e 'require(\"child_process\").execSync(c)'\n",
		"var-sub.sh": "git $SUB origin\n",
	};
	before(() => {
		dir = realTmp("dsp-scan-verify-");
		writeTree(dir, {
			...remoteScripts,
			...askingScripts,
			"local.sh": "#!/bin/sh\ngit merge feat/y\nrsync -a src/ backup/\necho a b | xargs -n1 echo\npython3 -c 'print(1)'\nscp ./a:b c\n",
		});
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	const labels = (command: string) => remoteLabels(classifyDsp(command, { cwd: dir }));
	const unknown = (command: string) => unknownReasons(classifyDsp(command, { cwd: dir }));

	for (const name of Object.keys(remoteScripts)) {
		it(`flags ${name}`, () => {
			const command = name.endsWith(".js") ? `node ${name}` : name.endsWith(".py") ? `python ${name}` : `bash ${name}`;
			assert.ok(labels(command).some((label) => label.includes(name)), `${command}: ${JSON.stringify(labels(command))}`);
		});
	}
	for (const name of Object.keys(askingScripts)) {
		it(`asks for ${name}`, () => assert.ok(unknown(`bash ${name}`).length > 0 || labels(`bash ${name}`).length > 0, name));
	}

	it("names the merge after a switch", () => {
		assert.ok(labels("bash merge-main.sh").some((label) => label.includes("merge or rebase after a branch switch")), JSON.stringify(labels("bash merge-main.sh")));
	});
	it("a script run with a -c argument is scanned, not taken for inline code", () => {
		assert.ok(labels("python args.py -c 'print(1)'").length > 0);
	});
	it("a script with only local work is left alone", () => {
		assert.deepEqual([labels("bash local.sh"), unknown("bash local.sh")], [[], []]);
	});
});
