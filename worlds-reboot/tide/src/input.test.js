import test from 'node:test';
import assert from 'node:assert/strict';
import { createTideActionController } from './action.js';
import { fishForCast } from './fish.js';
import { cancelTideInput } from './input.js';
import { createTideSim } from './sim.js';

const dt = 1 / 120;

function advanceUntil(sim, predicate, seconds = 5){
  for(let i = 0; i < seconds / dt && !predicate(sim.state); i += 1) sim.step(dt);
}

test('an interruption clears pointer ownership and releases a held reel before it can snap', () => {
  const sim = createTideSim({
    duration: 20,
    tension: 'standard',
    fishPlan: () => ({ ...fishForCast({ seed: 9, castIndex: 0 }), biteDelay: 0.01 }),
  });
  const action = createTideActionController();
  sim.cast(0.8, 0);
  advanceUntil(sim, state => state.phase === 'bite');
  assert.equal(sim.hook(), true);
  assert.equal(action.begin({ pointerId: 31, x: 100, y: 100, phase: 'reeling', time: 1 }).type, 'reel-start');
  assert.equal(sim.setReeling(true), true);

  const cancelled = cancelTideInput(action, sim);
  assert.equal(cancelled.type, 'reel-stop');
  assert.equal(cancelled.cancelled, true);
  assert.equal(action.state.active, false);
  assert.equal(action.state.pointerId, null);
  assert.equal(sim.state.reelHeld, false);

  for(let i = 0; i < 3 / dt; i += 1) sim.step(dt);
  assert.equal(sim.state.phase, 'reeling');
  assert.equal(sim.state.snaps, 0);
});
