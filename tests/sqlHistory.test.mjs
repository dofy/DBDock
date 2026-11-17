import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/sqlHistory.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { SqlHistory, selectedOrCurrentLine } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('execute the selection or cursor line without executing other statements', () => {
  const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
  assert.equal(selectedOrCurrentLine(sql, 0, 0), 'SELECT 1;');
  assert.equal(selectedOrCurrentLine(sql, 12, 12), 'SELECT 2;');
  assert.equal(selectedOrCurrentLine(sql, 10, 18), 'SELECT 2');
  assert.equal(selectedOrCurrentLine('\nSELECT 1;', 0, 0), '');
  assert.equal(selectedOrCurrentLine('A\r\nB', 3, 3), 'B');
});

test('recent SQL is scoped to connection and schema, deduplicated, bounded, and memory-only', () => {
  const h = new SqlHistory();
  h.add('connection-a', 'public', ' SELECT 1; ');
  h.add('connection-a', 'private', 'SELECT 2;');
  h.add('connection-b', 'public', 'SELECT 3;');
  assert.deepEqual(h.get('connection-a', 'public'), ['SELECT 1;']);
  assert.deepEqual(h.get('connection-a', 'private'), ['SELECT 2;']);
  assert.deepEqual(h.get('connection-b', 'public'), ['SELECT 3;']);
  h.add('connection-a', 'public', 'SELECT 1;');
  for (let i = 0; i < 35; i++) h.add('connection-a', 'public', `SELECT ${i};`);
  assert.equal(h.get('connection-a', 'public').length, 30);
  assert.deepEqual(new SqlHistory().get('connection-a', 'public'), []);
});
