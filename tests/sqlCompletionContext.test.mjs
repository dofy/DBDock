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
const catalogs = {
  postgres: {
    public: catalog,
    audit: { books: [col('entry_id', 'integer'), col('verified', 'boolean', true)], events: [col('occurred', 'date')] },
    'Sales.App': { 'Daily Rollup': [col('Total', 'integer')] },
  },
  sqlite: { main: catalog, attached: { books: [col('archive_id', 'integer')] } },
  d1: { main: catalog },
  mysql: {
    app: { ...catalog, books: [...catalog.books, col('visible', 'tinyint(1)', true)] },
    archive: { books: [col('archive_id', 'integer')] },
  },
};
const sources = {
  postgres: sqlContextSource(PostgreSQL, 'postgres', 'public', Object.keys(catalogs.postgres)),
  sqlite: sqlContextSource(SQLite, 'sqlite', 'main', Object.keys(catalogs.sqlite)),
  d1: sqlContextSource(SQLite, 'd1', 'main', Object.keys(catalogs.d1)),
  mysql: sqlContextSource(MySQL, 'mysql', 'app', Object.keys(catalogs.mysql)),
};
// The cursor marker keeps replacement ranges and suggestions in the same test.
function completion(input, kind = 'postgres') {
  const pos = input.indexOf('|');
  assert.notEqual(pos, -1);
  const state = EditorState.create({ doc: input.replace('|', '') });
  return sources[kind](new CompletionContext(state, pos, false), (name) => catalogs[kind][name]);
}
const labels = (input, kind) => completion(input, kind)?.options.map(({ label }) => label);
const inserts = (input, kind) => completion(input, kind)?.options.map(({ apply }) => apply);

test('offers tables at FROM, JOIN, UPDATE, INTO and comma-separated table slots without a prefix', () => {
  const tables = Object.keys(catalog);
  for (const doc of ['SELECT *\nFROM |', 'SELECT * FROM books JOIN |', 'UPDATE |', 'INSERT INTO |', 'SELECT * FROM books, |']) {
    assert.deepEqual(completion(doc).options.filter(({ type }) => type === "class").map(({ label }) => label), tables);
  }
  assert.deepEqual(labels('SELECT * FROM public.|'), tables);
  assert.deepEqual(labels('SELECT * FROM other.|'), []);
  assert.deepEqual(inserts('SELECT * FROM `Sales|', 'mysql'), ['`Sales.Region`']);
  assert.deepEqual(inserts('SELECT * FROM Sales|'), ['"books"', '"authors"', '"Sales.Region"', '"public".', '"audit".', '"Sales.App".']);
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
  assert.deepEqual(labels('SELECT * FROM books WHERE id IN (SELECT * FROM authors WHERE |)'), ['id', 'active', 'display name', 'id', 'title', 'published', 'featured']);
});

test('replaces the whole identifier at the cursor and retains exact quoted case', () => {
  const cursor = completion('SELECT * FROM bo|oks');
  assert.equal(cursor.to - cursor.from, 'books'.length);
  const quoted = completion('SELECT * FROM "Sale|');
  assert.deepEqual(quoted.options.map(({apply}) => apply), ['"Sales.Region"', '"Sales.App".']);
  assert.deepEqual(labels('SELECT * FROM "Books" b WHERE b.|'), []);
  assert.deepEqual(labels('SELECT * FROM Books b WHERE b.|'), ['id', 'title', 'published', 'featured']);
});

test('keeps set-operation arms separate and qualifies fields alongside a derived table', () => {
  assert.deepEqual(labels('SELECT * FROM authors UNION ALL SELECT * FROM books WHERE |'), ['id', 'title', 'published', 'featured']);
  assert.deepEqual(labels('SELECT * FROM books WHERE | UNION ALL SELECT * FROM authors'), ['id', 'title', 'published', 'featured']);
  const derived = 'SELECT * FROM (SELECT id FROM authors) a JOIN books b ON a.id=b.id WHERE ';
  assert.deepEqual(inserts(derived + '|'), ['a."id"', 'b."id"', 'b."title"', 'b."published"', 'b."featured"']);
  assert.deepEqual(labels(derived + 'id = |'), []);
});

test('completes CTE names, aliases and projected fields in declaration order', () => {
  const sql = 'WITH Book_Stats AS (SELECT id, published AS is_public, COUNT(*) AS total FROM books), ';
  assert.deepEqual(labels(sql + 'next AS (SELECT * FROM book_stats WHERE |) SELECT * FROM next'), ['id', 'is_public', 'total']);
  assert.deepEqual(labels(sql + 'next AS (SELECT is_public FROM book_stats) SELECT * FROM next n WHERE n.|'), ['is_public']);
  assert.deepEqual(labels(sql.slice(0, -2) + ' SELECT * FROM book_stats WHERE is_public = |'), ['TRUE', 'FALSE']);
  assert.equal(completion(sql.slice(0, -2) + ' SELECT * FROM |').options.find(({ label }) => label === 'book_stats').apply, '"book_stats"');
  assert.equal(completion('WITH first AS (SELECT * FROM |), later AS (SELECT id FROM authors) SELECT * FROM first').options.some(({label}) => label === 'later'), false);
  assert.deepEqual(labels('WITH books("Out", visible) AS (SELECT id, published FROM public.books) SELECT * FROM books WHERE |'), ['Out', 'visible']);
  assert.deepEqual(labels('WITH books("Out", visible) AS (SELECT id, published FROM public.books) SELECT * FROM books WHERE visible = |'), ['TRUE', 'FALSE']);
});

