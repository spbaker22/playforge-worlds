import test from 'node:test';
import assert from 'node:assert/strict';
import { tideLastFishVisible, tideOutcomeNote } from './presentation.js';

test('LAST FISH is visible only during an active overtime cast, never over outcomes or results', () => {
  const overtime = { status: 'running', overtime: true, phase: 'reeling' };
  assert.equal(tideLastFishVisible({ flow: 'play', state: overtime }), true);
  assert.equal(tideLastFishVisible({ flow: 'outcome', state: overtime }), false);
  assert.equal(tideLastFishVisible({ flow: 'results', state: { ...overtime, status: 'finished', phase: 'finished' } }), false);
  assert.equal(tideLastFishVisible({ flow: 'countdown', state: { status: 'running', overtime: false, phase: 'aim' } }), false);
  assert.equal(tideLastFishVisible({ flow: 'play', state: { ...overtime, phase: 'catch' } }), false);
});

test('a non-trophy Breakwater catch uses Breakwater copy rather than Pier copy', () => {
  const note = tideOutcomeNote({
    type: 'catch',
    zone: { id: 'breakwater', label: 'BREAKWATER' },
    fish: { tier: 'rare' },
  });
  assert.equal(note, 'BREAKWATER · A clean line along the breakwater.');
  assert.equal(note.toLowerCase().includes('pier'), false);
});
