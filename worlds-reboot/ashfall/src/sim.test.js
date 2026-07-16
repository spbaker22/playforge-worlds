import test from 'node:test';
import assert from 'node:assert/strict';
import { ASHFALL_INTENSITY, ashfallDuration, createAshfallSim } from './sim.js';

function run(sim, seconds, dt = 1 / 120){
  const count = Math.ceil(seconds / dt);
  for(let i = 0; i < count && sim.state.status === 'running'; i += 1) sim.step(dt);
  return sim.state;
}

function runOrbit(mode, intensity){
  const sim = createAshfallSim({ mode, intensity, seed: 0xA5F411 });
  let nextTargetAt = 0;
  while(sim.state.status === 'running'){
    const time = sim.state.time;
    if(time + 1e-9 >= nextTargetAt){
      sim.setTarget(5.4 * Math.cos(1.35 * time), 0.1 + 3.8 * Math.sin(1.35 * time));
      nextTargetAt += 0.1;
    }
    sim.step(1 / 120);
  }
  return sim.state;
}

const RESPONSE_TARGETS = Object.freeze([
  [-5.2, -3.5], [0, -3.5], [5.2, -3.5],
  [-5.2, 0.1], [0, 0.1], [5.2, 0.1],
  [-5.2, 4], [0, 4], [5.2, 4],
]);

function runResponsive(mode, intensity){
  const sim = createAshfallSim({ mode, intensity, seed: 0xA5F411 });
  let nextDecisionAt = 0;
  let dashes = 0;
  while(sim.state.status === 'running'){
    const state = sim.state;
    if(state.time + 1e-9 >= nextDecisionAt){
      const pending = state.hazards.filter(hazard => {
        const timeToImpact = hazard.impactAt - state.time;
        return !hazard.resolved && timeToImpact > 0 && timeToImpact <= 1.75;
      });
      let target = RESPONSE_TARGETS[4];
      let bestScore = -Infinity;
      for(const candidate of RESPONSE_TARGETS){
        let score = 20;
        for(const hazard of pending){
          const timeToImpact = hazard.impactAt - state.time;
          const hitRadius = sim.config.hitRadius * (hazard.radiusScale ?? 1);
          const margin = Math.hypot(candidate[0] - hazard.x, candidate[1] - hazard.z) - hitRadius;
          score = Math.min(score, margin + Math.min(timeToImpact, 1) * 0.25);
        }
        score -= Math.hypot(candidate[0] - state.x, candidate[1] - state.z) * 0.035;
        if(score > bestScore){ bestScore = score; target = candidate; }
      }
      sim.setTarget(target[0], target[1]);
      const wavePending = pending.some(hazard => hazard.kind === 'perimeter-wave');
      const dangerClose = pending.some(hazard => {
        const hitRadius = sim.config.hitRadius * (hazard.radiusScale ?? 1);
        return hazard.impactAt - state.time < 0.8
          && Math.hypot(state.x - hazard.x, state.z - hazard.z) < hitRadius + 1.4;
      });
      if(state.dashReady && (dangerClose || (wavePending && Math.hypot(state.x, state.z - 0.1) > 2.3))){
        if(sim.dash()) dashes += 1;
      }
      nextDecisionAt += 0.1;
    }
    sim.step(1 / 120);
  }
  return { state: sim.state, dashes };
}

test('URL mode durations and intensity profiles are explicit', () => {
  assert.equal(ashfallDuration('quick'), 30);
  assert.equal(ashfallDuration('full'), 60);
  assert.ok(ASHFALL_INTENSITY.calm.telegraphLead > ASHFALL_INTENSITY.inferno.telegraphLead);
  assert.ok(ASHFALL_INTENSITY.calm.cadence > ASHFALL_INTENSITY.inferno.cadence);
  assert.ok(ASHFALL_INTENSITY.calm.meteorSpeed < ASHFALL_INTENSITY.inferno.meteorSpeed);
});

