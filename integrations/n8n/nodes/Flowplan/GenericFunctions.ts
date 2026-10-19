import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IWebhookFunctions,
} from 'n8n-workflow';

type Context = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions | IWebhookFunctions;

// One request to the Flowplan REST API, authenticated with the API token.
export async function flowplanRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<unknown> {
	const credentials = await this.getCredentials('flowplanApi');
	const base = String(credentials.url || '').replace(/\/+$/, '');
	const options: IHttpRequestOptions = {
		method,
		url: `${base}${path}`,
		json: true,
		headers: { Accept: 'application/json' },
	};
	if (body) options.body = body;
	if (qs) options.qs = qs;
	return await this.helpers.httpRequestWithAuthentication.call(this, 'flowplanApi', options);
}

// Changes go through POST /api/command with an "action" (as in the app).
export async function flowplanCommand(this: Context, body: IDataObject): Promise<unknown> {
	return await flowplanRequest.call(this, 'POST', '/api/command', body);
}

export interface Workspace {
	id: string;
	name: string;
	icon?: string;
	role: 'owner' | 'editor' | 'viewer';
	guest?: number;
}
export interface PageSummary {
	id: string;
	title: string;
	kind: string;
	icon?: string;
	space_id: string;
	parent_id: string | null;
	workspace_id: string;
	deleted_at: string | null;
	[key: string]: unknown;
}
export interface Bootstrap {
	workspaces: Workspace[];
	workspace: Workspace;
	pages: PageSummary[];
	spaces: { id: string; name: string; deleted_at?: string | null }[];
}

// The workspaces of the token's owner, and with a workspace id its pages
// and spaces (GET /api/bootstrap).
export async function bootstrap(this: Context, workspaceId?: string): Promise<Bootstrap> {
	const data = (await flowplanRequest.call(
		this,
		'GET',
		'/api/bootstrap',
		undefined,
		workspaceId ? { workspace: workspaceId } : undefined,
	)) as Bootstrap;
	// An unknown workspace falls back to the first one: never mix them up.
	if (workspaceId && data.workspace?.id !== workspaceId)
		throw new Error(`Workspace ${workspaceId} not found or not accessible with this API token.`);
	return data;
}
