import { createHmac, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { bootstrap, flowplanCommand, flowplanRequest } from '../Flowplan/GenericFunctions';

// Flowplan signs every delivery: X-Flowplan-Signature: sha256=<HMAC-SHA256 of
// the raw body with the webhook's secret>.
export function validSignature(secret: string, body: string | Buffer, header: string | undefined) {
	if (!header || !header.startsWith('sha256=')) return false;
	const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'));
	const given = Buffer.from(header.slice('sha256='.length));
	return expected.length === given.length && timingSafeEqual(expected, given);
}

// The trigger registers a webhook in Flowplan when the workflow is activated
// (or listens for a test event) and removes it again afterwards. That needs a
// write API token of a workspace owner. The secret Flowplan returns is kept
// in the workflow's static data and checks each delivery.
export class FlowplanTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Flowplan Trigger',
		name: 'flowplanTrigger',
		icon: { light: 'file:flowplan.svg', dark: 'file:flowplan.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when records, form answers or pages are created or changed in Flowplan',
		defaults: { name: 'Flowplan Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'flowplanApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'Needs a write API token of a workspace owner. Flowplan only calls HTTPS addresses on the internet; for n8n in your own network set FLOWPLAN_WEBHOOK_ALLOW_PRIVATE=true on the Flowplan instance.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Workspace Name or ID',
				name: 'workspaceId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getOwnedWorkspaces' },
				required: true,
				default: '',
				description:
					'Workspace whose events start the workflow (only workspaces you own). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: [
					{ name: 'Form Submitted', value: 'form.submitted', description: 'An answer to a form' },
					{ name: 'Page Created', value: 'page.created' },
					{ name: 'Record Created', value: 'row.created', description: 'A new record in a database (also from forms)' },
					{ name: 'Record Updated', value: 'row.updated' },
				],
				default: ['row.created'],
			},
			{
				displayName: 'Only Database ID',
				name: 'databaseId',
				type: 'string',
				default: '',
				description:
					'Only events of this database (records and form answers). Leave empty for the whole workspace.',
			},
			{
				displayName: 'Verify Signature',
				name: 'verifySignature',
				type: 'boolean',
				default: true,
				description: 'Whether to reject deliveries whose X-Flowplan-Signature does not match the webhook’s secret',
			},
		],
	};

	methods = {
		loadOptions: {
			async getOwnedWorkspaces(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await bootstrap.call(this);
				return data.workspaces.filter((w) => w.role === 'owner').map((w) => ({ name: w.name, value: w.id }));
			},
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const workspaceId = this.getNodeParameter('workspaceId') as string;
				if (!staticData.webhookId || staticData.workspaceId !== workspaceId) return false;
				const { webhooks } = (await flowplanRequest.call(this, 'GET', '/api/webhooks', undefined, {
					workspace: workspaceId,
				})) as { webhooks: Array<{ id: string; url: string }> };
				const url = this.getNodeWebhookUrl('default');
				if (webhooks.some((h) => h.id === staticData.webhookId && h.url === url)) return true;
				delete staticData.webhookId;
				delete staticData.secret;
				delete staticData.workspaceId;
				return false;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const workspaceId = this.getNodeParameter('workspaceId') as string;
				const databaseId = (this.getNodeParameter('databaseId', '') as string).trim();
				const body: IDataObject = {
					workspaceId,
					url: this.getNodeWebhookUrl('default') as string,
					events: this.getNodeParameter('events') as string[],
					pageId: databaseId || null,
				};
				const hook = (await flowplanRequest.call(this, 'POST', '/api/webhooks', body)) as { id: string; secret: string };
				staticData.webhookId = hook.id;
				staticData.secret = hook.secret;
				staticData.workspaceId = workspaceId;
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				if (staticData.webhookId) {
					try {
						await flowplanCommand.call(this, {
							action: 'webhook.delete',
							workspaceId: (staticData.workspaceId as string) || (this.getNodeParameter('workspaceId') as string),
							id: staticData.webhookId as string,
						});
					} catch (error) {
						this.logger.warn(`Flowplan webhook ${String(staticData.webhookId)} could not be removed: ${(error as Error).message}`);
						return false;
					}
				}
				delete staticData.webhookId;
				delete staticData.secret;
				delete staticData.workspaceId;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		if (this.getNodeParameter('verifySignature', true) as boolean) {
			const secret = this.getWorkflowStaticData('node').secret as string | undefined;
			const header = req.headers['x-flowplan-signature'];
			// The signature covers the body exactly as sent; n8n keeps it.
			const raw: string | Buffer = req.rawBody ?? JSON.stringify(req.body);
			if (!secret || !validSignature(secret, raw, Array.isArray(header) ? header[0] : header)) {
				const res = this.getResponseObject();
				res.status(401).json({ error: 'Invalid signature' });
				return { noWebhookResponse: true };
			}
		}
		return { workflowData: [this.helpers.returnJsonArray(req.body)] };
	}
}
