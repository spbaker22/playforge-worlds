import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASHFALL_BOUNDS,
  ASHFALL_WAVE,
  ashfallCompletionBonus,
  ashfallRunLabel,
  ashfallSeedForRun,
  ashfallWaveSchedule,
} from './rules.js';

test('the authored safe-zone bounds match the interaction rectangle', () => {
  assert.deepEqual(ASHFALL_BOUNDS, { minX: -6.2, maxX: 6.2, minZ: -4.4, maxZ: 4.6 });
  assert.equal(ASHFALL_BOUNDS.maxX - ASHFALL_BOUNDS.minX, 12.4);
  assert.equal(ASHFALL_BOUNDS.maxZ - ASHFALL_BOUNDS.minZ, 9);
});

test('run labels honestly echo mode and ash intensity', () => {
  assert.equal(ashfallRunLabel('quick', 'standard'), 'QUICK RUN · STANDARD ASH');
  assert.equal(ashfallRunLabel('full', 'inferno'), 'FULL RUN · INFERNO ASH');
});

test('completion bonus rewards survival and remaining hearts', () => {
  assert.equal(ashfallCompletionBonus(30, 1), 5400);
  assert.equal(ashfallCompletionBonus(30, 3), 6600);
  assert.equal(ashfallCompletionBonus(60, 1), 10200);
});

test('replay seeds are deterministic, stable, and varied', () => {
  const first = Array.from({ length: 5 }, (_, index) => ashfallSeedForRun(0xA5F411, index));
  const second = Array.from({ length: 5 }, (_, index) => ashfallSeedForRun(0xA5F411, index));
  assert.deepEqual(first, second);
  assert.equal(first[0], 0xA5F411);
  assert.equal(new Set(first).size, first.length);
});

test('perimeter-wave schedule is sparse, readable, and deterministic', () => {
  assert.deepEqual(ashfallWaveSchedule(30), [6, 14, 22]);
  assert.deepEqual(ashfallWaveSchedule(60), [6, 14, 22, 30, 38, 46, 54]);
  assert.equal(ASHFALL_WAVE.slots, 12);
  assert.equal(ASHFALL_WAVE.minimumLead, 1.45);
  assert.ok(ASHFALL_WAVE.radiusScale > 1);
});