test('handles recursive CTE anchor columns and CTE shadowing between nested queries', () => {
  assert.deepEqual(labels('WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE |) SELECT * FROM seq'), ['n']);
  assert.deepEqual(labels('WITH RECURSIVE seq AS (SELECT id AS n FROM books UNION ALL SELECT n + 1 FROM seq WHERE |) SELECT * FROM seq'), ['n']);
  assert.deepEqual(labels('WITH q AS (SELECT title FROM books) SELECT * FROM q WHERE EXISTS (WITH q AS (SELECT active FROM authors) SELECT * FROM q WHERE q.|)'), ['active']);
  assert.deepEqual(labels('WITH q AS (SELECT title FROM books) SELECT * FROM q WHERE q.|'), ['title']);
});

test('completes subquery sources, derived column lists, and nested SELECT scopes', () => {
  const derived = 'SELECT * FROM (SELECT a.*, b.published AS status, COUNT(*) AS total FROM authors a JOIN books b ON b.id=a.id) d ';
  assert.deepEqual(labels(derived + 'WHERE d.|'), ['id', 'active', 'display name', 'status', 'total']);
  assert.deepEqual(labels(derived + 'WHERE d.status = |'), ['TRUE', 'FALSE']);
  assert.deepEqual(labels('SELECT * FROM (SELECT id, published FROM books) d(book_id) WHERE d.|'), ['book_id', 'published']);
  assert.deepEqual(labels('SELECT * FROM (SELECT | FROM books) d'), ['id', 'title', 'published', 'featured']);
  assert.deepEqual(labels('SELECT * FROM books WHERE (EXISTS (SELECT * FROM authors a WHERE a.|'), ['id', 'active', 'display name']);
  assert.deepEqual(labels('SELECT * FROM (SELECT 1 AS n UNION ALL SELECT 2 AS other) d WHERE d.|'), ['n']);
});

test('handles correlated references, alias shadowing and lateral visibility', () => {
  assert.deepEqual(labels('SELECT * FROM books b WHERE EXISTS (SELECT 1 FROM authors a WHERE b.|)'), ['id', 'title', 'published', 'featured']);
  assert.deepEqual(labels('SELECT * FROM books b WHERE EXISTS (SELECT 1 FROM authors b WHERE b.|)'), ['id', 'active', 'display name']);
  assert.deepEqual(labels('SELECT * FROM books b JOIN (SELECT 1 FROM authors a WHERE b.|) d ON true'), []);
  assert.deepEqual(labels('SELECT * FROM books b JOIN LATERAL (SELECT 1 FROM authors a WHERE b.|) d ON true'), ['id', 'title', 'published', 'featured']);
});

test('uses the specified schema for table and field candidates, including three-part names', () => {
  assert.deepEqual(labels('SELECT * FROM audit.|'), ['books', 'events']);
  assert.deepEqual(inserts('SELECT * FROM "Sales.App".|'), ['"Daily Rollup"']);
  assert.deepEqual(labels('SELECT * FROM "Sales.App"."Daily Rollup" r WHERE r.|'), ['Total']);
  assert.deepEqual(labels('SELECT * FROM public.books JOIN audit.books ON public.books.|'), ['id', 'title', 'published', 'featured']);
  assert.deepEqual(labels('SELECT * FROM public.books JOIN audit.books ON books.|'), []);
  assert.deepEqual(inserts('SELECT * FROM public.books JOIN audit.books ON |'), [
    'public.books."id"', 'public.books."title"', 'public.books."published"', 'public.books."featured"',
    'audit.books."entry_id"', 'audit.books."verified"',
  ]);
  assert.deepEqual(labels('UPDATE audit.books SET |'), ['entry_id', 'verified']);
  assert.deepEqual(labels('SELECT * FROM audit.books WHERE audit.books.verified = |'), ['TRUE', 'FALSE']);
  assert.deepEqual(inserts('SELECT * FROM archive.books b WHERE b.|', 'mysql'), ['`archive_id`']);
  assert.deepEqual(labels('SELECT * FROM attached.books b WHERE b.|', 'sqlite'), ['archive_id']);
});

test('resolves cross-schema projections without searching unrelated schemas', () => {
  const read = [];
  const sql = 'WITH q AS (SELECT a.* FROM audit.books a) SELECT * FROM q WHERE q.';
  const state = EditorState.create({ doc: sql });
  const result = sources.postgres(new CompletionContext(state, sql.length, false), (name) => {
    read.push(name);
    return catalogs.postgres[name];
  });
  assert.deepEqual(result.options.map(({ label }) => label), ['entry_id', 'verified']);
  assert.deepEqual([...new Set(read)], ['audit']);
});
