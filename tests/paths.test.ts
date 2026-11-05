import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { canonicalPath, isInside } from "../lib/paths.ts";

describe("paths", () => {
	let base: string;
	let real: string;
	let link: string;
	before(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-paths-")));
		real = join(base, "real-project");
		link = join(base, "linked-project");
		mkdirSync(join(real, "src"), { recursive: true });
		symlinkSync(real, link);
	});
	after(() => rmSync(base, { recursive: true, force: true }));

	it("treats a path through a symlinked root as inside the project (macOS /tmp -> /private/tmp)", () => {
		assert.equal(isInside(canonicalPath(real), canonicalPath(join(link, "src", "a.ts"))), true);
		assert.equal(isInside(canonicalPath(link), canonicalPath(join(real, "src", "a.ts"))), true);
	});

	it("canonicalizes files that do not exist yet through their nearest existing parent", () => {
		assert.equal(canonicalPath(join(link, "src", "new", "file.ts")), join(real, "src", "new", "file.ts"));
	});

	it("still rejects real escapes", () => {
		assert.equal(isInside(canonicalPath(real), canonicalPath(join(link, "..", "outside.ts"))), false);
		assert.equal(isInside(canonicalPath(real), canonicalPath(join(base, "real-project-other", "x.ts"))), false);
		assert.equal(isInside(canonicalPath(real), canonicalPath(real)), true);
	});
});
