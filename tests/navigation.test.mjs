import test from 'node:test';
import assert from 'node:assert/strict';
import { destinationKey, pruneNavigation, readNavigation, saveNavigation, sessionDatabase, targetKey, toggleFavorite, uniqueTargets, visitTarget } from '../src/navigation.ts';

const connection = (connectionId = 'c') => ({ type: 'connection', connectionId });
const table = (table, database = 'db', schema = 'public', connectionId = 'c') => ({ type: 'table', connectionId, database, schema, table });
const fresh = () => ({ favorites: [], recent: [] });

test('same-named objects in different workspaces remain distinct', () => {
  const items = [table('items'), table('items', 'other'), table('items', 'db', 'other'), table('items', 'db', 'public', 'other')];
  assert.equal(new Set(items.map(targetKey)).size, items.length);
  assert.deepEqual(uniqueTargets([...items, { ...items[0] }]), items);
  assert.notEqual(targetKey(table('x/y', 'db', 's')), targetKey(table('y', 'db', 's/x')));
  assert.notEqual(destinationKey('c', 'main'), destinationKey('c', 'archive'));
});

test('favorites persist separately from bounded most-recent visits', () => {
  const favorite = table('starred');
  let state = toggleFavorite(fresh(), favorite);
  for (let i = 0; i < 45; i++) state = visitTarget(state, table(String(i)));
  state = visitTarget(state, table('42'));
  assert.equal(state.recent.length, 40);
  assert.equal(state.recent[0].table, '42');
  assert.equal(state.recent.filter((item) => item.table === '42').length, 1);
  let saved;
  saveNavigation({ setItem: (_key, value) => { saved = value; } }, state);
  const loaded = readNavigation({ getItem: () => saved });
  assert.deepEqual(loaded, state);
  assert.deepEqual(toggleFavorite(loaded, favorite).favorites, []);
  assert.deepEqual(loaded.favorites, [favorite]);
});

test('malformed saved state does not break navigation', () => {
  assert.deepEqual(readNavigation({ getItem: () => 'invalid' }), fresh());
  assert.deepEqual(readNavigation({ getItem: () => JSON.stringify({
    recent: [null, { type: 'database', connectionId: 'c' }, connection(), connection(), { ...table('bad'), table: 4 }],
    favorites: false,
  }) }), { favorites: [], recent: [connection()] });
  assert.doesNotThrow(() => saveNavigation({ setItem: () => { throw new Error('disabled'); } }, fresh()));
});

test('database identity follows the session and never mistakes PostgreSQL schemas for databases', () => {
  assert.equal(sessionDatabase('postgres', '', 'public'), 'postgres');
  assert.equal(sessionDatabase('postgres', 'analytics', 'public'), 'analytics');
  assert.equal(sessionDatabase('mysql', 'default', 'actual'), 'actual');
  assert.equal(sessionDatabase('mysql', '', ''), '');
  assert.equal(sessionDatabase('sqlite', '', 'main'), '');
});

test('deleted connections are pruned without affecting other saved destinations', () => {
  const keep = connection();
  const removed = table('t', 'db', 'public', 'former');
  const state = { favorites: [keep, removed], recent: [removed, keep] };
  const pruned = pruneNavigation(state, new Set(['c']));
  assert.deepEqual(pruned, { favorites: [keep], recent: [keep] });
  assert.equal(pruneNavigation(pruned, new Set(['c'])), pruned);
});
