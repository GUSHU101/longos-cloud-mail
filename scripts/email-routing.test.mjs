import assert from 'node:assert/strict';
import test from 'node:test';
import {configureEmailRouting} from './email-routing.mjs';

const token = 'test-token';
const accountId = 'a'.repeat(32);
const workerName = 'cloud-mail';
const domain = 'example.com';

function response(result, status = 200, errors = []) {
  return new Response(JSON.stringify({success: status >= 200 && status < 300, result, errors}), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

test('preserves an already-correct catch-all without another mutation', async () => {
  const methods = [];
  const result = await configureEmailRouting({token, accountId, workerName, domains: [domain], fetchImpl: async (url, options) => {
    methods.push(options.method || 'GET');
    if (url.includes('/zones?')) return response([{id: 'zone-1', name: domain, account: {id: accountId}}]);
    if (url.endsWith('/email/routing')) return response({enabled: true, status: 'ready'});
    return response({enabled: true, matchers: [{type: 'all'}], actions: [{type: 'worker', value: [workerName]}]});
  }});

  assert.deepEqual(result, {configured: [domain], manual: [], warnings: []});
  assert.deepEqual(methods, ['GET', 'GET', 'GET']);
});
test('enables routing and points catch-all to the deployed worker', async () => {
  const calls = [];
  const result = await configureEmailRouting({token, accountId, workerName, domains: [domain], fetchImpl: async (url, options) => {
    calls.push([url, options.method || 'GET', options.body]);
    if (url.includes('/zones?')) return response([{id: 'zone-1', name: domain, account: {id: accountId}}]);
    if (url.endsWith('/email/routing') && !options.method) return response({enabled: false});
    if (url.endsWith('/email/routing/dns')) return response({enabled: true, status: 'ready'});
    if (url.endsWith('/catch_all') && !options.method) return response({enabled: false, actions: [], matchers: [{type: 'all'}]});
    return response({enabled: true, matchers: [{type: 'all'}], actions: [{type: 'worker', value: [workerName]}]});
  }});

  assert.deepEqual(result, {configured: [domain], manual: [], warnings: []});
  assert.equal(calls.find(([, method]) => method === 'POST')?.[0].endsWith('/email/routing/dns'), true);
  const catchAllUpdate = calls.find(([, method]) => method === 'PUT');
  assert.equal(JSON.parse(catchAllUpdate[2]).actions[0].value[0], workerName);
});
test('reports the exact permission fallback for final acceptance', async () => {
  const result = await configureEmailRouting({token, accountId, workerName, domains: [domain], fetchImpl: async (url) => {
    if (url.includes('/zones?')) return response([{id: 'zone-1', name: domain, account: {id: accountId}}]);
    return response(null, 403, [{message: 'Authentication error'}]);
  }});

  assert.deepEqual(result.configured, []);
  assert.equal(result.manual[0].domain, domain);
  assert.match(result.manual[0].reason, /Authentication error/);
});

test('reports enabled routing whose DNS status is still misconfigured', async () => {
  const result = await configureEmailRouting({token, accountId, workerName, domains: [domain], fetchImpl: async (url) => {
    if (url.includes('/zones?')) return response([{id: 'zone-1', name: domain, account: {id: accountId}}]);
    if (url.endsWith('/email/routing')) return response({enabled: true, status: 'misconfigured'});
    return response({enabled: true, matchers: [{type: 'all'}], actions: [{type: 'worker', value: [workerName]}]});
  }});

  assert.deepEqual(result.configured, [domain]);
  assert.deepEqual(result.manual, []);
  assert.equal(result.warnings[0].domain, domain);
  assert.match(result.warnings[0].reason, /misconfigured/);
});
