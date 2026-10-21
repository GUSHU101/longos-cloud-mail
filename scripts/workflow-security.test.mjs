import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../.github/workflows/deploy-cloudflare.yml', import.meta.url), 'utf8');
const validation = readFileSync(new URL('../.github/workflows/validate.yml', import.meta.url), 'utf8');
const selfHosted = readFileSync(new URL('../.github/workflows/self-hosted-mail-engine-ci.yml', import.meta.url), 'utf8');
const codeOwners = readFileSync(new URL('../.github/CODEOWNERS', import.meta.url), 'utf8');

test('production deployment is owner-only and default-branch-only', () => {
  assert.match(source, /github\.actor == github\.repository_owner/);
  assert.match(source, /github\.triggering_actor == github\.repository_owner/);
  assert.match(source, /github\.ref_name == github\.event\.repository\.default_branch/);
  assert.match(source, /environment:\s+name: production/);
  assert.doesNotMatch(source, /workflow_call:/);
});

test('checkout cannot retain a write credential and actions are immutable', () => {
  assert.match(source, /persist-credentials: false/);
  for (const action of source.matchAll(/uses:\s*([^\s#]+)/g)) {
    assert.match(action[1], /@[a-f0-9]{40}$/i);
  }
});

test('all CI jobs use a pinned runner image and discard checkout credentials', () => {
  for (const workflow of [source, validation, selfHosted]) {
    assert.doesNotMatch(workflow, /runs-on:\s+ubuntu-latest/);
    assert.match(workflow, /runs-on:\s+ubuntu-24\.04/);
    const checkouts = [...workflow.matchAll(/uses:\s*actions\/checkout@[a-f0-9]{40}[\s\S]*?(?=\n\s*- (?:name:|uses:)|$)/gi)];
    assert.ok(checkouts.length > 0);
    for (const checkout of checkouts) {
      assert.match(checkout[0], /persist-credentials:\s*false/);
    }
  }
});

test('production secrets are scoped to the deploy step instead of the whole job', () => {
  const deployStep = source.indexOf('id: deploy');
  const verificationStep = source.indexOf('node scripts/verify-deployment.mjs');
  const token = source.indexOf('CLOUDFLARE_API_TOKEN:');
  const job = source.indexOf('jobs:');

  assert.ok(deployStep > job);
  assert.ok(verificationStep > job && verificationStep < deployStep);
  assert.ok(token > deployStep);
  assert.match(source, /--from-env --skip-verification/);
});

test('all non-secret deployment settings are supplied at dispatch time', () => {
  const inputNames = [...source.matchAll(/^      ([a-z][a-z0-9_]+):$/gm)].map(match => match[1]);
  assert.deepEqual(inputNames, [
    'worker_name',
    'custom_domain',
    'mail_domains',
    'admin_email',
    'longos_relay_url',
    'cloudflare_account_id',
    'd1_database_name',
    'd1_database_id',
    'kv_namespace_id',
    'r2_bucket_name',
    'project_link',
    'ai_model',
    'cors_origins',
    'auto_configure_email_routing',
    'cloudflare_email',
    'analysis_cache',
  ]);
  assert.ok(inputNames.length <= 25);
  assert.ok(inputNames.every(name => !/(?:token|secret|password|api_key)/i.test(name)));
  assert.doesNotMatch(source, /vars\./);
  assert.match(source, /DOMAIN: \$\{\{ inputs\.mail_domains \}\}/);
  assert.match(source, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ inputs\.cloudflare_account_id \}\}/);
  assert.match(source, /LONGOS_INTEGRATION_TOKEN: \$\{\{ inputs\.longos_relay_url != '' && secrets\.LONGOS_INTEGRATION_TOKEN \|\| '' \}\}/);
});

test('all production changes have an explicit repository owner', () => {
  assert.match(codeOwners, /^\*\s+@GUSHU101$/m);
});

test('pull requests use a read-only secret-free validation workflow', () => {
  assert.match(validation, /pull_request:/);
  assert.doesNotMatch(validation, /pull_request_target:/);
  assert.match(validation, /permissions:\s+contents: read/);
  assert.match(validation, /node scripts\/verify-deployment\.mjs/);
  assert.doesNotMatch(validation, /secrets\./);
  assert.doesNotMatch(validation, /environment:\s+name: production/);
  for (const action of validation.matchAll(/uses:\s*([^\s#]+)/g)) {
    assert.match(action[1], /@[a-f0-9]{40}$/i);
  }
});
