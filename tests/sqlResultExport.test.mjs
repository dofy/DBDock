import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/sqlResultExport.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { serializeResult } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('CSV quotes text, retains empty fields, and neutralizes spreadsheet formulas in text only', () => {
  const result = { columns: ['name', 'text', 'empty', 'count'], rows: [['猫, dog', 'line\n"two"', null, -5], ["=1+1", '+cmd', '', 0]] };
  assert.equal(serializeResult(result, 'csv'), `"name","text","empty","count"\r\n"猫, dog","line\n""two""",,"-5"\r\n"'=1+1","'+cmd","","0"\r\n`);
});

test('JSON retains duplicate names and typed values without re-running the query', () => {
  const result = { columns: ['id', 'id', 'flag'], rows: [[1, null, true], ['9007199254740993', 2, false]] };
  assert.deepEqual(JSON.parse(serializeResult(result, 'json')), result);
});
