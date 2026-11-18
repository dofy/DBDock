import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExecutionPlan } from '../src/sqlPlan.ts';

const read = (format, value) => readExecutionPlan({ format, result: { columns: ['plan'], rows: [[value]] } });

test('PostgreSQL shows join children, estimates, actuals, and node details', () => {
  const plan = read('postgresJson', JSON.stringify([{
    'Planning Time': 0.18, 'Execution Time': 2.21,
    Plan: {
      'Node Type': 'Hash Join', 'Plan Rows': 10, 'Actual Rows': 0, 'Actual Loops': 1,
      'Actual Total Time': 2.1, 'Hash Cond': '(a.id = b.id)',
      Plans: [
        { 'Node Type': 'Index Scan', 'Schema': 'public', 'Relation Name': 'a', 'Index Name': 'a_pk' },
        { 'Node Type': 'Seq Scan', 'Relation Name': 'b' },
      ],
    },
  }]));
  const [join] = plan.nodes;
  assert.equal(join.name, 'Hash Join');
  assert.equal(join.actualRows, 0);
  assert.equal(join.estimatedRows, 10);
  assert.equal(join.loops, 1);
  assert.deepEqual(join.children.map(({ name, target }) => [name, target]), [['Index Scan', 'public.a'], ['Seq Scan', 'b']]);
  assert.deepEqual(join.children[0].details, [['Index Name', 'a_pk']]);
  assert.deepEqual([plan.planningMs, plan.executionMs], [0.18, 2.21]);
});

test('MySQL estimates handle both server JSON format versions', () => {
  const classic = read('mysqlJson', JSON.stringify({ query_block: { nested_loop: [
    { table: { table_name: 'a', access_type: 'ALL', rows_examined_per_scan: 45 } },
    { table: { table_name: 'b', access_type: 'eq_ref', key: 'PRIMARY', rows_produced_per_join: 4 } },
  ] } }));
  const [join] = classic.nodes[0].children;
  assert.equal(join.name, 'Nested loop');
  assert.deepEqual(join.children.map((node) => [node.name, node.estimatedRows]), [['Table scan', 45], ['Index lookup', 4]]);
  const versionTwo = read('mysqlJson', JSON.stringify({
    operation: 'Inner hash join', estimated_rows: 10, inputs: [{ operation: 'Table scan on a' }, { operation: 'Index lookup on b' }],
  }));
  assert.equal(versionTwo.nodes[0].name, 'Inner hash join');
  assert.equal(versionTwo.nodes[0].children[1].name, 'Index lookup on b');
});

test('MySQL ANALYZE parses indented plans and runtime metrics', () => {
  const plan = read('mysqlTree', [
    '-> Nested loop inner join  (cost=4.2 rows=9) (actual time=0.014..0.016 rows=3 loops=1)',
    '    -> Table scan on a  (cost=1 rows=9) (actual time=0.003..0.005 rows=3 loops=1)',
    '    -> Index lookup on b using PRIMARY  (cost=0.35 rows=1) (actual time=0.001..0.002 rows=1 loops=3)',
    '        using the parent row',
  ].join('\n'));
  const [root] = plan.nodes;
  assert.deepEqual([root.estimatedRows, root.actualRows, root.loops, root.timeMs], [9, 3, 1, 0.016]);
  assert.equal(root.children[1].name, 'Index lookup on b using PRIMARY');
  assert.equal(root.children[1].loops, 3);
  assert.equal(root.children[1].details[1][1], 'using the parent row');
});

test('SQLite links nodes by ID rather than display order and retains raw output', () => {
  const plan = readExecutionPlan({ format: 'sqliteTree', result: {
    columns: ['id', 'parent', 'notused', 'detail'],
    rows: [[5, 3, 0, 'SEARCH a USING INDEX a_id (id=?)'], [3, 0, 0, 'MATERIALIZE cte'], [9, 0, 0, 'SCAN cte']],
  } });
  assert.deepEqual(plan.nodes.map(({ name }) => name), ['MATERIALIZE cte', 'SCAN cte']);
  assert.match(plan.nodes[0].children[0].name, /USING INDEX/);
  assert.match(plan.raw, /"parent"/);
  const unknown = read('mysqlJson', 'unexpected server output');
  assert.deepEqual(unknown.nodes, []);
  assert.equal(unknown.raw, 'unexpected server output');
});
