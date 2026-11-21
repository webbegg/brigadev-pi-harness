// The PR loop's verify step (S2b): an independent, read-only conversation over `assets/agents/brigadev-verify.md`, run only when the risk
// map says T2. Read-only is the guard's job (src/guard.ts reads `RoleDoc`): the verify conversation has `read`, `bash`, and the verdict tool,
// no write/edit, and its bash cannot commit, change git state, or write inside the worktree.
//
// It ends through a terminating verdict tool, the pattern of src/decision.ts: the tool records the verdict in a conversation document and returns
// `control: { terminate: true }`; the PR loop reads the document instead of parsing text. The tool's shape is `assets/agents/brigadev-verify.schema.json`
// (the extension's `structured_output` payload), checked with lib/structured-output.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineDoc, defineTool } from "@earendil-works/pi-durable";
import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { parseAgent } from "../../lib/agents.ts";
import { loadOutputSchema, validateAgainstSchema } from "../../lib/structured-output.ts";
import { parseFrontmatter } from "./worker.ts";

export const VERIFY_AGENT_PATH = fileURLToPath(new URL("../../assets/agents/brigadev-verify.md", import.meta.url));
export const VERIFY_SCHEMA_PATH = fileURLToPath(new URL("../../assets/agents/brigadev-verify.schema.json", import.meta.url));

export const VERDICT_TOOL = "verify_verdict";
/** What a verify conversation may call; the guard blocks everything else. */
export const VERIFY_TOOLS: readonly string[] = ["read", "bash", VERDICT_TOOL];

// ---------------------------------------------------------------------------------------------------------------------
// Role: which rules the guard applies to a conversation

type RoleState = { role: string };

/** The role of a conversation (`""`: the ticket worker). Written when the PR loop creates the verify conversation. */
export const RoleDoc = defineDoc<RoleState>({
	kind: "brigadev.role",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ role: "" }),
	checkpointWhen: () => true,
});
export const VERIFY_ROLE = "verify";

// ---------------------------------------------------------------------------------------------------------------------
// The verdict

export interface Blocker {
	summary: string;
	reproduction: string;
	spec?: string;
}
export interface Verdict {
	verdicts: Array<{ spec: string; verdict: string; evidence: string }>;
	blockers: Blocker[];
	advisories: Array<{ summary: string; reproduction: string }>;
	regressionTests: Array<{ path: string; covers: string; reproduction?: string; content?: string }>;
	scratch: string[];
	unverified: string[];
}

type VerdictState = { recorded: boolean; json: string };

/** The verdict a verify conversation recorded (`recorded: false` until it does). A document holds JSON, so the verdict is its text. */
export const VerdictDoc = defineDoc<VerdictState>({
	kind: "brigadev.verdict",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ recorded: false, json: "" }),
	checkpointWhen: () => true,
});

export function verdictOf(state: Readonly<VerdictState> | undefined): Verdict | undefined {
	if (!state?.recorded) return undefined;
	try {
		return JSON.parse(state.json) as Verdict;
	} catch {
		return undefined;
	}
}

const Parameters = obj({
	verdicts: arr(obj({ spec: str({ minLength: 1 }), verdict: oneOf(["met", "unmet", "not implemented", "out of scope", "unverified"]), evidence: str({ minLength: 1 }) }), { minItems: 1, description: "One verdict per in-scope spec item (S# or A#)" }),
	blockers: arr(obj({ summary: str({ minLength: 1 }), reproduction: str({ minLength: 1 }), spec: opt(str()) }), { description: "Defects the change caused, or in-scope items left unmet, each with its reproduction; empty when there are none" }),
	advisories: arr(obj({ summary: str({ minLength: 1 }), reproduction: str({ minLength: 1 }) })),
	regressionTests: arr(obj({ path: str({ minLength: 1 }), covers: str({ minLength: 1 }), reproduction: opt(str()), content: opt(str()) })),
	scratch: arr(str(), { description: "Exact scratch directories you created" }),
	unverified: arr(str(), { description: "Checks left unverified, each with the reason and the missing command" }),
});

