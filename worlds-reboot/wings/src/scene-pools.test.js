import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedPool, createBoundedRing } from './scene-pools.js';

test('bounded pool preallocates once and never grows past capacity', () => {
  let created = 0;
  const pool = createBoundedPool({
    capacity: 3,
    create(index){ created += 1; return { index, live: false, value: 0 }; },
    activate(item, value){ item.live = true; item.value = value; },
    deactivate(item){ item.live = false; item.value = 0; },
  });
  assert.equal(created, 3);
  const first = pool.acquire(4);
  const second = pool.acquire(5);
  const third = pool.acquire(6);
  assert.deepEqual([first.index, second.index, third.index], [0, 1, 2]);
  assert.equal(pool.acquire(7), null);
  assert.deepEqual(pool.diagnostics(), { capacity: 3, active: 3, available: 0 });

  assert.equal(pool.release(second, 'hit'), true);
  const reused = pool.acquire(9);
  assert.equal(reused, second);
  assert.equal(reused.value, 9);
  assert.equal(created, 3);
});

test('pool iteration is dense, stable, and protects membership', () => {
  const pool = createBoundedPool({ capacity: 4, create: index => ({ index }) });
  const zero = pool.acquire();
  const one = pool.acquire();
  const two = pool.acquire();
  pool.release(one);
  const seen = [];
  pool.forEachActive(item => seen.push(item.index));
  assert.deepEqual(seen, [zero.index, two.index]);
  assert.throws(() => pool.forEachActive(item => pool.release(item)), /cannot change/);
  pool.drain('mission-change');
  assert.equal(pool.activeCount, 0);
  assert.equal(pool.available, 4);
});

test('activation errors roll the acquired slot back into the free stack', () => {
  const pool = createBoundedPool({
    capacity: 1,
    create: () => ({}),
    activate(_item, value){ if(value === 'bad') throw new Error('bad activation'); },
  });
  assert.throws(() => pool.acquire('bad'), /bad activation/);
  assert.deepEqual(pool.diagnostics(), { capacity: 1, active: 0, available: 1 });
  assert.ok(pool.acquire('good'));
});

test('bounded ring overwrites oldest cues while preserving FIFO order', () => {
  let created = 0;
  const ring = createBoundedRing({
    capacity: 3,
    create: index => { created += 1; return { index, value: null }; },
    write: (entry, value) => { entry.value = value; },
    reset: entry => { entry.value = null; },
  });
  for(const value of ['a', 'b', 'c', 'd']) ring.push(value);
  assert.equal(created, 3);
  assert.equal(ring.count, 3);
  assert.deepEqual([ring.peek(0).value, ring.peek(1).value, ring.peek(2).value], ['b', 'c', 'd']);
  const consumed = [];
  ring.consume(entry => consumed.push(entry.value));
  assert.deepEqual(consumed, ['b', 'c', 'd']);
  assert.equal(ring.count, 0);
});

test('pool and ring reject invalid capacities and factories', () => {
  assert.throws(() => createBoundedPool({ capacity: 0, create: () => ({}) }), /positive integer/);
  assert.throws(() => createBoundedPool({ capacity: 2, create: () => null }), /unique object/);
  assert.throws(() => createBoundedRing({ capacity: 2, create: () => ({}), write: null }), /write must be a function/);
});
