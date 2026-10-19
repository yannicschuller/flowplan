import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { bootstrap, flowplanCommand, flowplanRequest } from './GenericFunctions';
import { cellsToIds, cellsToNames, plainSnippet, writableFields, type FlowplanField } from './cells';

interface Row {
	id: string;
	number?: number;
	version: number;
	cells: Record<string, unknown>;
	created_at?: string;
	updated_at?: string;
	access?: string;
	[key: string]: unknown;
}
interface PageResponse {
	page: IDataObject & { id: string; title: string; kind: string };
	role?: string;
	html?: string;
	database?: { fields: FlowplanField[]; version: number };
	rows?: Row[];
	locked?: unknown;
	[key: string]: unknown;
}

const show = (resource: string, operation?: string[]) => ({
	show: operation ? { resource: [resource], operation } : { resource: [resource] },
});

// A record for n8n: id and metadata, the values by property name (or id).
function recordOutput(row: Row, fields: FlowplanField[], byName: boolean, databaseId: string): IDataObject {
	return {
		id: row.id,
		databaseId,
		number: row.number ?? null,
		version: row.version,
		createdAt: row.created_at ?? null,
		updatedAt: row.updated_at ?? null,
		properties: (byName ? cellsToNames(fields, row.cells) : row.cells) as IDataObject,
	};
}

async function loadDatabase(this: IExecuteFunctions, databaseId: string) {
	const data = (await flowplanRequest.call(this, 'GET', `/api/pages/${encodeURIComponent(databaseId)}`)) as PageResponse;
	if (data.page?.kind !== 'database' || !data.database)
		throw new NodeOperationError(this.getNode(), `The page ${databaseId} is not a database.`);
	return { page: data.page, fields: data.database.fields, rows: data.rows || [] };
}

// Properties given as JSON or one by one ("Define Below"), by name or id.
function recordCells(this: IExecuteFunctions, i: number, fields: FlowplanField[]) {
	const mode = this.getNodeParameter('propertiesMode', i) as string;
	if (mode === 'json') {
		const raw = this.getNodeParameter('propertiesJson', i) as string | IDataObject;
		const input = typeof raw === 'string' ? (JSON.parse(raw || '{}') as IDataObject) : raw;
		return cellsToIds(fields, input);
	}
	const pairs = (this.getNodeParameter('properties.property', i, []) as { name: string; value: string }[]) || [];
	return cellsToIds(
		fields,
		Object.fromEntries(pairs.map((p) => [p.name, p.value])),
		true,
	);
}

