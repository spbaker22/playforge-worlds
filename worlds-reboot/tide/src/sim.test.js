import test from 'node:test';
import assert from 'node:assert/strict';
import { tideCompetition } from './competition.js';
import { createTideSim, tideDuration, TIDE_TENSION } from './sim.js';
import { fishForCast, scoreFish } from './fish.js';

const dt = 1 / 120;
function until(sim, predicate, seconds = 30){
  const steps = Math.ceil(seconds / dt);
  for(let i = 0; i < steps && !predicate(sim.state); i += 1) sim.step(dt);
  return sim.state;
}

function playCompetentRun({ session, scoring, seed, power, lateral }){
  const sim = createTideSim({ session, scoring, tension: 'standard', seed });
  for(let step = 0; step < 180000 && sim.state.status === 'running'; step += 1){
    const state = sim.state;
    if(state.phase === 'aim') sim.cast(power, lateral);
    else if(state.phase === 'bite') sim.hook();
    else if(state.phase === 'reeling'){
      const shouldHold = state.reelHeld ? state.tension < 0.70 : state.tension < 0.54;
      if(shouldHold !== state.reelHeld) sim.setReeling(shouldHold);
    } else if(state.phase === 'catch' || state.phase === 'snap'){
      sim.nextCast();
      continue;
    }
    if(sim.state.status === 'running') sim.step(dt);
  }
  return sim.state;
}

test('URL option contracts have explicit defaults and profiles', () => {
  assert.equal(tideDuration('quick'), 45);
  assert.equal(tideDuration('full'), 90);
  assert.ok(TIDE_TENSION.relaxed.limit > TIDE_TENSION.standard.limit);
  assert.ok(TIDE_TENSION.relaxed.snapGrace > TIDE_TENSION.standard.snapGrace);
  const sim = createTideSim();
  assert.equal(sim.config.session, 'full');
  assert.equal(sim.config.tension, 'standard');
  assert.equal(sim.config.scoring, 'haul');
});

test('the same fixed-step actions produce an identical fishing run', () => {
  const a = createTideSim({ session: 'quick', tension: 'relaxed', scoring: 'haul', seed: 81, duration: 18 });
  const b = createTideSim({ session: 'quick', tension: 'relaxed', scoring: 'haul', seed: 81, duration: 18 });
  for(const sim of [a, b]){
    sim.cast(0.76, -0.24);
    until(sim, s => s.phase === 'bite');
    sim.hook();
    for(let i = 0; i < 2400 && sim.state.phase === 'reeling'; i += 1){
      const shouldHold = sim.state.reelHeld ? sim.state.tension < 0.72 : sim.state.tension < 0.58;
      if(shouldHold !== sim.state.reelHeld) sim.setReeling(shouldHold);
      sim.step(dt);
    }
  }
  assert.deepEqual(a.state, b.state);
  assert.deepEqual(a.drainEvents(), b.drainEvents());
});

test('a readable bite cue must be hooked before reeling', () => {
  const sim = createTideSim({ duration: 10, fishPlan: () => ({ ...fishForCast({ seed: 1, castIndex: 0 }), biteDelay: 0.05 }) });
  assert.equal(sim.setReeling(true), false);
  assert.equal(sim.cast(0.5, 0), true);
  until(sim, state => state.phase === 'bite', 3);
  assert.equal(sim.state.phase, 'bite');
  assert.ok(sim.state.biteRemaining > 0);
  assert.equal(sim.hook(), true);
  assert.equal(sim.state.phase, 'reeling');
  assert.equal(sim.state.reelHeld, false);
});

test('hold and release tension management can land a fish', () => {
  const sim = createTideSim({ tension: 'standard', duration: 25, seed: 4 });
  sim.cast(0.65, 0.1);
  until(sim, state => state.phase === 'bite');
  sim.hook();
  until(sim, state => state.phase !== 'reeling', 20);
  // The helper above does not steer, so restart with an adaptive reel cadence.
  if(sim.state.phase === 'snap'){
    sim.nextCast();
    sim.cast(0.65, 0.1);
    until(sim, state => state.phase === 'bite');
    sim.hook();
  }
  for(let i = 0; i < 2400 && sim.state.phase === 'reeling'; i += 1){
    const hold = sim.state.reelHeld ? sim.state.tension < 0.73 : sim.state.tension < 0.57;
    if(hold !== sim.state.reelHeld) sim.setReeling(hold);
    sim.step(dt);
  }
  assert.equal(sim.state.phase, 'catch');
  assert.equal(sim.state.catches, 1);
  assert.ok(sim.state.haulKg > 0);
  assert.ok(sim.state.score > 0);
});

