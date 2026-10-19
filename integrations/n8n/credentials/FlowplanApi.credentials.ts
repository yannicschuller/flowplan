import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

// A personal API token from Flowplan (Settings → API & webhooks). Requests
// act as the person who created it, with their permissions; "read" tokens
// only read.
export class FlowplanApi implements ICredentialType {
	name = 'flowplanApi';

	displayName = 'Flowplan API';

	icon: Icon = { light: 'file:flowplan.svg', dark: 'file:flowplan.svg' };

	documentationUrl = 'https://docs.flowplan.org/api-and-webhooks';

	properties: INodeProperties[] = [
		{
			displayName: 'Instance URL',
			name: 'url',
			type: 'string',
			default: '',
			placeholder: 'https://flowplan.example.org',
			description: 'Address of your Flowplan instance, without a trailing slash',
			required: true,
		},
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			placeholder: 'fp_…',
			description:
				'Personal API token from Settings → API & webhooks. Use a write token to create pages and records or to register the trigger’s webhook.',
			required: true,
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiToken}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.url.replace(/\\/+$/, "")}}',
			url: '/api/tokens',
			method: 'GET',
		},
	};
}
