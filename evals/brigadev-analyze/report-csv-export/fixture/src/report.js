// Report rows ({ id, name, total }) in the formats the export menu offers.
export function toJSON(rows) {
	return JSON.stringify(rows.map(({ id, name, total }) => ({ id, name, total })));
}
