import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backstopThreshold, createContextBackstop } from "../lib/context-backstop.ts";

describe("context backstop", () => {
	it("uses the smaller of 150k tokens and half the context window", () => {
		assert.equal(backstopThreshold(1_000_000), 150_000);
		assert.equal(backstopThreshold(200_000), 100_000);
	});

	it("stays quiet below the threshold and for unknown usage", () => {
		const backstop = createContextBackstop();
		assert.equal(backstop.check({ tokens: 99_999, contextWindow: 200_000 }), undefined);
		assert.equal(backstop.check({ tokens: null, contextWindow: 200_000 }), undefined);
		assert.equal(backstop.check(undefined), undefined);
	});

	it("fires once per crossing and names the fresh worker", () => {
		const backstop = createContextBackstop();
		const notice = backstop.check({ tokens: 100_000, contextWindow: 200_000 });
		assert.match(notice ?? "", /brigadev-worker/);
		assert.equal(backstop.check({ tokens: 120_000, contextWindow: 200_000 }), undefined);
	});

	it("re-arms after compaction", () => {
		const backstop = createContextBackstop();
		backstop.check({ tokens: 100_000, contextWindow: 200_000 });
		backstop.rearm();
		assert.equal(backstop.check({ tokens: 40_000, contextWindow: 200_000 }), undefined);
		assert.ok(backstop.check({ tokens: 100_000, contextWindow: 200_000 }));
	});
});
