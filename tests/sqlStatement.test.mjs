import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedOrCurrentStatement } from '../src/sqlStatement.ts';

const at = (sql, marker, kind = 'postgres') => {
  const offset = typeof marker === 'number' ? marker : sql.indexOf(marker);
  assert.ok(offset >= 0);
  return selectedOrCurrentStatement(sql, offset, offset, kind);
};
const statement = (text) => ({ status: 'sql', text });

test('select the complete multiline statement, including CTEs, without adjacent SQL', () => {
  const current = 'WITH x AS (SELECT 1)\nSELECT *\nFROM x;';
  const sql = `  SELECT 0;\n\n   ${current} SELECT 2;`;
  assert.deepEqual(at(sql, 0), statement('SELECT 0;'));
  assert.deepEqual(at(sql, 'FROM x'), statement(current));
  assert.deepEqual(at(sql, 'SELECT 2'), statement('SELECT 2;'));
  assert.deepEqual(at(sql, sql.length), statement('SELECT 2;'));
  assert.deepEqual(at(sql, sql.indexOf('\n\n') + 1), { status: 'empty' });
  assert.deepEqual(at('SELECT 1;SELECT 2;', 9), statement('SELECT 2;'));
  assert.deepEqual(at('SELECT\n   1', 7), statement('SELECT\n   1'));
});

test('use explicit selections and ignore comment-only or delimiter-only positions', () => {
  const sql = "SELECT 1; SELECT 2; -- ignore;\n;\n/* empty */";
  assert.deepEqual(selectedOrCurrentStatement(sql, 3, 8, 'postgres'), statement('ECT 1'));
  assert.deepEqual(at(sql, '-- ignore'), { status: 'empty' });
  assert.deepEqual(at(sql, '/* empty'), { status: 'empty' });
  assert.deepEqual(at(';  ;\n', 3), { status: 'empty' });
  assert.deepEqual(at('SELECT 1;\n\n', 11), { status: 'empty' });
});

test('semicolons in strings, identifiers, comments and PostgreSQL dollar quotes stay inside the statement', () => {
  const pg = "SELECT 'one'';two', \"field;name\", E'quo\\';ted', $body$x;y$body$ /* c; /* d; */ e */;";
  const mysql = "SELECT 'one'';two', `field;name`, 1--2;";
  const sqlite = "SELECT [field;name], 'x;y';";
  for (const [kind, sql] of [['postgres', pg], ['mysql', mysql], ['sqlite', sqlite], ['d1', sqlite]]) {
    assert.deepEqual(at(`${sql}\nSELECT 2;`, ';', kind), statement(sql));
  }
  const body = 'DO $body$ BEGIN PERFORM 1; PERFORM 2; END; $body$;';
  assert.deepEqual(at(`${body} SELECT 3;`, 'PERFORM 2'), statement(body));
});

test('SQLite trigger bodies stay together and never run their inner write alone', () => {
  const trigger = 'CREATE TEMP TRIGGER audit AFTER UPDATE ON t BEGIN\nINSERT INTO log VALUES (1);\nUPDATE t SET x=CASE WHEN x=1 THEN 2 END;\nEND /* keep */;';
  const sql = `${trigger}\nSELECT 2;`;
  assert.deepEqual(at(sql, 'INSERT', 'sqlite'), statement(trigger));
  assert.deepEqual(at(sql, 'SELECT', 'sqlite'), statement('SELECT 2;'));
  assert.deepEqual(at(trigger.slice(0, trigger.lastIndexOf('\n')), 'INSERT', 'sqlite'), { status: 'ambiguous' });
});

test('require an explicit selection when a dialect feature could change the execution boundary', () => {
  const cases = [
    ['mysql', "SELECT 'a\\';b'; SELECT 2;", 0],
    ['mysql', '--\tDELETE FROM t;', 'DELETE'],
    ['mysql', '/*! SET @x=1 */; SELECT 2;', 'SET'],
    ['mysql', 'SELECT 1 /* outer /* inner */; DROP TABLE t; */;', 0],
    ['mysql', 'DELIMITER //\nCREATE PROCEDURE p() BEGIN DELETE FROM t; END//', 'DELETE'],
    ['mysql', 'CREATE PROCEDURE p() BEGIN SELECT 1; DELETE FROM t; END;', 'DELETE'],
    ['postgres', 'CREATE FUNCTION f() RETURNS void LANGUAGE SQL BEGIN ATOMIC SELECT 1; DELETE FROM t; END;', 'DELETE'],
    ['postgres', 'DO $日本$ BEGIN SELECT 1; DELETE FROM t; END; $日本$;', 'DELETE'],
    ['postgres', 'CREATE RULE r AS ON UPDATE TO t DO ALSO (SELECT 1; DELETE FROM t;); SELECT 3;', 'DELETE'],
    ['postgres', 'COPY t FROM STDIN;\nDELETE FROM t;\n\\.', 'DELETE'],
    ['sqlite', 'SELECT 1 /* outer /* inner */; DROP TABLE t; */;', 0],
  ];
  for (const [kind, sql, cursor] of cases) assert.deepEqual(at(sql, cursor, kind), { status: 'ambiguous' }, sql);
});
