import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSqlEdit } from '../src/sqlFormat.ts';

const apply = (doc, edit) => doc.slice(0, edit.from) + edit.text + doc.slice(edit.to);

test('formats a multi-statement editor and keeps the caret on the same token', () => {
  const sql = 'select id,label from Items where id=1;\nselect 2 as next;';
  const position = sql.indexOf('next') + 2;
  const edit = formatSqlEdit(sql, position, position, 'sqlite');
  assert.equal(apply(sql, edit), 'SELECT\n  "id",\n  "label"\nFROM\n  "Items"\nWHERE\n  "id" = 1;\n\nSELECT\n  2 AS "next";');
  assert.equal(edit.head, edit.text.indexOf('next') + 2);
  assert.equal(edit.anchor, edit.head);
  assert.equal(formatSqlEdit(edit.text, edit.head, edit.head, 'sqlite'), null);
  const adjacent = 'select 1;select 2;';
  const atSecond = formatSqlEdit(adjacent, adjacent.indexOf(';') + 1, adjacent.indexOf(';') + 1, 'sqlite');
  assert.equal(atSecond.head, atSecond.text.lastIndexOf('SELECT'));
});

test('preserves a backward selection and keeps whitespace at its edges', () => {
  const prefix = 'select 0;';
  const suffix = 'select 3;';
  const selected = '\nselect a,b from Items; -- note\n';
  const sql = prefix + selected + suffix;
  const edit = formatSqlEdit(sql, sql.length - suffix.length, prefix.length, 'sqlite');
  assert.equal(apply(sql, edit), prefix + '\nSELECT\n  "a",\n  "b"\nFROM\n  "Items";\n\n-- note\n' + suffix);
  assert.equal(edit.head, prefix.length);
  assert.equal(edit.anchor, prefix.length + edit.text.length);
});

test('retains PostgreSQL dollar quotes, comments, operators and bind parameters', () => {
  const comment = '/* note\n    keep this indent */';
  const sql = `select payload->>'key',$tag$begin;  end;$tag$ from "Items" where id=$1; ${comment}`;
  const edit = formatSqlEdit(sql, 0, 0, 'postgres');
  assert.match(edit.text, /"payload" ->> 'key'/);
  assert.match(edit.text, /"Items"\nWHERE\n  "id" = \$1/);
  assert.ok(edit.text.includes('$tag$begin;  end;$tag$'));
  assert.ok(edit.text.includes(comment));
});

test('retains MySQL quotes and placeholders, and uses SQLite syntax for D1', () => {
  const mysql = "select `MixedCase`,'it\\'s  fine' from `db`.`things` where id=?;";
  const changed = formatSqlEdit(mysql, 0, 0, 'mysql').text;
  assert.ok(changed.includes("`MixedCase`,\n  'it\\'s  fine'"));
  assert.ok(changed.includes('`db`.`things`\nWHERE\n  `id` = ?;'));
  const sqlite = "select [odd name],'x  y' from t where id=:id;";
  const result = formatSqlEdit(sqlite, 0, 0, 'd1').text;
  assert.ok(result.includes("[odd name],\n  'x  y'"));
  assert.ok(result.includes('"id" = :id;'));
});

test('rejects incomplete text or formatting that could change meaning', () => {
  assert.equal(formatSqlEdit('   \n', 0, 0, 'sqlite'), null);
  assert.throws(() => formatSqlEdit("select 'unfinished", 0, 0, 'sqlite'));
  assert.throws(() => formatSqlEdit("select 'a'\n 'b';", 0, 0, 'postgres'), /token stream/);
  assert.throws(() => formatSqlEdit('select count (id) from t;', 0, 0, 'mysql'), /token stream/);
  assert.match(formatSqlEdit('select 1- -2;', 0, 0, 'postgres').text, /1 - -2/);
  const partial = "select 'select a,b from t;' as literal;";
  assert.throws(() => formatSqlEdit(partial, partial.indexOf("'") + 1, partial.lastIndexOf("'"), 'sqlite'), /token stream/);
});

test('quotes PostgreSQL qualified references using their unquoted case-folding rules', () => {
  const sql = 'select U.UserId, U."DisplayName", count(U.Score) from Public.Users U where U.UserId=$1;';
  const edit = formatSqlEdit(sql, sql.indexOf('UserId') + 2, sql.indexOf('UserId') + 2, 'postgres');
  assert.equal(edit.text, 'SELECT\n  "u"."userid",\n  "u"."DisplayName",\n  count("u"."score")\nFROM\n  "public"."users" "u"\nWHERE\n  "u"."userid" = $1;');
  assert.equal(edit.head, edit.text.indexOf('userid') + 2);
  assert.equal(formatSqlEdit(edit.text, 0, 0, 'postgres'), null);
});

test('uses MySQL backticks, keeps exact name case and capitalizes predicates', () => {
  const sql = "select Owner, UserId from App.Users where DeletedAt is not null and Owner like 'AbC%';";
  const result = formatSqlEdit(sql, 0, 0, 'mysql').text;
  assert.match(result, /SELECT\n  `Owner`,\n  `UserId`\nFROM\n  `App`\.`Users`/);
  assert.match(result, /`DeletedAt` IS NOT NULL\n  AND `Owner` LIKE 'AbC%'/);
  const insert = formatSqlEdit("insert into App.Users(ID, Name) values (?, 'Keep Case');", 0, 0, 'mysql');
  assert.match(insert.text, /`App`\.`Users` \(`ID`, `Name`\)/);
  assert.match(insert.text, /VALUES\n  \(\?, 'Keep Case'\)/);
});

test('beautifies table definitions and respects function, cast, window and locking syntax', () => {
  const ddl = formatSqlEdit("create table Items (ID int primary key, Name text); alter table Items add column Age int;", 0, 0, 'd1').text;
  assert.match(ddl, /CREATE TABLE "Items" \("ID" int PRIMARY KEY, "Name" text\)/);
  assert.match(ddl, /ALTER TABLE "Items"\nADD COLUMN "Age" int/);
  const pg = formatSqlEdit("select cast(Id as name), Value::Custom.Type, coalesce(Name,'Untouched') from T for update skip locked;", 0, 0, 'postgres').text;
  assert.match(pg, /cast\("id" AS name\)/);
  assert.match(pg, /"value"::Custom\.Type/);
  assert.match(pg, /coalesce\("name", 'Untouched'\)/);
  assert.match(pg, /FOR UPDATE\s+skip locked/i);
  const mysql = formatSqlEdit("select sum(cost) over (order by id rows between 1 preceding and current row) from Sales;", 0, 0, 'mysql').text;
  assert.match(mysql, /sum\(`cost`\) OVER/);
  assert.match(mysql, /1 preceding\s+AND current ROW/i);
});