test('continuous reeling snaps the line and waits for an explicit next cast', () => {
  const sim = createTideSim({ tension: 'standard', duration: 20, seed: 99 });
  sim.cast(1, 0);
  until(sim, state => state.phase === 'bite');
  sim.hook();
  sim.setReeling(true);
  until(sim, state => state.phase !== 'reeling', 10);
  assert.equal(sim.state.phase, 'snap');
  const snapped = sim.state;
  sim.step(1);
  assert.equal(sim.state.phase, 'snap');
  assert.equal(sim.state.castIndex, snapped.castIndex);
  assert.equal(sim.nextCast(), true);
  assert.equal(sim.state.phase, 'aim');
});

test('missed bites are explicit outcomes and terminal states do not mutate', () => {
  const sim = createTideSim({ duration: 3, fishPlan: () => ({ ...fishForCast({ seed: 2, castIndex: 0 }), biteDelay: 0.01 }) });
  sim.cast(0.4, 0);
  until(sim, state => state.phase === 'snap', 4);
  assert.equal(sim.state.lastOutcome.reason, 'missed-bite');
  assert.equal(sim.state.missedBites, 1);
  sim.nextCast();
  until(sim, state => state.status === 'finished', 4);
  const finished = sim.state;
  sim.step(dt);
  assert.deepEqual(sim.state, finished);
});

test('a cast launched before time is honored through every last-fish phase', () => {
  const easyFish = { ...fishForCast({ seed: 44, castIndex: 0 }), fight: 0.12, biteDelay: 0.05, surgePhase: 0 };
  const sim = createTideSim({ duration: 0.2, tension: 'relaxed', fishPlan: () => easyFish });
  assert.equal(sim.cast(0.5, 0), true);
  sim.step(0.2);
  assert.equal(sim.state.status, 'running');
  assert.equal(sim.state.phase, 'casting');
  assert.equal(sim.state.overtime, true);

  const seen = new Set([sim.state.phase]);
  for(let step = 0; step < 10000 && sim.state.phase !== 'catch'; step += 1){
    if(sim.state.phase === 'bite') sim.hook();
    if(sim.state.phase === 'reeling'){
      const hold = sim.state.reelHeld ? sim.state.tension < 0.76 : sim.state.tension < 0.58;
      if(hold !== sim.state.reelHeld) sim.setReeling(hold);
    }
    sim.step(dt);
    seen.add(sim.state.phase);
  }
  assert.deepEqual([...seen].filter(phase => ['casting', 'waiting', 'bite', 'reeling', 'catch'].includes(phase)), [
    'casting', 'waiting', 'bite', 'reeling', 'catch',
  ]);
  assert.equal(sim.state.catches, 1);
  assert.equal(sim.state.lastOutcome.zone.id, 'pier');
  assert.equal(sim.cast(0.5, 0), false);
  assert.equal(sim.nextCast(), true);
  assert.equal(sim.state.status, 'finished');
  assert.equal(sim.state.finishReason, 'last-fish');
});

test('competent zero-snap Quick watches can finish first or second at audited targets', () => {
  const haul = playCompetentRun({ session: 'quick', scoring: 'haul', seed: 7, power: 0.44, lateral: 0 });
  const trophy = playCompetentRun({ session: 'quick', scoring: 'trophy', seed: 7, power: 0.44, lateral: 0 });
  const rankFor = state => tideCompetition({
    session: state.session, scoring: state.scoring, time: state.duration, duration: state.duration,
    haulKg: state.haulKg, score: state.score,
  }).rank;
  assert.equal(haul.snaps, 0);
  assert.equal(trophy.snaps, 0);
  assert.equal(rankFor(haul), 2);
  assert.equal(rankFor(trophy), 1);
});

test('Full Trophy first place requires an excellent deep-channel watch', () => {
  const competent = playCompetentRun({ session: 'full', scoring: 'trophy', seed: 2, power: 0.44, lateral: 0 });
  const excellent = playCompetentRun({ session: 'full', scoring: 'trophy', seed: 2, power: 0.84, lateral: 0 });
  const rankFor = state => tideCompetition({
    session: state.session, scoring: state.scoring, time: state.duration, duration: state.duration,
    haulKg: state.haulKg, score: state.score,
  }).rank;
  assert.equal(competent.snaps, 0);
  assert.ok(rankFor(competent) > 1);
  assert.equal(excellent.snaps, 0);
  assert.equal(excellent.lastOutcome.zone.id, 'channel');
  assert.equal(rankFor(excellent), 1);
  assert.ok(excellent.score > competent.score);
});

test('trophy scoring rewards rare tiers more aggressively', () => {
  const fish = { ...fishForCast({ seed: 12, castIndex: 0 }), tier: 'trophy', weightKg: 18 };
  assert.ok(scoreFish(fish, 'trophy') > scoreFish(fish, 'haul'));
});
