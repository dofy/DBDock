import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HealthCheckQueue, HEALTH_CHECK_CONCURRENCY } from '../src/healthCheckQueue.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

test('runs at most four checks and continues after a failure', async () => {
  const queue = new HealthCheckQueue(HEALTH_CHECK_CONCURRENCY);
  const signal = new AbortController().signal;
  const gates = Array.from({ length: 6 }, deferred);
  const started = [];
  const checks = gates.map((gate, i) => queue.schedule(String(i), signal, async () => {
    started.push(i);
    await gate.promise;
  }));
  const results = Promise.allSettled(checks);
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[1].reject(new Error('unreachable'));
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  gates[0].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  for (const gate of gates.slice(2)) gate.resolve();
  const settled = await results;
  assert.equal(settled.filter(item => item.status === 'rejected').length, 1);
});

test('stopping cancels queued checks while running checks finish', async () => {
  const queue = new HealthCheckQueue(2);
  const controller = new AbortController();
  const gates = [deferred(), deferred()];
  const started = [];
  const checks = [0, 1, 2, 3].map(i => queue.schedule(String(i), controller.signal, async () => {
    started.push(i);
    await gates[i].promise;
  }));
  await tick();
  controller.abort();
  await Promise.all(checks.slice(2));
  assert.deepEqual(started, [0, 1]);
  gates.forEach(gate => gate.resolve());
  await Promise.all(checks);
  assert.deepEqual(started, [0, 1]);
  await queue.schedule('late', controller.signal, async () => { throw new Error('must not start'); });
});

test('concurrent batches share the limit and never test one connection twice at once', async () => {
  const queue = new HealthCheckQueue(2);
  const firstBatch = new AbortController();
  const secondBatch = new AbortController();
  const first = deferred();
  const other = deferred();
  const started = [];
  const a = queue.schedule('same', firstBatch.signal, async () => { started.push('first'); await first.promise; });
  const b = queue.schedule('same', secondBatch.signal, async () => { started.push('second'); });
  const c = queue.schedule('other', secondBatch.signal, async () => { started.push('other'); await other.promise; });
  await tick();
  assert.deepEqual(started, ['first', 'other']);
  firstBatch.abort(); // Closing a dialog leaves already-running checks in place.
  other.resolve();
  await tick();
  assert.deepEqual(started, ['first', 'other']);
  first.resolve();
  await Promise.all([a, b, c]);
  assert.deepEqual(started, ['first', 'other', 'second']);
});