const text = (value: string) => [{ type: "text" as const, text: value }];

let schemaCache: ReturnType<typeof loadOutputSchema> | undefined;

export function createVerdictTool() {
	return defineTool({
		name: VERDICT_TOOL,
		description:
			"Return your verification result: call it once, last. Calling it ends your run. blockers lists every defect the change caused or in-scope item left unmet (each with a reproduction); leave it empty only when you found none.",
		parameters: Parameters,
		replay: "safe",
		async execute(args, api, context) {
			// The extension's schema file is the contract; the builder above only gives the model the shape.
			schemaCache ??= loadOutputSchema(VERIFY_SCHEMA_PATH);
			if ("error" in schemaCache) return { isError: true, output: text(`Error: ${schemaCache.error}`) };
			const errors = validateAgainstSchema(schemaCache.schema, JSON.parse(JSON.stringify(args)));
			if (errors.length > 0) return { isError: true, output: text(`Error: the verdict does not match its schema:\n${errors.join("\n")}`) };
			await api.commit(async (tx) => {
				const doc = await tx.doc(VerdictDoc, api.conversationId);
				if (doc.recorded) return; // the first verdict stands; a rerun of this call finds it recorded
				doc.recorded = true;
				doc.json = JSON.stringify(args);
			}, context);
			return { output: text("Your verdict is recorded. Make no further tool calls."), control: { terminate: true } };
		},
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// Prompts

export interface Verifier {
	systemPrompt: string;
}

export function loadVerifier(path = VERIFY_AGENT_PATH): Verifier {
	const agent = parseAgent(readFileSync(path, "utf8"), path, "package", parseFrontmatter);
	if (!agent) throw new Error(`${path} is not a valid agent definition`);
	return { systemPrompt: agent.systemPrompt.trim() };
}

export interface VerifyBrief {
	docPath: string;
	branch: string;
	/** The base branch the PR will target; undefined when unknown. */
	base?: string;
	round: number;
}

/** System instructions: the verifier prompt, what differs when the runner drives it, and the target. */
export function verifyInstructions(verifier: Verifier, brief: VerifyBrief): string {
	return [
		verifier.systemPrompt,
		"",
		"## Runner mode",
		"You are driven by the unattended brigadev runner, which opens a PR for this branch next. You are read-only: your tools are `read` and `bash` (probes, setup, builds) and the verdict tool. You have no write or edit tool, and the guard blocks `git commit` and every git command that changes state, and any bash write inside the worktree: run probes in a scratch copy as described above.",
		`Return by calling \`${VERDICT_TOOL}\` once, last (this runner's \`structured_output\`): its fields are the ones described above. That call ends your run. A blocker is turned into a fix ticket whose instructions are your summary and reproduction, so write each reproduction as a command and the failing line.`,
		"There is no skill or sub-agent to load, and no one to answer questions.",
		"",
		"## Target",
		`- feature document: ${brief.docPath} (read it from the top until \`## Log\`; its \`S#\` are the spec items)`,
		`- branch: ${brief.branch}${brief.base ? ` (to be merged into ${brief.base}: \`git diff ${brief.base}...HEAD\` is the change)` : ""}`,
		`- verify round: ${brief.round}`,
	].join("\n");
}

export const verifyInput = (brief: VerifyBrief): string =>
	`Verify the changes of branch ${brief.branch} against the feature document ${brief.docPath} (round ${brief.round}). Report through \`${VERDICT_TOOL}\`.`;

/** The blockers as the fix ticket's spec: each with its reproduction, and the rule that a repro test goes RED to GREEN. */
export function blockersSpec(blockers: readonly Blocker[]): string {
	return [
		"The independent verifier found these blockers in the branch. Fix every one:",
		...blockers.flatMap((blocker, index) => [`${index + 1}. ${blocker.summary}${blocker.spec ? ` (${blocker.spec})` : ""}`, `   reproduction: ${blocker.reproduction}`]),
	].join("\n");
}
