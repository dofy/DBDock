import { test } from 'node:test';
import assert from 'node:assert/strict';

const { SqlHistory } = await import('../src/sqlHistory.ts');

test('recent SQL is scoped to connection and database, deduplicated, bounded, and memory-only', () => {
  const h = new SqlHistory();
  h.add('connection-a', 'public', ' SELECT 1; ');
  h.add('connection-a', 'private', 'SELECT 2;');
  h.add('connection-b', 'public', 'SELECT 3;');
  assert.deepEqual(h.get('connection-a', 'public'), ['SELECT 1;']);
  assert.deepEqual(h.get('connection-a', 'private'), ['SELECT 2;']);
  assert.deepEqual(h.get('connection-b', 'public'), ['SELECT 3;']);
  h.add('connection-a', 'public', 'SELECT 1;');
  assert.equal(h.get('connection-a', 'public').length, 1);
  for (let i = 0; i < 105; i++) h.add('connection-a', 'public', `SELECT ${i};`);
  assert.equal(h.get('connection-a', 'public').length, 100);
  assert.deepEqual(new SqlHistory().get('connection-a', 'public'), []);
});