test('the same seed and fixed-step inputs produce identical runs', () => {
  const a = createAshfallSim({ mode: 'quick', intensity: 'standard', seed: 42, duration: 4 });
  const b = createAshfallSim({ mode: 'quick', intensity: 'standard', seed: 42, duration: 4 });
  a.setTarget(4, -2); b.setTarget(4, -2);
  a.dash(); b.dash();
  run(a, 4); run(b, 4);
  assert.deepEqual(a.state, b.state);
  assert.deepEqual(a.drainEvents(), b.drainEvents());
});

test('dash fires once, moves smoothly, and respects cooldown', () => {
  const sim = createAshfallSim({ mode: 'quick', intensity: 'calm', seed: 8, duration: 3, initialSpawnDelay: 10 });
  sim.setTarget(5, 1.2);
  assert.equal(sim.dash(), true);
  assert.equal(sim.dash(), false);
  const startX = sim.state.x;
  run(sim, 0.25);
  assert.ok(sim.state.x > startX + 2);
  assert.ok(sim.state.dashCooldown > 0);
  run(sim, 1.1);
  assert.equal(sim.dash(), true);
});

test('impact damage honors invulnerability and ends at zero hearts', () => {
  const sim = createAshfallSim({
    mode: 'quick',
    intensity: 'inferno',
    seed: 3,
    duration: 8,
    initialSpawnDelay: 0,
    hazardPlan: () => ({ x: 0, z: 1.2, leadScale: 0.06 }),
  });
  run(sim, 0.2);
  assert.equal(sim.state.hearts, 2);
  const firstHitCount = sim.state.hits;
  run(sim, 0.5);
  assert.equal(sim.state.hits, firstHitCount);
  run(sim, 4);
  assert.equal(sim.state.status, 'lost');
  assert.equal(sim.state.hearts, 0);
});

test('direct impacts on an active shield never become rewarded near misses', () => {
  const sim = createAshfallSim({
    mode: 'quick',
    intensity: 'inferno',
    seed: 3,
    duration: 4,
    initialSpawnDelay: 0,
    hazardPlan: () => ({ x: 0, z: 1.2, leadScale: 0.05 }),
  });
  const events = [];
  for(let index = 0; index < 120 && !events.some(event => event.type === 'shielded'); index += 1){
    sim.step(1 / 120);
    events.push(...sim.drainEvents());
  }
  assert.equal(events.filter(event => event.type === 'hit').length, 1);
  assert.equal(events.filter(event => event.type === 'shielded').length, 1);
  assert.equal(events.filter(event => event.type === 'near-miss').length, 0);
  assert.equal(sim.state.nearMisses, 0);
  assert.ok(sim.state.score < 90, 'shielded contact must not receive the +90 near-miss award');
});

test('completed survival outranks intentional failure in every mode and intensity', () => {
  for(const mode of ['quick', 'full']){
    for(const intensity of ['calm', 'standard', 'inferno']){
      const won = createAshfallSim({
        mode,
        intensity,
        seed: 17,
        hazardPlan: () => ({ x: 6.2, z: -4.4, leadScale: 0.05 }),
      });
      const lost = createAshfallSim({
        mode,
        intensity,
        seed: 17,
        initialSpawnDelay: 0,
        hazardPlan: () => ({ x: 0, z: 1.2, leadScale: 0.05 }),
      });
      run(won, won.state.duration + 1 / 120);
      run(lost, lost.state.duration + 1 / 120);
      assert.equal(won.state.status, 'won', `${mode}/${intensity} should complete`);
      assert.equal(lost.state.status, 'lost', `${mode}/${intensity} should fail`);
      assert.ok(won.state.completionBonus > 0);
      assert.ok(won.state.score > lost.state.score, `${mode}/${intensity}: ${won.state.score} should beat ${lost.state.score}`);
    }
  }
});

