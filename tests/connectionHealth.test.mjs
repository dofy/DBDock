import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurationIssues } from '../src/connectionHealth.ts';

const config = (overrides = {}) => ({ kind: 'postgres', host: '', port: 0, redisDb: 0, file: '', cfAccountId: '', database: '', ssh: { enabled: false, host: '', port: 22 }, ...overrides });

test('honors usable defaults and optional credentials', () => {
  assert.deepEqual(configurationIssues(config()), []);
  assert.deepEqual(configurationIssues(config({ kind: 'redis', redisDb: 0 })), []);
  assert.deepEqual(configurationIssues(config({ kind: 'mongodb', host: 'mongodb+srv://example.com', port: 0 })), []);
});

test('finds missing required file and Cloudflare identifiers', () => {
  assert.deepEqual(configurationIssues(config({ kind: 'sqlite' })), ['SQLite file is required']);
  assert.equal(configurationIssues(config({ kind: 'd1' })).length, 2);
  assert.deepEqual(configurationIssues(config({ kind: 'd1', cfAccountId: 'a', database: 'd' })), []);
});

test('reports invalid ports, Redis index, and incompatible SSH URI', () => {
  assert.equal(configurationIssues(config({ port: 65536 })).length, 1);
  assert.equal(configurationIssues(config({ kind: 'redis', redisDb: -1 })).length, 1);
  assert.deepEqual(configurationIssues(config({ kind: 'mongodb', host: 'mongodb://example.com', ssh: { enabled: true, host: '', port: -1 } })), [
    'SSH host is required', 'SSH port must be between 1 and 65535, or empty for default', 'With SSH, enter the MongoDB host and port separately',
  ]);
});
