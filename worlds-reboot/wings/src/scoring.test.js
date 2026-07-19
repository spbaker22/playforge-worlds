import test from 'node:test';
import assert from 'node:assert/strict';
import { SCORE_ACTION, comboMultiplierFor, createScoreState, reduceScore, scoreSnapshot } from './scoring.js';

test('connected actions build a deterministic combo and multiplier', () => {
  let state = createScoreState();
  state = reduceScore(state, { type: SCORE_ACTION.AWARD, eventId: 'gate-1', kind: 'gate' });
  state = reduceScore(state, { type: SCORE_ACTION.AWARD, eventId: 'gate-2', kind: 'gate' });
  state = reduceScore(state, { type: SCORE_ACTION.AWARD, eventId: 'target-1', kind: 'target' });
  assert.equal(state.combo, 3);
  assert.equal(state.multiplier, 1.25);
  assert.equal(state.score, 100 + 100 + Math.round(125 * 1.25));
  assert.equal(comboMultiplierFor(15), 3);
});

test('stable event ids make awards idempotent', () => {
  const first = reduceScore(createScoreState(), { type: SCORE_ACTION.AWARD, eventId: 'drone-7-destroyed', kind: 'target' });
  const duplicate = reduceScore(first, { type: SCORE_ACTION.AWARD, eventId: 'drone-7-destroyed', kind: 'target' });
  assert.equal(duplicate.score, first.score);
  assert.equal(duplicate.combo, first.combo);
  assert.equal(duplicate.awards, 1);
  assert.equal(duplicate.event, null);
});

test('combo expires with time and can be broken explicitly', () => {
  let state = reduceScore(createScoreState({ comboWindowSeconds: 2 }), { type: SCORE_ACTION.AWARD, eventId: 'gate-1', kind: 'gate' });
  state = reduceScore(state, { type: SCORE_ACTION.TICK, dt: 1.9 });
  assert.equal(state.combo, 1);
  state = reduceScore(state, { type: SCORE_ACTION.TICK, dt: 0.2 });
  assert.equal(state.combo, 0);
  assert.equal(state.event, 'combo-expired');
  state = reduceScore(state, { type: SCORE_ACTION.AWARD, eventId: 'stunt-1', kind: 'stunt' });
  state = reduceScore(state, { type: SCORE_ACTION.BREAK_COMBO, reason: 'collision' });
  assert.equal(state.combo, 0);
  assert.equal(state.breaks, 1);
  assert.equal(state.event, 'combo-broken:collision');
});

test('non-chain awards score without changing the active chain', () => {
  let state = reduceScore(createScoreState(), { type: SCORE_ACTION.AWARD, eventId: 'gate-1', kind: 'gate' });
  const remaining = state.comboRemaining;
  state = reduceScore(state, { type: SCORE_ACTION.AWARD, eventId: 'mission-bonus', basePoints: 500, chainable: false });
  assert.equal(state.combo, 1);
  assert.equal(state.comboRemaining, remaining);
  assert.equal(state.lastAward.points, 500);
});

test('score state is pure, serializable, and rejects ambiguous awards', () => {
  const initial = createScoreState();
  const a = reduceScore(initial, { type: SCORE_ACTION.AWARD, eventId: 'a', kind: 'rescue' });
  const b = reduceScore(initial, { type: SCORE_ACTION.AWARD, eventId: 'a', kind: 'rescue' });
  assert.deepEqual(scoreSnapshot(a), scoreSnapshot(b));
  assert.equal(initial.score, 0);
  assert.doesNotThrow(() => JSON.stringify(a));
  assert.throws(() => reduceScore(initial, { type: SCORE_ACTION.AWARD, kind: 'gate' }), /stable eventId/);
  assert.throws(() => reduceScore(initial, { type: SCORE_ACTION.AWARD, eventId: 'x', kind: 'unknown' }), /unknown score kind/);
});