test('a clean rescue outranks each default-seed idle run that fails', () => {
  let comparedFailures = 0;
  for(const mode of ['quick', 'full']){
    for(const intensity of ['calm', 'standard', 'inferno']){
      const rescued = createAshfallSim({
        mode,
        intensity,
        seed: 0xA5F411,
        hazardPlan: () => ({ x: 6.2, z: -4.4, leadScale: 0.05 }),
      });
      const idle = createAshfallSim({ mode, intensity, seed: 0xA5F411 });
      run(rescued, rescued.state.duration + 1 / 120);
      run(idle, idle.state.duration + 1 / 120);
      if(idle.state.status === 'lost'){
        comparedFailures += 1;
        assert.ok(rescued.state.score > idle.state.score, `${mode}/${intensity}: rescue ${rescued.state.score} should beat idle failure ${idle.state.score}`);
      }
    }
  }
  assert.ok(comparedFailures >= 5, 'default seed should retain representative idle failures');
});

test('survival reaches a terminal win and cannot advance destructively', () => {
  const sim = createAshfallSim({ mode: 'quick', intensity: 'calm', seed: 9, duration: 1, initialSpawnDelay: 10 });
  run(sim, 1.1);
  const won = sim.state;
  assert.equal(won.status, 'won');
  assert.equal(won.time, 1);
  assert.ok(won.completionBonus > 0);
  sim.step(1 / 120);
  assert.deepEqual(sim.state, won);
});

test('seeded perimeter wave has one stable readable gap and uses existing telegraphs', () => {
  const a = createAshfallSim({ mode: 'quick', intensity: 'standard', seed: 0xA5F411 });
  const b = createAshfallSim({ mode: 'quick', intensity: 'standard', seed: 0xA5F411 });
  const c = createAshfallSim({ mode: 'quick', intensity: 'standard', seed: 0xA5F412 });
  run(a, 6.1); run(b, 6.1); run(c, 6.1);
  const waveEventsA = a.drainEvents().filter(event => event.type === 'wave-telegraph' || event.kind === 'perimeter-wave');
  const waveEventsB = b.drainEvents().filter(event => event.type === 'wave-telegraph' || event.kind === 'perimeter-wave');
  assert.deepEqual(waveEventsA, waveEventsB);
  const alternateGap = c.drainEvents().find(event => event.type === 'wave-telegraph');
  assert.notEqual(alternateGap.gapIndex, waveEventsA.find(event => event.type === 'wave-telegraph').gapIndex);
  const wave = a.state.hazards.filter(hazard => hazard.kind === 'perimeter-wave');
  assert.equal(wave.length, 11, 'a 12-slot perimeter must omit exactly one safe gap');
  assert.equal(new Set(wave.map(hazard => hazard.waveId)).size, 1);
  assert.ok(wave.every(hazard => hazard.radiusScale === 1.2));
  assert.ok(wave.every(hazard => hazard.impactAt - hazard.spawnedAt >= 1.45 - 1e-9));
});

test('the exact 100ms no-dash orbit degrades in quick play and fails full play', () => {
  const results = new Map();
  for(const mode of ['quick', 'full']){
    for(const intensity of ['calm', 'standard', 'inferno']){
      results.set(`${mode}/${intensity}`, runOrbit(mode, intensity));
    }
  }
  assert.ok(results.get('quick/standard').hearts < 3);
  assert.ok(results.get('quick/inferno').hearts < 3);
  assert.ok([...results.values()].some(state => state.status === 'lost'), 'orbit must not win every mode');
  assert.equal(results.get('full/standard').status, 'lost');
  assert.equal(results.get('full/inferno').status, 'lost');
});

test('telegraph-aware movement and dash wins quick danger modes and representative full modes', () => {
  for(const [mode, intensity] of [
    ['quick', 'calm'],
    ['quick', 'standard'],
    ['quick', 'inferno'],
    ['full', 'calm'],
    ['full', 'standard'],
    ['full', 'inferno'],
  ]){
    const result = runResponsive(mode, intensity);
    assert.equal(result.state.status, 'won', `${mode}/${intensity} should remain winnable`);
    assert.ok(result.state.hearts >= 1, `${mode}/${intensity} should finish with a heart`);
    assert.ok(result.dashes > 0, `${mode}/${intensity} response should exercise dash timing`);
  }
});
