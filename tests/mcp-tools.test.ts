// lib/mcp-tools.ts: MCP tools that deliver or publish (open a PR, merge, push, write to an issue or PR) are classified like the gh/git commands they stand for.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMAND_KIND } from "../lib/command-classifier.ts";
import { classifyMcpTool, mcpToolParts } from "../lib/mcp-tools.ts";
import { decideCommand, PERMISSION_MODE } from "../lib/permission-policy.ts";

describe("mcpToolParts", () => {
	it("splits Pi's `mcp__<server>__<tool>` names, server names with dashes or underscores included", () => {
		assert.deepEqual(mcpToolParts("mcp__t3-code__pull_request_create"), { server: "t3-code", tool: "pull_request_create" });
		assert.deepEqual(mcpToolParts("mcp__t3_code__pull_request_merge"), { server: "t3_code", tool: "pull_request_merge" });
		assert.deepEqual(mcpToolParts("mcp__github__create_pull_request"), { server: "github", tool: "create_pull_request" });
	});

	it("is undefined for tools that are not MCP tools", () => {
		for (const name of ["bash", "pull_request_create", "mcp__only", "mcp____x", "xmcp__a__b"]) assert.equal(mcpToolParts(name), undefined, name);
	});
});

describe("classifyMcpTool", () => {
	it("opening a PR is a delivery that always asks, and carries the PR gate", () => {
		for (const name of ["mcp__t3-code__pull_request_create", "mcp__t3_code__pull_request_create", "mcp__github__create_pull_request"]) {
			const match = classifyMcpTool(name);
			assert.equal(match?.kind, COMMAND_KIND.DELIVERY, name);
			assert.equal(match?.alwaysConfirm, true, name);
			assert.equal(match?.opensPr, true, name);
		}
	});

	it("merging a PR is a publish (asks in every mode, like gh pr merge)", () => {
		for (const name of ["mcp__t3-code__pull_request_merge", "mcp__github__merge_pull_request"]) {
			assert.equal(classifyMcpTool(name)?.kind, COMMAND_KIND.PUBLISH, name);
			assert.equal(classifyMcpTool(name)?.opensPr, undefined, name);
		}
	});

	it("pushing files to a remote always asks, like git push", () => {
		for (const name of ["mcp__github__push_files", "mcp__github__create_or_update_file", "mcp__github__delete_file"]) {
			const match = classifyMcpTool(name);
			assert.equal(match?.kind, COMMAND_KIND.DELIVERY, name);
			assert.equal(match?.alwaysConfirm, true, name);
		}
	});

	it("PR and issue writes are ordinary deliveries (normal asks, yolo runs), like gh pr comment", () => {
		for (const name of ["mcp__t3-code__pull_request_review", "mcp__t3-code__pull_request_respond", "mcp__t3-code__pull_request_update", "mcp__github__add_issue_comment", "mcp__github__create_issue"]) {
			const match = classifyMcpTool(name);
			assert.equal(match?.kind, COMMAND_KIND.DELIVERY, name);
			assert.ok(!match?.alwaysConfirm, name);
			assert.equal(decideCommand([match!], PERMISSION_MODE.YOLO, false).action, "allow", name);
			assert.equal(decideCommand([match!], PERMISSION_MODE.NORMAL, false).action, "confirm", name);
		}
	});

	it("names the tool and its server in the reason", () => {
		assert.match(classifyMcpTool("mcp__t3-code__pull_request_create")!.reason, /pull_request_create.*t3-code/);
	});

	it("reads, links, watches, and non-MCP tools are not classified", () => {
		for (const name of ["mcp__t3-code__pull_request_read", "mcp__t3-code__link_pull_request", "mcp__t3-code__watch_pull_request", "mcp__t3-code__delegate_task", "mcp__github__get_pull_request", "bash", "create_pull_request"]) {
			assert.equal(classifyMcpTool(name), undefined, name);
		}
	});
});
