import { test } from 'node:test';
import assert from 'node:assert/strict';
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
const history = await import('../src/healthHistory.ts');
const config = { id:'one', kind:'postgres', host:'db.example.test', port:5432, user:'example', database:'app', file:'', redisDb:0, cfAccountId:'', options:'', ssh:{enabled:false,host:'',port:22,user:'',auth:'key',keyPath:''} };

test('persists the last outcome and ignores changed connection settings', async () => {
  history.clearAllHealth();
  history.finishHealthCheck(history.beginHealthCheck(config), 'ok', 1710000000000);
  assert.equal(history.latestHealth(config, history.healthSnapshot()).status, 'ok');
  assert.equal(history.latestHealth({ ...config, host:'changed' }, history.healthSnapshot()), undefined);
  const saved = storage.get('dbdock.health-history.v1');
  assert.ok(!saved.includes('db.example.test'));
  assert.ok(!saved.includes('example'));
  const reloaded = await import('../src/healthHistory.ts?reload=1');
  assert.equal(reloaded.latestHealth(config, reloaded.healthSnapshot()).checkedAt, 1710000000000);
});

test('clearing or importing invalidates in-flight results', () => {
  history.clearAllHealth();
  const beforeEdit = history.beginHealthCheck(config);
  history.clearHealth([config.id]);
  history.finishHealthCheck(beforeEdit, 'ok');
  assert.equal(history.latestHealth(config, history.healthSnapshot()), undefined);
  const beforeImport = history.beginHealthCheck(config);
  history.clearAllHealth();
  history.finishHealthCheck(beforeImport, 'error');
  assert.equal(history.latestHealth(config, history.healthSnapshot()), undefined);
  history.finishHealthCheck(history.beginHealthCheck(config), 'error', 1710000000100);
  assert.equal(history.latestHealth(config, history.healthSnapshot()).status, 'error');
});
