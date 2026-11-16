// S6c: protected paths still ask in DSP even though writes outside the project are otherwise allowed; the audit log is not writable.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bashProtectedTargets, isCredentialPath, protectedPathKind, type ProtectedPathContext } from "../lib/dsp-paths.ts";
import { isSensitivePath } from "../lib/permission-policy.ts";
import { realTmp } from "./dsp-fixtures.test.ts";

const home = realTmp("dsp-paths-home-");
process.env.HOME = home; // `~/` in a command expands against it (each test file runs in its own process)
const project = realTmp("dsp-paths-project-");
const installRoot = realTmp("dsp-paths-install-");
const ctx: ProtectedPathContext = {
	home,
	agentDir: join(home, ".pi", "agent"),
	installRoot,
	projectRoot: project,
	docsDir: join(home, ".brigadev", "repo"),
};
const kind = (path: string, over: Partial<ProtectedPathContext> = {}) => protectedPathKind(path, { ...ctx, ...over });

describe("protected paths", () => {
	const protectedPaths: Array<[string, string]> = [
		["the Pi dir", join(home, ".pi", "agent", "settings.json")],
		["Pi extensions", join(home, ".pi", "agent", "extensions", "x.ts")],
		["the brigadev settings", join(home, ".pi", "agent", "brigadev.json")],
		["the Pi dir itself", join(home, ".pi")],
		["the installed harness", join(installRoot, "lib", "guard-rules.ts")],
		["the evidence folder", join(home, ".brigadev", "repo", "evidence", "x.jsonl")],
		["~/.gitconfig", join(home, ".gitconfig")],
		["~/.config/git/", join(home, ".config", "git", "config")],
		["~/.config/git/ignore", join(home, ".config", "git", "ignore")],
		["~/.config/gh/", join(home, ".config", "gh", "hosts.yml")],
		[".git/config in the project", join(project, ".git", "config")],
		[".git/hooks in the project", join(project, ".git", "hooks", "pre-commit")],
		[".git/config of another repository", join(home, "other", ".git", "config")],
		[".git/hooks of another repository", join(home, "other", ".git", "hooks", "post-commit")],
		["~/.zshrc", join(home, ".zshrc")],
		["~/.bashrc", join(home, ".bashrc")],
		["~/.bash_profile", join(home, ".bash_profile")],
		["~/.profile", join(home, ".profile")],
		["~/.zprofile", join(home, ".zprofile")],
		["~/.zshenv", join(home, ".zshenv")],
		["fish config", join(home, ".config", "fish", "config.fish")],
		["~/.ssh/", join(home, ".ssh", "config")],
		["~/.docker/config.json", join(home, ".docker", "config.json")],
		["~/.aws/credentials", join(home, ".aws", "credentials")],
		["~/.netrc", join(home, ".netrc")],
		["~/.npmrc", join(home, ".npmrc")],
		["~/.git-credentials", join(home, ".git-credentials")],
	];
	for (const [name, path] of protectedPaths) it(`${name} is protected`, () => assert.equal(kind(path), "protected", path));

	it("the audit log is blocked, not asked", () => {
		assert.equal(kind(join(home, ".brigadev", "repo", "audit", "dsp.jsonl")), "audit");
		assert.equal(kind(join(home, ".brigadev", "repo", "audit")), "audit");
	});

	const free: Array<[string, string]> = [
		["a project file", join(project, "src", "a.ts")],
		["the .git directory's other files", join(project, ".git", "HEAD")],
		["a feature document", join(home, ".brigadev", "repo", "tasks", "x.md")],
		["a file in the home folder", join(home, "notes.txt")],
		["~/.config/other", join(home, ".config", "other", "x")],
		["a lookalike name", join(home, ".zshrc-backup-dir", "x")],
		["a file named like git config in the project", join(project, "docs", "config")],
		["a project .npmrc", join(project, ".npmrc")],
		["a lookalike of ~/.ssh", join(home, ".ssh-notes", "x")],
	];
	for (const [name, path] of free) it(`${name} is not protected`, () => assert.equal(kind(path), undefined, path));

	it("when the project is the harness checkout, its own files are not the installed harness", () => {
		assert.equal(kind(join(installRoot, "lib", "x.ts"), { projectRoot: installRoot }), undefined);
		assert.equal(kind(join(installRoot, ".git", "hooks", "x"), { projectRoot: installRoot }), "protected");
	});

	it("sensitive paths keep their own rule (reading secrets still asks)", () => {
		assert.equal(isSensitivePath(join(home, ".ssh", "id_rsa")), true);
		assert.equal(isSensitivePath(join(project, ".env")), true);
	});
});

