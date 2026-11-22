// What `runner.ticketRuns` remembers between the board's refreshes (R4-001), per loop, bounded.
//
// pi-durable's task scan has no owner filter, so the tasks of one loop cannot be asked for: the scan walks the store's ticket tasks newest first. Task ids only grow, and
// a task is final once it ended (a ticket's outcome never changes, and a task's owner never does), so a loop keeps a `mark`: every ticket and PR task of this loop with an id
// at or below it is final and its run is in `final`. A refresh scans down to the mark and no further: what it reads is what happened since, not the store's history.
import type { TaskId } from "@earendil-works/pi-durable";
import type { TicketRun } from "./runner.ts";

export interface LoopRuns {
	/** The loop's task id. Nothing of it has an id below this. */
	readonly loopId: number;
	/** Every ticket and PR task of the loop with an id at or below the mark is final and accounted for. */
	mark: number;
	/** The loop and its PR loop tasks: the owners of the tickets that are the loop's. */
	owners: Set<number>;
	/** Finished runs by ticket task id: each is read once. Below the mark only the latest run of each ticket is kept. */
	final: Map<number, TicketRun>;
}

export interface RunsCacheOptions {
	/** Loops remembered (default 8); the least recently used is dropped first. */
	maxLoops?: number;
	/** Finished runs kept per loop (default 1,000); past it the loop starts over, which is correct and only slower. */
	maxRuns?: number;
}

export class RunsCache {
	readonly #loops = new Map<number, LoopRuns>();
	readonly #maxLoops: number;
	readonly #maxRuns: number;

	constructor(options: RunsCacheOptions = {}) {
		this.#maxLoops = options.maxLoops ?? 8;
		this.#maxRuns = options.maxRuns ?? 1_000;
	}

	get size(): number {
		return this.#loops.size;
	}

	/** The loop ids held, least recently used first. */
	loops(): number[] {
		return [...this.#loops.keys()];
	}

	/** The loop's entry (a new one when it has none), marked as the most recently used. */
	of(loopId: TaskId): LoopRuns {
		const id = Number(loopId);
		let loop = this.#loops.get(id);
		if (loop) this.#loops.delete(id);
		else loop = { loopId: id, mark: id, owners: new Set([id]), final: new Map() };
		this.#loops.set(id, loop);
		while (this.#loops.size > this.#maxLoops) this.#loops.delete(this.#loops.keys().next().value as number);
		return loop;
	}

	/** After an update: a loop that outgrew its bound starts over from its own id. */
	settle(loop: LoopRuns): void {
		if (loop.final.size <= this.#maxRuns) return;
		loop.final.clear();
		loop.owners = new Set([loop.loopId]);
		loop.mark = loop.loopId;
	}
}
