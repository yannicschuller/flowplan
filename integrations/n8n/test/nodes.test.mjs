// Runs against the build: npm run build && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cellsToIds, cellsToNames, coerceValue, plainSnippet } = require('../dist/nodes/Flowplan/cells.js');
const { validSignature, FlowplanTrigger } = require('../dist/nodes/FlowplanTrigger/FlowplanTrigger.node.js');
const { Flowplan } = require('../dist/nodes/Flowplan/Flowplan.node.js');
const { FlowplanApi } = require('../dist/credentials/FlowplanApi.credentials.js');
const pkg = require('../package.json');

const fields = [
	{ id: 'title', name: 'Name', type: 'text' },
	{ id: 'f1', name: 'Status', type: 'select', options: ['Open', 'Done'] },
	{ id: 'f2', name: 'Estimate', type: 'number' },
	{ id: 'f3', name: 'Urgent', type: 'checkbox' },
	{ id: 'f4', name: 'Tags', type: 'multiselect', options: ['a', 'b'] },
	{ id: 'f5', name: 'Key', type: 'id' },
];

test('properties by name or id become cells by id', () => {
	assert.deepEqual(cellsToIds(fields, { name: 'Call', f1: 'Open' }), { title: 'Call', f1: 'Open' });
	assert.throws(() => cellsToIds(fields, { Missing: 1 }), /Unknown property "Missing"/);
	assert.throws(() => cellsToIds(fields, { Key: 'X' }), /computed/);
	assert.deepEqual(cellsToNames(fields, { title: 'Call', f2: 3, gone: 1 }), { Name: 'Call', Estimate: 3, gone: 1 });
});

test('text values are converted to the property type', () => {
	assert.deepEqual(cellsToIds(fields, { Estimate: '2,5', Urgent: 'yes', Tags: 'a, b' }, true), {
		f2: 2.5,
		f3: true,
		f4: ['a', 'b'],
	});
	assert.equal(coerceValue(fields[2], ''), null);
	assert.equal(coerceValue(fields[3], 'false'), false);
	assert.equal(plainSnippet('\u0002Hit\u0003 here'), 'Hit here');
});

test('webhook signatures are checked like Flowplan signs them', () => {
	const body = JSON.stringify({ event: 'row.created', data: { rowId: 'x' } });
	const sig = 'sha256=' + createHmac('sha256', 'secret').update(body).digest('hex');
	assert.equal(validSignature('secret', body, sig), true);
	assert.equal(validSignature('secret', Buffer.from(body), sig), true);
	assert.equal(validSignature('other', body, sig), false);
	assert.equal(validSignature('secret', body + ' ', sig), false);
	assert.equal(validSignature('secret', body, undefined), false);
});

test('package lists the built nodes and credentials', () => {
	assert.ok(pkg.keywords.includes('n8n-community-node-package'));
	assert.equal(new Flowplan().description.name, 'flowplan');
	assert.equal(new FlowplanTrigger().description.webhooks[0].httpMethod, 'POST');
	assert.equal(new FlowplanApi().name, 'flowplanApi');
	for (const file of [...pkg.n8n.nodes, ...pkg.n8n.credentials]) assert.doesNotThrow(() => require(`../${file}`));
});
