// What the runner requires of a feature document before it starts: the shared S7 rules plus the runner-only ones.
import { parseTicketList, validateForRun } from "../../lib/ticket-list.ts";

/** Every reason the document cannot run unattended here; empty when it can. */
export function validateDoc(text: string): string[] {
	const list = parseTicketList(text);
	const errors = validateForRun(list);
	for (const ticket of list.tickets) {
		const unfinished = ticket.status !== "done" && ticket.status !== "dropped";
		// The runner can only run commands: an observable-outcome check has no one to evaluate it.
		if (unfinished && ticket.done && !ticket.doneIsCommand) errors.push(`${ticket.id} done: is not a command`);
	}
	// Every finished ticket writes one `## Log` line; failing at the first ticket would be too late.
	if (!text.split("\n").some((line) => line.trim() === "## Log")) errors.push("the document has no ## Log section");
	return [...new Set(errors)];
}
