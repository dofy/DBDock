import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/tableImport.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { parseTableFile } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('CSV decodes quoted commas, escaped quotes, newlines and distinct empty values', () => {
  assert.deepEqual(parseTableFile('\uFEFFid,label,empty,missing\r\n1,"a,b\n""quoted""","",\r\n', 'csv'), {
    columns: ['id', 'label', 'empty', 'missing'],
    rows: [['1', 'a,b\n"quoted"', '', null]],
  });
  assert.throws(() => parseTableFile('a,b\n1,"unfinished', 'csv'), /Unclosed/);
  assert.throws(() => parseTableFile('a,b\n1', 'csv'), /same number/);
  assert.throws(() => parseTableFile('a,a\n1,2', 'csv'), /duplicate/);
});

test('JSON files round-trip exported columns and rows, including nulls and precise integers', () => {
  const data = { columns: ['id', 'label'], rows: [['9007199254740993', null], [2, '']] };
  assert.deepEqual(parseTableFile(JSON.stringify(data), 'json'), data);
  assert.deepEqual(parseTableFile('[{"v":{"action":true},"id":1},{"id":2,"v":null}]', 'json'), {
    columns: ['v', 'id'],
    rows: [['{"action":true}', 1], [null, 2]],
  });
  assert.throws(() => parseTableFile('[{"id":9007199254740993}]', 'json'), /safe integer/);
  assert.throws(() => parseTableFile('[{"id":1},{"name":"wrong"}]', 'json'), /same fields/);
});
