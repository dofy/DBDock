import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/tableListStatus.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { tableListStatus } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('table list distinguishes loading, failures, empty lists, and filters', () => {
  assert.equal(tableListStatus('', 'loading', '', 'loading', 0, 0), 'loading');
  assert.equal(tableListStatus('', 'error', '', 'loading', 0, 0), 'error');
  assert.equal(tableListStatus('', 'ready', '', 'loading', 0, 0), 'no-schemas');
  assert.equal(tableListStatus('public', 'ready', '', 'ready', 0, 0), 'loading');
  assert.equal(tableListStatus('public', 'ready', 'public', 'loading', 0, 0), 'loading');
  assert.equal(tableListStatus('public', 'ready', 'public', 'error', 0, 0), 'error');
  assert.equal(tableListStatus('public', 'ready', 'public', 'ready', 0, 0), 'no-tables');
  assert.equal(tableListStatus('public', 'ready', 'public', 'ready', 3, 0), 'no-matches');
  assert.equal(tableListStatus('public', 'ready', 'public', 'ready', 3, 2), 'ready');
});