describe("credential stores (S10)", () => {
	const credentials = [join(home, ".ssh", "id_ed25519"), join(home, ".ssh"), join(home, ".config", "gh", "hosts.yml"), join(home, ".git-credentials"), join(home, ".docker", "config.json"), join(home, ".netrc"), join(home, ".npmrc"), join(home, ".aws", "credentials"), join(home, ".pi", "agent", "auth.json")];
	// Shell startup files export tokens again in an interactive or login shell: their reads ask too.
	credentials.push(...[".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin"].map((name) => join(home, name)), join(home, ".config", "fish", "config.fish"));
	for (const path of credentials) it(`${path.slice(home.length)} is a credential path`, () => assert.equal(isCredentialPath(path, home), true));
	for (const path of [join(project, ".npmrc"), join(home, ".config", "other", "x"), join(home, ".ssh-notes"), join(home, "notes.txt"), join(home, ".docker-compose.yml"), join(home, ".gitconfig"), join(project, ".bashrc"), join(home, ".zshrc.bak")]) {
		it(`${path.slice(home.length) || path} is not`, () => assert.equal(isCredentialPath(path, home), false));
	}
	it("a shell write to one is a protected target", () => {
		const found = bashProtectedTargets("echo x > ~/.netrc", project, ctx);
		assert.deepEqual(found.map((entry) => entry.kind), ["protected"]);
	});
});

describe("protected targets of a shell command", () => {
	const targets = (command: string, cwd = project) => bashProtectedTargets(command, cwd, ctx).map((t) => t.path);

	it("finds writes by redirection and by file-changing commands", () => {
		assert.deepEqual(targets(`echo 'alias x=y' >> ${join(home, ".zshrc")}`), [join(home, ".zshrc")]);
		assert.deepEqual(targets(`tee ${join(home, ".gitconfig")} < x`), [join(home, ".gitconfig")]);
		assert.deepEqual(targets(`cp x ${join(project, ".git", "hooks", "pre-commit")}`), [join(project, ".git", "hooks", "pre-commit")]);
		assert.deepEqual(targets(`sed -i 's/a/b/' ${join(home, ".config", "gh", "hosts.yml")}`), [join(home, ".config", "gh", "hosts.yml")]);
		assert.deepEqual(targets(`ln -s x ${join(home, ".bashrc")}`), [join(home, ".bashrc")]);
		assert.deepEqual(targets(`mv x ${join(home, ".pi", "agent", "brigadev.json")}`), [join(home, ".pi", "agent", "brigadev.json")]);
	});

	it("finds deletions", () => {
		assert.deepEqual(targets(`rm ${join(home, ".zshrc")}`), [join(home, ".zshrc")]);
		assert.deepEqual(targets(`rm -rf ${join(home, ".pi")}`), [join(home, ".pi")]);
	});

	it("resolves relative names and literal cd", () => {
		assert.deepEqual(targets("echo x > .git/hooks/pre-push"), [join(project, ".git", "hooks", "pre-push")]);
		assert.deepEqual(targets("cd .git && echo x > config"), [join(project, ".git", "config")]);
		assert.deepEqual(targets("echo x > ~/.zshrc"), [join(home, ".zshrc")]);
	});

	it("ignores writes to ordinary files and reads", () => {
		assert.deepEqual(targets("echo x > out.txt && cat ~/.zshrc"), []);
		assert.deepEqual(targets(`cat ${join(home, ".gitconfig")}`), []);
	});

	it("reports the audit log as such", () => {
		const found = bashProtectedTargets(`echo '{}' >> ${join(home, ".brigadev", "repo", "audit", "dsp.jsonl")}`, project, ctx);
		assert.deepEqual(found.map((t) => t.kind), ["audit"]);
	});
});