export class Flowplan implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Flowplan',
		name: 'flowplan',
		icon: { light: 'file:flowplan.svg', dark: 'file:flowplan.svg' },
		group: ['input', 'output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Read and write pages and database records in Flowplan',
		defaults: { name: 'Flowplan' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'flowplanApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Database Record', value: 'record' },
					{ name: 'Page', value: 'page' },
					{ name: 'Search', value: 'search' },
					{ name: 'Workspace', value: 'workspace' },
				],
				default: 'record',
			},
			// ---- Operations ----
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: show('workspace'),
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List the workspaces the API token’s owner belongs to',
						action: 'Get many workspaces',
					},
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: show('page'),
				options: [
					{ name: 'Create', value: 'create', description: 'Create a page', action: 'Create a page' },
					{ name: 'Get', value: 'get', description: 'Get a page with its content', action: 'Get a page' },
					{ name: 'Get Many', value: 'getAll', description: 'List the pages of a workspace', action: 'Get many pages' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: show('record'),
				options: [
					{ name: 'Create', value: 'create', description: 'Create a record in a database', action: 'Create a database record' },
					{ name: 'Get', value: 'get', description: 'Get a record of a database', action: 'Get a database record' },
					{ name: 'Get Many', value: 'getAll', description: 'List the records of a database', action: 'Get many database records' },
					{ name: 'Update', value: 'update', description: 'Change properties of a record', action: 'Update a database record' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: show('search'),
				options: [
					{
						name: 'Search',
						value: 'search',
						description: 'Full-text search in a workspace (pages, records, comments, files)',
						action: 'Search a workspace',
					},
				],
				default: 'search',
			},
			// ---- Workspace (pages and search) ----
			{
				displayName: 'Workspace Name or ID',
				name: 'workspaceId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getWorkspaces' },
				required: true,
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: { show: { resource: ['page', 'search'] } },
			},
			// ---- Page ----
			{
				displayName: 'Page ID',
				name: 'pageId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. 3f0c…',
				description: 'The ID of the page (the last part of its address in Flowplan)',
				displayOptions: show('page', ['get']),
			},
			{
				displayName: 'Simplify',
				name: 'simplify',
				type: 'boolean',
				default: true,
				description: 'Whether to return only the page, its HTML content and (for databases) its properties instead of the raw response',
				displayOptions: show('page', ['get']),
			},
			{
				displayName: 'Space Name or ID',
				name: 'spaceId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getSpaces', loadOptionsDependsOn: ['workspaceId'] },
				required: true,
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: show('page', ['create']),
			},
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				required: true,
				default: '',
				displayOptions: show('page', ['create']),
			},
			{
				displayName: 'Kind',
				name: 'kind',
				type: 'options',
				options: [
					{ name: 'Database', value: 'database' },
					{ name: 'Document', value: 'document' },
					{ name: 'Whiteboard', value: 'whiteboard' },
				],
				default: 'document',
				displayOptions: show('page', ['create']),
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: show('page', ['create']),
				options: [
					{
						displayName: 'Content',
						name: 'content',
						type: 'string',
						typeOptions: { rows: 6 },
						default: '',
						description: 'Text of a new document, in the format chosen below',
					},
					{
						displayName: 'Content Format',
						name: 'format',
						type: 'options',
						options: [
							{ name: 'Markdown', value: 'markdown' },
							{ name: 'HTML', value: 'html' },
							{ name: 'Plain Text', value: 'text' },
						],
						default: 'markdown',
					},
					{
						displayName: 'Parent Page ID',
						name: 'parentId',
						type: 'string',
						default: '',
						description: 'Create the page below this page (in the same space)',
					},
				],
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: show('page', ['getAll']),
				options: [
					{
						displayName: 'Kind',
						name: 'kind',
						type: 'options',
						options: [
							{ name: 'Database', value: 'database' },
							{ name: 'Document', value: 'document' },
							{ name: 'Journal', value: 'journal' },
							{ name: 'Whiteboard', value: 'whiteboard' },
						],
						default: 'document',
					},
					{
						displayName: 'Space ID',
						name: 'spaceId',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Parent Page ID',
						name: 'parentId',
						type: 'string',
						default: '',
					},
				],
			},
			// ---- Database record ----
			{
				displayName: 'Database Name or ID',
				name: 'databaseId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getDatabases' },
				required: true,
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: show('record'),
			},
			{
				displayName: 'Record ID',
				name: 'recordId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: show('record', ['get', 'update']),
			},
			{
				displayName: 'Properties',
				name: 'propertiesMode',
				type: 'options',
				options: [
					{ name: 'Define Below', value: 'fields', description: 'One property at a time; values are converted to the property’s type' },
					{ name: 'JSON', value: 'json', description: 'An object of property names (or IDs) and values' },
				],
				default: 'fields',
				displayOptions: show('record', ['create', 'update']),
			},
			{
				displayName: 'Properties',
				name: 'properties',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Property',
				default: {},
				displayOptions: { show: { resource: ['record'], operation: ['create', 'update'], propertiesMode: ['fields'] } },
				options: [
					{
						displayName: 'Property',
						name: 'property',
						values: [
							{
								displayName: 'Property Name or ID',
								name: 'name',
								type: 'options',
								typeOptions: { loadOptionsMethod: 'getFields', loadOptionsDependsOn: ['databaseId'] },
								default: '',
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								description:
									'Numbers, dates (YYYY-MM-DD), select options by their text, checkboxes as true/false, several options or related record IDs separated by commas',
							},
						],
					},
				],
			},
			{
				displayName: 'Properties (JSON)',
				name: 'propertiesJson',
				type: 'json',
				default: '{\n  "Name": "New record"\n}',
				description: 'Property names (or IDs) and their values, e.g. {"Name": "Call back", "Status": "Open", "Due": "2026-11-01"}',
				displayOptions: { show: { resource: ['record'], operation: ['create', 'update'], propertiesMode: ['json'] } },
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				description: 'Whether to return all results or only up to a given limit',
				displayOptions: { show: { resource: ['record', 'page', 'search'], operation: ['getAll', 'search'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['record', 'page', 'search'], operation: ['getAll', 'search'], returnAll: [false] } },
			},
			{
				displayName: 'Options',
				name: 'recordOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: show('record', ['get', 'getAll', 'create', 'update']),
				options: [
					{
						displayName: 'Output Property Names',
						name: 'byName',
						type: 'boolean',
						default: true,
						description: 'Whether to key the record’s values by property name (otherwise by property ID)',
					},
					{
						displayName: 'Include Content',
						name: 'content',
						type: 'boolean',
						default: false,
						description: 'Whether to add the HTML of the record’s page (only for Get)',
					},
				],
			},
			// ---- Search ----
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				required: true,
				default: '',
				displayOptions: show('search'),
			},
			{
				displayName: 'Search In',
				name: 'kind',
				type: 'options',
				options: [
					{ name: 'All', value: 'all' },
					{ name: 'Comments', value: 'comment' },
					{ name: 'Database Records', value: 'row' },
					{ name: 'Databases', value: 'database' },
					{ name: 'Documents', value: 'document' },
					{ name: 'Files', value: 'file' },
					{ name: 'Whiteboards', value: 'whiteboard' },
				],
				default: 'all',
				displayOptions: show('search'),
			},
		],
	};

	methods = {
		loadOptions: {
			async getWorkspaces(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await bootstrap.call(this);
				return data.workspaces.map((w) => ({ name: w.name, value: w.id }));
			},
			async getSpaces(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const workspaceId = this.getCurrentNodeParameter('workspaceId') as string;
				if (!workspaceId) return [];
				const data = await bootstrap.call(this, workspaceId);
				return data.spaces.filter((s) => !s.deleted_at).map((s) => ({ name: s.name, value: s.id }));
			},
			async getDatabases(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const first = await bootstrap.call(this);
				const options: INodePropertyOptions[] = [];
				for (const workspace of first.workspaces) {
					const data = workspace.id === first.workspace.id ? first : await bootstrap.call(this, workspace.id);
					for (const page of data.pages)
						if (page.kind === 'database' && !page.deleted_at)
							options.push({ name: `${workspace.name} › ${page.title || 'Untitled'}`, value: page.id });
				}
				return options.sort((a, b) => a.name.localeCompare(b.name));
			},
			async getFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const databaseId = this.getCurrentNodeParameter('databaseId') as string;
				if (!databaseId) return [];
				const data = (await flowplanRequest.call(this, 'GET', `/api/pages/${encodeURIComponent(databaseId)}`)) as PageResponse;
				return writableFields(data.database?.fields || []).map((f) => ({
					name: f.name,
					value: f.name,
					description: f.type,
				}));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const push = (data: IDataObject | IDataObject[], i: number) => {
			for (const json of Array.isArray(data) ? data : [data]) returnData.push({ json, pairedItem: { item: i } });
		};
		const limited = <T>(list: T[], i: number) =>
			(this.getNodeParameter('returnAll', i, false) as boolean) ? list : list.slice(0, this.getNodeParameter('limit', i, 50) as number);

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'workspace' && operation === 'getAll') {
					const data = await bootstrap.call(this);
					push(
						data.workspaces.map((w) => ({ id: w.id, name: w.name, icon: w.icon, role: w.role, guest: !!w.guest })),
						i,
					);
				} else if (resource === 'page' && operation === 'getAll') {
					const workspaceId = this.getNodeParameter('workspaceId', i) as string;
					const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
					const data = await bootstrap.call(this, workspaceId);
					const pages = data.pages.filter(
						(p) =>
							!p.deleted_at &&
							(!filters.kind || p.kind === filters.kind) &&
							(!filters.spaceId || p.space_id === filters.spaceId) &&
							(!filters.parentId || p.parent_id === filters.parentId),
					);
					push(limited(pages, i) as IDataObject[], i);
				} else if (resource === 'page' && operation === 'get') {
					const pageId = this.getNodeParameter('pageId', i) as string;
					const data = (await flowplanRequest.call(this, 'GET', `/api/pages/${encodeURIComponent(pageId)}`)) as PageResponse;
					if (!(this.getNodeParameter('simplify', i, true) as boolean)) push(data as IDataObject, i);
					else {
						const out: IDataObject = { ...data.page, role: data.role ?? null };
						if (data.locked) out.locked = true;
						if (typeof data.html === 'string') out.html = data.html;
						if (data.database) {
							out.properties = data.database.fields.map((f) => ({ id: f.id, name: f.name, type: f.type, options: f.options ?? null }));
							out.recordCount = data.rows?.length ?? 0;
						}
						push(out, i);
					}
				} else if (resource === 'page' && operation === 'create') {
					const workspaceId = this.getNodeParameter('workspaceId', i) as string;
					const spaceId = this.getNodeParameter('spaceId', i) as string;
					const title = this.getNodeParameter('title', i) as string;
					const kind = this.getNodeParameter('kind', i) as string;
					const extra = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
					const parentId = (extra.parentId as string) || undefined;
					let id: string;
					if (extra.content) {
						if (kind !== 'document')
							throw new NodeOperationError(this.getNode(), 'Content can only be given for documents.', { itemIndex: i });
						// A document with text: imported, then moved below the parent.
						({ id } = (await flowplanCommand.call(this, {
							action: 'page.import',
							workspaceId,
							spaceId,
							title,
							content: extra.content as string,
							format: (extra.format as string) || 'markdown',
						})) as { id: string });
						if (parentId)
							await flowplanCommand.call(this, { action: 'page.move', pageId: id, parentId, placement: 'inside' });
					} else
						({ id } = (await flowplanCommand.call(this, {
							action: 'page.create',
							workspaceId,
							spaceId,
							title,
							kind,
							...(parentId ? { parentId } : {}),
						})) as { id: string });
					const created = (await flowplanRequest.call(this, 'GET', `/api/pages/${encodeURIComponent(id)}`)) as PageResponse;
					push({ ...created.page, ...(typeof created.html === 'string' ? { html: created.html } : {}) }, i);
				} else if (resource === 'record') {
					const databaseId = this.getNodeParameter('databaseId', i) as string;
					const options = this.getNodeParameter('recordOptions', i, {}) as IDataObject;
					const byName = options.byName !== false;
					const { fields, rows } = await loadDatabase.call(this, databaseId);
					if (operation === 'getAll') {
						push(limited(rows, i).map((r) => recordOutput(r, fields, byName, databaseId)), i);
					} else if (operation === 'get') {
						const recordId = this.getNodeParameter('recordId', i) as string;
						const row = rows.find((r) => r.id === recordId);
						if (!row) throw new NodeOperationError(this.getNode(), `Record ${recordId} not found in this database.`, { itemIndex: i });
						const out = recordOutput(row, fields, byName, databaseId);
						if (options.content) {
							const doc = (await flowplanRequest.call(
								this,
								'GET',
								`/api/pages/${encodeURIComponent(databaseId)}/rows/${encodeURIComponent(recordId)}`,
							)) as { html?: string };
							out.html = doc.html ?? '';
						}
						push(out, i);
					} else if (operation === 'create') {
						const cells = recordCells.call(this, i, fields);
						const { id } = (await flowplanCommand.call(this, { action: 'row.create', pageId: databaseId, cells })) as { id: string };
						const after = await loadDatabase.call(this, databaseId);
						const row = after.rows.find((r) => r.id === id);
						push(row ? recordOutput(row, fields, byName, databaseId) : { id, databaseId }, i);
					} else if (operation === 'update') {
						const recordId = this.getNodeParameter('recordId', i) as string;
						const row = rows.find((r) => r.id === recordId);
						if (!row) throw new NodeOperationError(this.getNode(), `Record ${recordId} not found in this database.`, { itemIndex: i });
						const cells = recordCells.call(this, i, fields);
						// The version guards against overwriting a change made meanwhile.
						await flowplanCommand.call(this, {
							action: 'row.update',
							pageId: databaseId,
							rowId: recordId,
							version: row.version,
							cells,
						});
						const after = await loadDatabase.call(this, databaseId);
						const updated = after.rows.find((r) => r.id === recordId);
						push(updated ? recordOutput(updated, fields, byName, databaseId) : { id: recordId, databaseId }, i);
					}
				} else if (resource === 'search' && operation === 'search') {
					const workspaceId = this.getNodeParameter('workspaceId', i) as string;
					const query = this.getNodeParameter('query', i) as string;
					const kind = this.getNodeParameter('kind', i, 'all') as string;
					const results = (await flowplanRequest.call(this, 'GET', '/api/search', undefined, {
						workspace: workspaceId,
						q: query,
						kind,
					})) as Array<IDataObject & { snippet?: string }>;
					push(
						limited(results, i).map((r) => ({ ...r, snippet: plainSnippet(String(r.snippet || '')) })),
						i,
					);
				} else
					throw new NodeOperationError(this.getNode(), `Unsupported operation "${operation}" for "${resource}".`, { itemIndex: i });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Errors of the Flowplan API carry { error: "…" }.
				const response = (error as { response?: { body?: { error?: string } } }).response;
				if (response || error instanceof NodeApiError)
					throw new NodeApiError(this.getNode(), error as JsonObject, {
						itemIndex: i,
						...(response?.body?.error ? { message: response.body.error } : {}),
					});
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [returnData];
	}
}
