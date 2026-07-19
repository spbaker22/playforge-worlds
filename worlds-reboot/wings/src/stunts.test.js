import test from 'node:test';
import assert from 'node:assert/strict';
import { STUNT_ACTION, STUNT_CHAIN_WINDOW, createStuntState, reduceStunts, stuntProgress, stuntSnapshot } from './stunts.js';

const TAU = Math.PI * 2;

test('a full axial roll completes with a score and energy result', () => {
  const initial = createStuntState();
  const begun = reduceStunts(initial, { type: STUNT_ACTION.BEGIN, stuntId: 'run-1-roll-1', kind: 'axial-roll', altitude: 60 });
  const halfway = reduceStunts(begun, { type: STUNT_ACTION.TICK, dt: 0.5, rollDelta: Math.PI, altitude: 59 });
  assert.ok(Math.abs(stuntProgress(halfway.active) - 0.5) < 1e-12);
  const complete = reduceStunts(halfway, { type: STUNT_ACTION.TICK, dt: 0.5, rollDelta: Math.PI, altitude: 58 });
  assert.equal(complete.active, null);
  assert.equal(complete.event, 'completed:axial-roll');
  assert.equal(complete.completions, 1);
  assert.equal(complete.lastResult.score, 200);
  assert.equal(complete.lastResult.energy, 12);
  assert.equal(initial.completions, 0);
});

test('either roll direction is valid but directional loops remain distinct', () => {
  let reverse = reduceStunts(createStuntState(), { type: STUNT_ACTION.BEGIN, stuntId: 'reverse-roll', kind: 'axial-roll', altitude: 70 });
  reverse = reduceStunts(reverse, { type: STUNT_ACTION.TICK, dt: 1, rollDelta: -TAU, altitude: 68 });
  assert.equal(reverse.completions, 1);

  let inside = reduceStunts(createStuntState(), { type: STUNT_ACTION.BEGIN, stuntId: 'wrong-loop', kind: 'inside-loop', altitude: 80 });
  inside = reduceStunts(inside, { type: STUNT_ACTION.TICK, dt: 1, pitchDelta: -TAU, altitude: 78 });
  assert.equal(inside.completions, 0);
  assert.equal(stuntProgress(inside.active), 0);
});

test('stunts fail deterministically on time or unsafe altitude loss', () => {
  let timeout = reduceStunts(createStuntState(), { type: STUNT_ACTION.BEGIN, stuntId: 'slow', kind: 'axial-roll', altitude: 50 });
  timeout = reduceStunts(timeout, { type: STUNT_ACTION.TICK, dt: 3.1, rollDelta: 0.1, altitude: 50 });
  assert.equal(timeout.event, 'failed:timeout');
  assert.deepEqual(timeout.failedStuntIds, ['slow']);

  let low = reduceStunts(createStuntState(), { type: STUNT_ACTION.BEGIN, stuntId: 'low', kind: 'inside-loop', altitude: 50 });
  low = reduceStunts(low, { type: STUNT_ACTION.TICK, dt: 0.5, pitchDelta: 1, altitude: 25 });
  assert.equal(low.event, 'failed:altitude-loss');
});

test('different maneuvers chain, expire, and reject duplicate stable ids', () => {
  let state = reduceStunts(createStuntState(), { type: STUNT_ACTION.REGISTER, stuntId: 'arch-1', kind: 'proximity-thread' });
  state = reduceStunts(state, { type: STUNT_ACTION.BEGIN, stuntId: 'roll-1', kind: 'axial-roll', altitude: 60 });
  state = reduceStunts(state, { type: STUNT_ACTION.TICK, dt: 1, rollDelta: TAU, altitude: 58 });
  assert.equal(state.chain, 2);
  assert.equal(state.bestChain, 2);
  assert.ok(state.lastResult.score > 200, 'chain multiplier should reward connected stunts');
  const duplicate = reduceStunts(state, { type: STUNT_ACTION.REGISTER, stuntId: 'arch-1', kind: 'proximity-thread' });
  assert.equal(duplicate.completions, 2);
  state = reduceStunts(duplicate, { type: STUNT_ACTION.TICK, dt: STUNT_CHAIN_WINDOW + 0.1 });
  assert.equal(state.chain, 0);
  assert.equal(state.event, 'chain-expired');
});

test('stunt simulation is serializable and replay deterministic', () => {
  function run(){
    let state = reduceStunts(createStuntState(), { type: STUNT_ACTION.BEGIN, stuntId: 'barrel-1', kind: 'barrel-roll', altitude: 90 });
    for(let i = 0; i < 120 && state.active; i += 1) state = reduceStunts(state, { type: STUNT_ACTION.TICK, dt: 1 / 120, rollDelta: TAU / 120, pitchDelta: Math.PI / 120, altitude: 90 - i * 0.02 });
    return state;
  }
  assert.deepEqual(stuntSnapshot(run()), stuntSnapshot(run()));
  assert.doesNotThrow(() => JSON.stringify(run()));
});
