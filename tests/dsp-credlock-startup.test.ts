// S10: shell startup files cannot bring tokens back into a locked command (zsh reads ~/.zshenv even for `zsh -c`;
// bash reads $BASH_ENV, sh reads $ENV).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { lockEnvironment, lockPrelude } from "../lib/dsp-credlock.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "dsp-startup-")));
after(() => rmSync(home, { recursive: true, force: true }));
writeFileSync(join(home, ".zshenv"), "export GH_TOKEN=ghp_from_zshenv\n");
writeFileSync(join(home, "bash-env.sh"), "export GH_TOKEN=ghp_from_bash_env\n");

const hasZsh = spawnSync("zsh", ["-c", "true"]).status === 0;
const parent = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, BASH_ENV: join(home, "bash-env.sh"), ENV: join(home, "bash-env.sh") };

describe("S10 credential lock and shell startup files", () => {
	it("a nested zsh -c does not read ~/.zshenv", { skip: !hasZsh && "zsh not installed" }, () => {
		const prelude = lockPrelude(lockEnvironment(parent));
		const out = execFileSync("bash", ["-c", `${prelude}\nzsh -c 'echo "[$GH_TOKEN]"'`], { env: parent, encoding: "utf8" });
		assert.equal(out.trim(), "[]");
	});

	it("a nested bash -c does not run $BASH_ENV and sh does not get $ENV", () => {
		const locked = lockEnvironment(parent);
		assert.equal(locked.env.BASH_ENV, undefined);
		assert.equal(locked.env.ENV, undefined);
		const out = execFileSync("bash", ["-c", `${lockPrelude(locked)}\nbash -c 'echo "[$GH_TOKEN]"'`], { env: { PATH: parent.PATH, HOME: home }, encoding: "utf8" });
		assert.equal(out.trim(), "[]");
	});
});
