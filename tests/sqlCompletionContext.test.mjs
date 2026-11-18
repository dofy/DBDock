import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompletionContext } from '@codemirror/autocomplete';
import { MySQL, PostgreSQL, SQLite } from '@codemirror/lang-sql';
import { EditorState } from '@codemirror/state';
import { sqlContextSource } from '../src/sqlCompletionContext.ts';

const col = (name, dataType, nullable = false) => ({ name, dataType, nullable });
const catalog = {
  books: [col('id', 'integer'), col('title', 'text'), col('published', 'boolean', true), col('featured', 'bool')],
  authors: [col('id', 'integer'), col('active', 'boolean'), col('display name', 'text', true)],
  'Sales.Region': [col('MixedCase', 'varchar(20)')],
};
const sources = {
  postgres: sqlContextSource(PostgreSQL, 'postgres', 'public', catalog),
  sqlite: sqlContextSource(SQLite, 'sqlite', 'main', catalog),
  d1: sqlContextSource(SQLite, 'd1', 'main', catalog),
  mysql: sqlContextSource(MySQL, 'mysql', 'app', {
    ...catalog, books: [...catalog.books, col('visible', 'tinyint(1)', true)],
  }),
};
// The cursor marker keeps replacement ranges and suggestions in the same test.
function completion(input, kind = 'postgres') {
  const pos = input.indexOf('|');
  assert.notEqual(pos, -1);
  const state = EditorState.create({ doc: input.replace('|', '') });
  return sources[kind](new CompletionContext(state, pos, false));
}
const labels = (input, kind) => completion(input, kind)?.options.map(({ label }) => label);
const inserts = (input, kind) => completion(input, kind)?.options.map(({ apply }) => apply);

test('offers tables at FROM, JOIN, UPDATE, INTO and comma-separated table slots without a prefix', () => {
  const tables = Object.keys(catalog);
  for (const doc of ['SELECT *\nFROM |', 'SELECT * FROM books JOIN |', 'UPDATE |', 'INSERT INTO |', 'SELECT * FROM books, |']) {
    assert.deepEqual(labels(doc), tables);
  }
  assert.deepEqual(labels('SELECT * FROM public.|'), tables);
  assert.deepEqual(labels('SELECT * FROM other.|'), []);
  assert.deepEqual(inserts('SELECT * FROM `Sales|', 'mysql'), ['`Sales.Region`']);
  assert.deepEqual(inserts('SELECT * FROM Sales|'), ['"books"', '"authors"', '"Sales.Region"']);
});

test('uses only the current statement and the updated table for field slots', () => {
  assert.deepEqual(labels('SELECT * FROM authors; SELECT * FROM books WHERE |'), ['id', 'title', 'published', 'featured']);
  assert.deepEqual(labels('UPDATE books SET |'), ['id', 'title', 'published', 'featured']);
  assert.deepEqual(labels("UPDATE books SET title = 'new', |"), ['id', 'title', 'published', 'featured']);
  assert.equal(completion('SET search_path = |'), null);
  assert.deepEqual(labels('SELECT * FROM books WHERE id = 1 AND |'), ['id', 'title', 'published', 'featured']);
  assert.deepEqual(labels('SELECT | FROM books'), ['id', 'title', 'published', 'featured']);
});

test('resolves aliases across joins and qualifies ambiguous fields', () => {
  const sql = 'SELECT * FROM public.books AS b JOIN authors a ON b.id = a.id WHERE ';
  const choices = completion(sql + '|').options;
  assert.deepEqual(choices.filter((option) => option.label === 'id').map(({ apply }) => apply), ['b."id"', 'a."id"']);
  assert.deepEqual(inserts(sql + 'a.|'), ['"id"', '"active"', '"display name"']);
  assert.deepEqual(labels(sql + 'missing.|'), []);
  assert.deepEqual(inserts('SELECT * FROM [Sales.Region] AS [quarter view] WHERE [quarter view].|', 'sqlite'), ['"MixedCase"']);
  assert.deepEqual(labels('SELECT * FROM other.books b WHERE b.|'), []);
});

test('shows comparisons and boolean/null values in valid slots across SQL dialects', () => {
  const predicate = 'SELECT * FROM books b WHERE b.published ';
  assert.deepEqual(labels(predicate + '|'), ['=', '<>', 'IS NULL', 'IS NOT NULL']);
  assert.deepEqual(labels(predicate + '= |'), ['TRUE', 'FALSE']);
  assert.deepEqual(labels(predicate + 'IS |'), ['TRUE', 'FALSE', 'NULL', 'NOT NULL']);
  assert.deepEqual(labels(predicate + 'IS NOT |'), ['TRUE', 'FALSE', 'NULL']);
  assert.deepEqual(labels('SELECT * FROM books WHERE featured IS |'), ['TRUE', 'FALSE']);
  assert.deepEqual(labels('UPDATE books SET published |'), ['=']);
  assert.deepEqual(labels('UPDATE books SET published = |'), ['TRUE', 'FALSE', 'NULL']);
  assert.deepEqual(labels('UPDATE books SET featured = |'), ['TRUE', 'FALSE']);
  assert.deepEqual(labels('UPDATE books SET visible = |', 'mysql'), ['TRUE', 'FALSE', 'NULL']);
  assert.deepEqual(labels(predicate + '= |', 'd1'), ['TRUE', 'FALSE']);
  assert.deepEqual(labels('SELECT * FROM books WHERE title |'), ['=', '<>', 'LIKE']);
});

test('leaves literal/comment text alone and suppresses ambiguous or unloaded field metadata', () => {
  assert.deepEqual(labels("SELECT 'WHERE |"), []);
  assert.deepEqual(labels("SELECT * FROM books -- WHERE |"), []);
  assert.deepEqual(labels("SELECT * FROM books /* WHERE |"), []);
  assert.deepEqual(labels('SELECT * FROM books b JOIN authors a ON b.id=a.id WHERE id |'), undefined);
  assert.deepEqual(labels('SELECT * FROM unknown WHERE |'), []);
  assert.deepEqual(labels('SELECT * FROM books WHERE id IN (SELECT * FROM authors WHERE |)'), undefined);
});

test('replaces the whole identifier at the cursor and retains exact quoted case', () => {
  const cursor = completion('SELECT * FROM bo|oks');
  assert.equal(cursor.to - cursor.from, 'books'.length);
  const quoted = completion('SELECT * FROM "Sale|');
  assert.deepEqual(quoted.options.map(({apply}) => apply), ['"Sales.Region"']);
  assert.deepEqual(labels('SELECT * FROM "Books" b WHERE b.|'), []);
  assert.deepEqual(labels('SELECT * FROM Books b WHERE b.|'), ['id', 'title', 'published', 'featured']);
});

test('keeps set-operation arms separate and qualifies fields alongside a derived table', () => {
  assert.deepEqual(labels('SELECT * FROM authors UNION ALL SELECT * FROM books WHERE |'), ['id', 'title', 'published', 'featured']);
  assert.deepEqual(labels('SELECT * FROM books WHERE | UNION ALL SELECT * FROM authors'), ['id', 'title', 'published', 'featured']);
  const derived = 'SELECT * FROM (SELECT id FROM authors) a JOIN books b ON a.id=b.id WHERE ';
  assert.deepEqual(inserts(derived + '|'), ['b."id"', 'b."title"', 'b."published"', 'b."featured"']);
  assert.deepEqual(labels(derived + 'id = |'), []);
});
