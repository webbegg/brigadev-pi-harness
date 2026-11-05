import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export type AgentSource = "package" | "user" | "project";

export interface AgentDefinition {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	/** Writers must receive allowed edit surfaces; they may edit files. */
	writer: boolean;
	/** "risk": launch requires a named high-risk item in the reason. */
	admission?: "risk";
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export type FrontmatterParser = (content: string) => { frontmatter: Record<string, unknown>; body: string };

function toolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

export function parseAgent(content: string, filePath: string, source: AgentSource, parse: FrontmatterParser): AgentDefinition | undefined {
	const { frontmatter, body } = parse(content);
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: toolList(frontmatter.tools),
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
		writer: frontmatter.writer === true,
		admission: frontmatter.admission === "risk" ? "risk" : undefined,
		systemPrompt: body,
		source,
		filePath,
	};
}

function loadDir(dir: string, source: AgentSource, parse: FrontmatterParser): AgentDefinition[] {
	if (!existsSync(dir)) return [];
	const agents: AgentDefinition[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md") || !(entry.isFile() || entry.isSymbolicLink())) continue;
		const filePath = join(dir, entry.name);
		try {
			const agent = parseAgent(readFileSync(filePath, "utf8"), filePath, source, parse);
			if (agent) agents.push(agent);
		} catch {
			// One malformed definition must not hide the others.
		}
	}
	return agents;
}

function nearestProjectAgentsDir(cwd: string): string | undefined {
	let dir = cwd;
	while (true) {
		const candidate = join(dir, ".pi", "agents");
		try {
			if (statSync(candidate).isDirectory()) return candidate;
		} catch {
			// keep walking up
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export interface DiscoveryOptions {
	packageAgentsDir: string;
	userAgentsDir: string;
	cwd: string;
	includeProject: boolean;
	parse: FrontmatterParser;
}

/** Later sources override earlier ones by name: package < user < project. */
export function discoverAgents(options: DiscoveryOptions): AgentDefinition[] {
	const byName = new Map<string, AgentDefinition>();
	const projectDir = options.includeProject ? nearestProjectAgentsDir(options.cwd) : undefined;
	const layers: Array<[string | undefined, AgentSource]> = [
		[options.packageAgentsDir, "package"],
		[options.userAgentsDir, "user"],
		[projectDir, "project"],
	];
	for (const [dir, source] of layers) {
		if (!dir) continue;
		for (const agent of loadDir(dir, source, options.parse)) byName.set(agent.name, agent);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
