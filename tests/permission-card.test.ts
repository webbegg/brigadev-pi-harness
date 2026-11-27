// lib/permission-card.ts: the guard's permission card in the TUI, folded by default, its details behind `d`, and its keys.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { classifyCommand } from "../lib/command-classifier.ts";
import { commandDialog } from "../lib/permission-dialog.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

let uninstall: () => void;
let card: typeof import("../lib/permission-card.ts");
before(async () => {
	uninstall = installPiStubs();
	card = await import("../lib/permission-card.ts");
});
after(() => uninstall());

const plain = { paint: (_tone: string, text: string) => text, bold: (text: string) => text, measure: (text: string) => Array.from(text).length };
const dialogFor = (command: string) => commandDialog(command, classifyCommand(command));
const FORCE = "# why: the release branch was rebased on main\ngit push --force origin main && rm -rf build";

describe("renderPermissionCard", () => {
	it("folded: the panel holds the action, what happens, why, the risk, and the command; the details stay hidden", () => {
		const lines = card.renderPermissionCard(dialogFor(FORCE).card, { expanded: false, choice: 0 }, 80, plain);
		assert.deepEqual(lines, [
			"╭─ brigadev · Needs your permission ───────────────────────────────────────────╮",
			"│                                                                              │",
			"│  Rewrite or delete remote branches + delete or overwrite data                │",
			"│                                                                              │",
			"│  Force-pushes or deletes refs on the remote repository; deletes or           │",
			"│  overwrites data.                                                            │",
			"│                                                                              │",
			"│  Why    the release branch was rebased on main                               │",
			"│  Risk   ● High · hard to undo · affects everyone who uses the remote         │",
			"│                                                                              │",
			"│  $ git push --force origin main && rm -rf build                              │",
			"│                                                                              │",
			"│  ▸ Show details  (d)                                                         │",
			"│                                                                              │",
			"╰──────────────────────────────────────────────────────────────────────────────╯",
			"   Run it?",
			"   › Yes",
			"     No",
			"   ↑↓ choose · enter answer · d details · esc no",
		]);
	});

	it("every line fits the width, folded and open, and the open card shows the full sections", () => {
		const dialog = dialogFor(FORCE);
		for (const width of [40, 61, 80, 120]) {
			for (const expanded of [false, true]) {
				const lines = card.renderPermissionCard(dialog.card, { expanded, choice: 1 }, width, plain);
				for (const line of lines) assert.ok(plain.measure(line) <= width, `${width}: ${JSON.stringify(line)}`);
				const boxed = lines.filter((line) => line.startsWith("│"));
				for (const line of boxed) assert.equal(plain.measure(line), width, `${width}: ${JSON.stringify(line)}`);
			}
		}
		const open = card.renderPermissionCard(dialog.card, { expanded: true, choice: 1 }, 130, plain).join("\n");
		assert.match(open, /▾ Hide details  \(d\)/);
		assert.match(open, /┊ WHAT IT WILL DO/);
		assert.match(open, /┊   Force-pushes or deletes refs on the remote repository \(git push rewrites or deletes remote refs\)\./);
		assert.match(open, /┊ RISK  ● High/);
		assert.match(open, /┊     Can it be undone\?   Hard: only if someone still has the old commits\./);
		assert.match(open, /\n   › No\n/);
	});

	it("a narrow terminal drops the border, never the text", () => {
		const lines = card.renderPermissionCard(dialogFor(FORCE).card, { expanded: false, choice: 0 }, 24, plain);
		assert.ok(!lines.some((line) => /[╭╰│]/.test(line)));
		assert.ok(lines.join("\n").includes("Why    the release"));
		for (const line of lines) assert.ok(plain.measure(line) <= 24, JSON.stringify(line));
	});

	it("colors the border by the risk level, and a missing reason as a warning", () => {
		const tones: string[] = [];
		const painter = { ...plain, paint: (tone: string, text: string) => (tones.push(`${tone}:${text}`), text) };
		card.renderPermissionCard(dialogFor("rm -rf build").card, { expanded: false, choice: 0 }, 80, painter);
		assert.ok(tones.some((t) => t.startsWith("error:╭─")));
		assert.ok(tones.some((t) => /^warning:⚠ The agent did not say why/.test(t)));
		tones.length = 0;
		card.renderPermissionCard(dialogFor("gh pr create --fill").card, { expanded: false, choice: 0 }, 80, painter);
		assert.ok(tones.some((t) => t.startsWith("success:╭─")));
	});

	it("shows the PR gate's reasons folded too", () => {
		const command = "gh pr create --fill";
		const dialog = commandDialog(command, classifyCommand(command), "PR risk gate:\n- no passing test recorded for the committed HEAD");
		const lines = card.renderPermissionCard(dialog.card, { expanded: false, choice: 0 }, 90, plain).join("\n");
		assert.match(lines, /│  PR risk gate: +│\n│  - no passing test recorded for the committed HEAD +│/);
	});

	it("offers the session yes, and says what it covers while it is picked", () => {
		const dialog = dialogFor("gh pr create --fill");
		const options = card.cardOptions(dialog.card).map((o) => o.label);
		assert.deepEqual(options, ["Yes", "Yes, and don't ask again this session", "No"]);
		const picked = card.renderPermissionCard(dialog.card, { expanded: false, choice: 1 }, 80, plain).join("\n");
		assert.match(picked, /› Yes, and don't ask again this session  \(s\)\n {7}Stops asking about: open a pull request\./);
		assert.match(picked, /d details · s session · esc no/);
		const unpicked = card.renderPermissionCard(dialog.card, { expanded: false, choice: 0 }, 80, plain).join("\n");
		assert.doesNotMatch(unpicked, /Stops asking about/);
	});
});

describe("cardKey", () => {
	const offered = dialogFor("gh pr create --fill").card;
	const high = dialogFor("rm -rf build").card;

	it("moves through the answers, toggles the details, and answers", () => {
		let state = { expanded: false, choice: 0 };
		const step = (key: Parameters<typeof card.cardKey>[2]) => {
			const next = card.cardKey(offered, state, key);
			assert.ok("state" in next);
			state = next.state;
		};
		step("down");
		assert.equal(state.choice, 1);
		step("down");
		step("down");
		assert.equal(state.choice, 0, "wraps around");
		step("up");
		assert.equal(state.choice, 2);
		step("details");
		assert.equal(state.expanded, true);
		assert.deepEqual(card.cardKey(offered, state, "enter"), { answer: "no" });
		assert.deepEqual(card.cardKey(offered, { expanded: false, choice: 1 }, "enter"), { answer: "session" });
		assert.deepEqual(card.cardKey(offered, state, "yes"), { answer: "yes" });
		assert.deepEqual(card.cardKey(offered, state, "escape"), { answer: null });
	});

	it("a card that does not offer the session yes ignores `s`", () => {
		assert.deepEqual(card.cardKey(high, { expanded: false, choice: 0 }, "session"), { state: { expanded: false, choice: 0 } });
		assert.deepEqual(card.cardOptions(high).map((o) => o.answer), ["yes", "no"]);
		assert.deepEqual(card.cardKey(high, { expanded: false, choice: 1 }, "enter"), { answer: "no" });
	});
});

describe("showPermissionCard", () => {
	it("resolves with the key's answer, and an abort closes it as dismissed", async () => {
		const host = (keys: string[]) => ({
			custom: async (factory: Function) => {
				let result: unknown;
				const component = factory({ requestRender: () => {} }, { fg: (_t: string, s: string) => s, bold: (s: string) => s }, {}, (value: unknown) => (result = value));
				component.render(80);
				for (const key of keys) if (result === undefined) component.handleInput(key);
				return result;
			},
		});
		const dialog = dialogFor("gh pr create --fill");
		assert.equal(await card.showPermissionCard(host(["d", "x", "y"]) as never, dialog.title, dialog.card), "yes");
		assert.equal(await card.showPermissionCard(host(["down", "enter"]) as never, dialog.title, dialog.card), "session");
		assert.equal(await card.showPermissionCard(host(["escape"]) as never, dialog.title, dialog.card), null);
		const aborted = new AbortController();
		aborted.abort();
		assert.equal(await card.showPermissionCard(host(["y"]) as never, dialog.title, dialog.card, aborted.signal), null);

		const run = new AbortController();
		let done: ((value: unknown) => void) | undefined;
		const pending = card.showPermissionCard({ custom: (factory: Function) => new Promise((resolve) => factory({ requestRender: () => {} }, { fg: (_t: string, s: string) => s, bold: (s: string) => s }, {}, (done = resolve))) } as never, dialog.title, dialog.card, run.signal);
		assert.ok(done);
		run.abort();
		assert.equal(await pending, null);
	});
});
