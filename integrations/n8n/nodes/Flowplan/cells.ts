// Record properties between n8n and Flowplan. Flowplan stores a record's
// values ("cells") by property id; in n8n people name them by their visible
// name. Kept free of n8n imports so it can be tested on its own.

export interface FlowplanField {
	id: string;
	name: string;
	type: string;
	options?: string[];
}

// Values Flowplan computes itself; they cannot be written.
export const COMPUTED_TYPES = [
	'formula',
	'rollup',
	'created_at',
	'updated_at',
	'created_by',
	'updated_by',
	'id',
	'progress',
	'time',
];

export const writableFields = (fields: FlowplanField[]) =>
	fields.filter((f) => !COMPUTED_TYPES.includes(f.type));

// The property for a key: its id, else its name (ignoring case).
export function findField(fields: FlowplanField[], key: string): FlowplanField | undefined {
	return (
		fields.find((f) => f.id === key) ||
		fields.find((f) => f.name.trim().toLowerCase() === key.trim().toLowerCase())
	);
}

const truthy = (value: string) => ['true', '1', 'yes', 'ja', 'x', 'on'].includes(value.trim().toLowerCase());
const list = (value: string) =>
	value
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);

// A value typed as text in the node (e.g. "Define Below") in the form the
// property expects: numbers, booleans and lists.
export function coerceValue(field: FlowplanField, value: unknown): unknown {
	if (typeof value !== 'string') return value;
	switch (field.type) {
		case 'number':
			return value.trim() === '' ? null : Number(value.replace(',', '.'));
		case 'checkbox':
			return truthy(value);
		case 'multiselect':
		case 'relation':
			return list(value);
		case 'checklist':
		case 'files':
			if (value.trim() === '') return field.type === 'files' ? '' : [];
			return JSON.parse(value);
		default:
			return value;
	}
}

// { "Name": "…", "status-id": "Done" } → { "<id of Name>": "…", "status-id": "Done" }
export function cellsToIds(
	fields: FlowplanField[],
	input: Record<string, unknown>,
	coerce = false,
): Record<string, unknown> {
	const cells: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const field = findField(fields, key);
		if (!field) throw new Error(`Unknown property "${key}". Known: ${fields.map((f) => f.name).join(', ')}`);
		if (COMPUTED_TYPES.includes(field.type))
			throw new Error(`The property "${field.name}" is computed by Flowplan and cannot be set.`);
		cells[field.id] = coerce ? coerceValue(field, value) : value;
	}
	return cells;
}

// Cells by property name for the output (unknown ids are kept as they are).
export function cellsToNames(fields: FlowplanField[], cells: Record<string, unknown>) {
	const named: Record<string, unknown> = {};
	for (const [id, value] of Object.entries(cells || {})) {
		const field = fields.find((f) => f.id === id);
		named[field ? field.name : id] = value;
	}
	return named;
}

// Search snippets mark hits with control characters; plain text for n8n.
export const plainSnippet = (text: string) =>
	(text || '').split(String.fromCharCode(2)).join('').split(String.fromCharCode(3)).join('');
