import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMissionCommandTape, replayMissionCommandTape } from './autopilot.js';
import { createWingRoute, raceStanding } from './route.js';
import { createFlightState, flightSnapshot, flightStanding, FLIGHT_STATUS, MISSION_FLIGHT_PLANS, startFlight, stepFlight } from './flight.js';
import { WING_MISSION_IDS } from './missions.js';

function runCentered(route, { seconds = 60, control = 'guided', race = 'solo', forceMisses = 0 } = {}){
  const state = createFlightState(route, { control, race });
  startFlight(state);
  const dt = 1 / 120;
  let forced = 0;
  for(let i = 0; i < seconds / dt && ![FLIGHT_STATUS.FINISHED, FLIGHT_STATUS.FAILED].includes(state.status); i += 1){
    const point = route.gates[Math.min(state.gateIndex, route.gates.length - 1)];
    if(forced < forceMisses && state.status === FLIGHT_STATUS.FLYING && state.s + state.speed * dt >= point.s){
      state.x = 70;
      state.y = 60;
      forced += 1;
    }
    const bank = Math.max(-1, Math.min(1, (point.x - state.x) / 11));
    const pitch = Math.max(-1, Math.min(1, (point.y - state.y) / 8));
    stepFlight(state, dt, { bank, pitch }, route);
  }
  return state;
}

function assertDeepFrozenGraph(value, seen = new Set()){
  if(value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for(const child of Object.values(value)) assertDeepFrozenGraph(child, seen);
}

test('same fixed-step input produces identical flight snapshots', () => {
  const route = createWingRoute('quick');
  const a = createFlightState(route);
  const b = createFlightState(route);
  startFlight(a);
  startFlight(b);
  for(let i = 0; i < 800; i += 1){
    const axes = { bank: Math.sin(i * 0.013) * 0.35, pitch: Math.cos(i * 0.009) * 0.2 };
    stepFlight(a, 1 / 120, axes, route);
    stepFlight(b, 1 / 120, axes, route);
  }
  assert.deepEqual(flightSnapshot(a), flightSnapshot(b));
});

test('crossing a centered gate advances exactly once', () => {
  const route = createWingRoute('quick');
  const state = createFlightState(route, { race: 'solo' });
  startFlight(state);
  const gate = route.gates[0];
  state.s = gate.s - 0.1;
  state.x = gate.x;
  state.y = gate.y;
  state.speed = 20;
  stepFlight(state, 0.01, { bank: 0, pitch: 0 }, route);
  assert.equal(state.gatesPassed, 1);
  assert.equal(state.gateIndex, 1);
  assert.equal(state.event, 'gate');
});

test('a miss recovers to an approach and allows a retry', () => {
  const route = createWingRoute('quick');
  const state = createFlightState(route);
  startFlight(state);
  const gate = route.gates[0];
  state.s = gate.s - 0.1;
  state.x = 70;
  state.y = 60;
  stepFlight(state, 0.01, { bank: 0, pitch: 0 }, route);
  assert.equal(state.status, FLIGHT_STATUS.RECOVERING);
  assert.equal(state.misses, 1);
  for(let i = 0; i < 150; i += 1) stepFlight(state, 0.01, {}, route);
  assert.equal(state.status, FLIGHT_STATUS.FLYING);
  assert.equal(state.gateIndex, 0);
  assert.ok(state.s < gate.s);
});

test('three misses at one gate produce a terminal fail', () => {
  const route = createWingRoute('quick');
  const state = createFlightState(route);
  startFlight(state);
  const gate = route.gates[0];
  for(let miss = 0; miss < 3; miss += 1){
    state.status = FLIGHT_STATUS.FLYING;
    state.s = gate.s - 0.01;
    state.x = 70;
    state.y = 60;
    stepFlight(state, 0.01, {}, route);
  }
  assert.equal(state.status, FLIGHT_STATUS.FAILED);
  assert.equal(state.misses, 3);
});

test('guided autopilot completes the six-gate route', () => {
  const state = runCentered(createWingRoute('quick'));
  assert.equal(state.status, FLIGHT_STATUS.FINISHED);
  assert.equal(state.gatesPassed, 6);
  assert.equal(state.rank, 1);
});

test('a clean quick race narrowly wins and one recovery costs position', () => {
  const route = createWingRoute('quick');
  const clean = runCentered(route, { race: 'rivals' });
  const recovered = runCentered(route, { race: 'rivals', forceMisses: 1 });
  assert.equal(clean.status, FLIGHT_STATUS.FINISHED);
  assert.equal(clean.rank, 1);
  assert.ok(clean.finishTime < 19.5);
  assert.ok(clean.finishTime > 18);
  assert.equal(recovered.status, FLIGHT_STATUS.FINISHED);
  assert.equal(recovered.misses, 1);
  assert.ok(recovered.finishTime > clean.finishTime);
  assert.ok(recovered.rank > clean.rank);
});

test('recovered quick terminal standing keeps the authoritative result rank', () => {
  const route = createWingRoute('quick');
  const live = createFlightState(route, { race: 'rivals' });
  startFlight(live);
  stepFlight(live, 1, { bank: 0, pitch: 0 }, route);
  assert.deepEqual(flightStanding(live, route), raceStanding(live.s, live.time, route, live.race));

  const recovered = runCentered(route, { race: 'rivals', forceMisses: 1 });
  assert.equal(recovered.status, FLIGHT_STATUS.FINISHED);
  assert.equal(recovered.rank, 3);
  assert.equal(raceStanding(recovered.s, recovered.time, route, recovered.race).rank, 1);
  assert.equal(flightStanding(recovered, route).rank, 3);
  assert.equal(flightStanding(recovered, route).total, 4);
});

test('both control profiles complete the authored twelve-gate route deterministically', () => {
  for(const control of ['guided', 'direct']){
    const route = createWingRoute('full');
    const first = createFlightState(route, { control, race: 'solo' });
    const second = createFlightState(route, { control, race: 'solo' });
    startFlight(first);
    startFlight(second);
    for(let i = 0; i < 70 * 120 && first.status === FLIGHT_STATUS.FLYING; i += 1){
      const gate = route.gates[Math.min(first.gateIndex, route.gates.length - 1)];
      const axes = {
        bank: Math.max(-1, Math.min(1, (gate.x - first.x) / 11)),
        pitch: Math.max(-1, Math.min(1, (gate.y - first.y) / 8)),
      };
      stepFlight(first, 1 / 120, axes, route);
      stepFlight(second, 1 / 120, axes, route);
    }
    assert.equal(first.status, FLIGHT_STATUS.FINISHED);
    assert.equal(first.gatesPassed, 12);
    assert.deepEqual(flightSnapshot(first), flightSnapshot(second));
  }
});

test('legacy snapshots retain every flattened compatibility field', () => {
  const snapshot = flightSnapshot(createFlightState(createWingRoute('quick')));
  assert.deepEqual(Object.keys(snapshot), [
    'status', 'time', 's', 'x', 'y', 'bank', 'pitch', 'speed', 'gateIndex',
    'gatesPassed', 'misses', 'retriesAtGate', 'recoveryRemaining', 'event',
    'eventSequence', 'finishTime', 'rank', 'control', 'race',
  ]);
});

test('mission snapshots preserve semantic shape while deeply detached and frozen', () => {
  const route = createWingRoute('full');
  const state = createFlightState(route, { missionId: 'target-run', race: 'rivals', seed: 0x5a17 });
  startFlight(state);
  stepFlight(state, 0.01, {}, route, { fire: true });
  assert.ok(state.combat.targets.length > 0);
  assert.ok(state.combat.projectiles.length > 0);
  assert.ok(state.eventBuffer.length > 0);

  const identity = {
    routeTraversal: state.routeTraversal,
    aero: state.aero,
    objectives: state.objectives,
    combat: state.combat,
    targets: state.combat.targets,
    projectiles: state.combat.projectiles,
    rescue: state.rescue,
    rivals: state.rivals,
    eventBuffer: state.eventBuffer,
  };
  const first = flightSnapshot(state);
  assert.deepEqual(Object.keys(first), [
    'status', 'time', 's', 'x', 'y', 'bank', 'pitch', 'speed', 'gateIndex',
    'gatesPassed', 'misses', 'retriesAtGate', 'recoveryRemaining', 'event',
    'eventSequence', 'finishTime', 'rank', 'control', 'race', 'missionId',
    'missionSeed', 'missionStep', 'energy', 'integrity', 'score', 'combo',
    'bestCombo', 'phaseId', 'shotsFired', 'shotsHit', 'routeTraversal', 'aero',
    'objectives', 'stunts', 'scoring', 'combat', 'rescue', 'rivals',
    'eventBuffer', 'encounteredVolumeIds', 'resolvedActionIds', 'result',
  ]);
  for(const key of [
    'routeTraversal', 'aero', 'objectives', 'stunts', 'scoring', 'combat',
    'rescue', 'rivals', 'eventBuffer', 'encounteredVolumeIds', 'resolvedActionIds', 'result',
  ]){
    assert.deepEqual(first[key], state[key], key);
    if(state[key] && typeof state[key] === 'object') assert.notEqual(first[key], state[key], key);
  }
  assert.notEqual(first.combat.targets, state.combat.targets);
  assert.notEqual(first.combat.targets[0], state.combat.targets[0]);
  assert.notEqual(first.combat.projectiles, state.combat.projectiles);
  assert.notEqual(first.combat.projectiles[0], state.combat.projectiles[0]);
  assert.notEqual(first.eventBuffer[0], state.eventBuffer[0]);
  assertDeepFrozenGraph(first);
  assert.doesNotThrow(() => JSON.stringify(first));

  for(let read = 0; read < 8; read += 1) assert.deepEqual(flightSnapshot(state), first);
  for(const [key, reference] of Object.entries(identity)){
    const current = key === 'targets' || key === 'projectiles' ? state.combat[key] : state[key];
    assert.equal(current, reference, `${key} identity changed during snapshot reads`);
  }

  const targetX = first.combat.targets[0].x;
  const projectileS = first.combat.projectiles[0].s;
  const eventType = first.eventBuffer[0].type;
  state.combat.targets[0].x += 1000;
  state.combat.projectiles[0].s += 1000;
  state.eventBuffer[0].type = 'mutated-after-snapshot';
  state.routeTraversal.branchChoices.afterSnapshot = 'shortcut';
  state.encounteredVolumeIds.push('after-snapshot');
  assert.equal(first.combat.targets[0].x, targetX);
  assert.equal(first.combat.projectiles[0].s, projectileS);
  assert.equal(first.eventBuffer[0].type, eventType);
  assert.equal(first.routeTraversal.branchChoices.afterSnapshot, undefined);
  assert.equal(first.encounteredVolumeIds.includes('after-snapshot'), false);
});

test('flight snapshot implementation has no serialization clone fallback', () => {
  const source = readFileSync(new URL('./flight.js', import.meta.url), 'utf8');
  const start = source.indexOf('function copyFrozenSnapshotGraph');
  const snapshotPath = source.slice(start);
  assert.ok(start >= 0, 'structural snapshot copier is missing');
  assert.doesNotMatch(snapshotPath, /JSON\.(?:parse|stringify)\s*\(/);
  assert.doesNotMatch(snapshotPath, /\bstructuredClone\s*\(/);
});

test('mission commands orchestrate shared energy, shield, hull, and terminal results', () => {
  const route = createWingRoute('full');
  const state = createFlightState(route, { missionId: 'storm-escape', race: 'solo', seed: 91 });
  startFlight(state);
  const initialEnergy = state.energy;
  stepFlight(state, 0.25, { bank: 0, pitch: 0 }, route, { boost: true });
  assert.ok(state.speed > 18);
  assert.ok(state.energy < initialEnergy);
  const integrity = state.integrity;
  stepFlight(state, 0.01, {}, route, { shield: true, impact: 1 });
  assert.equal(state.integrity, integrity);
  assert.ok(state.aero.shieldHits >= 1);
  stepFlight(state, 0.01, {}, route, { shield: false, impact: 3 });
  assert.equal(state.status, FLIGHT_STATUS.FAILED);
  assert.equal(state.result.outcome, 'failure');
  assert.equal(state.result.reason, 'hull-disabled');
  const snapshot = flightSnapshot(state);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.aero), true);
  assert.equal(Object.isFrozen(snapshot.eventBuffer), true);
});

test('every mission snapshot exposes an immutable rescue contract with authored runtime positions', () => {
  const route = createWingRoute('full');
  for(const missionId of WING_MISSION_IDS){
    const snapshot = flightSnapshot(createFlightState(route, { missionId, race: 'solo' }));
    assert.equal(Object.isFrozen(snapshot.rescue), true, missionId);
    assert.equal(Object.isFrozen(snapshot.rescue.entities), true, missionId);
    assert.equal(snapshot.rescue.missionId, missionId);
    if(missionId !== 'mountain-rescue'){
      assert.deepEqual(snapshot.rescue, {
        missionId, entities: [], pickups: [], dropZones: [], parcels: [],
      });
      continue;
    }
    assert.deepEqual(snapshot.rescue.entities.map(entity => entity.id), [
      'rescue-1', 'drop-1', 'rescue-2', 'drop-2', 'rescue-3', 'drop-3',
    ]);
    assert.deepEqual(snapshot.rescue.pickups.map(entity => entity.id), ['rescue-1', 'rescue-2', 'rescue-3']);
    assert.deepEqual(snapshot.rescue.dropZones.map(entity => entity.id), ['drop-1', 'drop-2', 'drop-3']);
    for(const entity of snapshot.rescue.entities){
      assert.equal(Object.isFrozen(entity), true);
      assert.ok(Number.isFinite(entity.s) && Number.isFinite(entity.x) && Number.isFinite(entity.y));
      assert.ok(entity.radius > 0);
      assert.equal(entity.active, true);
      assert.equal(entity.unlocked, false);
      assert.equal(entity.eligible, false);
      assert.equal(entity.resolved, false);
    }
  }
});

test('early and ineligible rescue taps are ignored without consuming the six completable actions', () => {
  const route = createWingRoute('full');
  const state = createFlightState(route, { missionId: 'mountain-rescue', race: 'solo', seed: 0x51a7 });
  startFlight(state);

  stepFlight(state, 0, {}, route, { rescueId: 'rescue-1', dropId: 'drop-1' });
  stepFlight(state, 0, {}, route, { rescueId: 'drop-1', dropId: 'not-authored' });
  assert.deepEqual(state.resolvedActionIds, []);
  assert.ok(state.rescue.entities.every(entity => !entity.resolved));

  const actions = [
    { s: 140, key: 'rescueId', id: 'rescue-1' },
    { s: 210, key: 'dropId', id: 'drop-1' },
    { s: 330, key: 'rescueId', id: 'rescue-2' },
    { s: 390, key: 'dropId', id: 'drop-2' },
    { s: 520, key: 'rescueId', id: 'rescue-3' },
    { s: 570, key: 'dropId', id: 'drop-3' },
  ];
  for(const action of actions){
    state.s = action.s;
    stepFlight(state, 0, {}, route, { [action.key]: action.id });
    assert.ok(state.resolvedActionIds.includes(action.id), action.id);
  }

  assert.deepEqual(state.resolvedActionIds, actions.map(action => action.id));
  assert.equal(state.objectives.objectives['rescue-first-signal'].status, 'completed');
  assert.equal(state.objectives.objectives['rescue-climbers'].status, 'completed');
  assert.equal(state.objectives.objectives['rescue-drops'].status, 'completed');
  assert.equal(state.objectives.phaseId, 'rescue-return');
  const snapshot = flightSnapshot(state);
  assert.ok(snapshot.rescue.entities.every(entity => entity.resolved && !entity.active && !entity.eligible));
});

function placeFlightAtHazard(state, hazard, { outside = false } = {}){
  state.s = hazard.s - 0.01;
  state.x = outside ? -76 : hazard.x;
  state.y = outside ? 64 : hazard.y;
  state.aero = {
    ...state.aero,
    altitude: state.y,
    speed: 20,
    verticalSpeed: 0,
  };
  state.speed = 20;
}

test('route hazards respect spatial dodge, shield, hull, and explicit unavoidable authority', () => {
  const route = createWingRoute('full');
  const hazard = route.volumes.hazards[0];

  const dodged = createFlightState(route, { missionId: 'storm-escape', race: 'solo', seed: 7 });
  startFlight(dodged);
  placeFlightAtHazard(dodged, hazard, { outside: true });
  stepFlight(dodged, 0.01, {}, route);
  assert.equal(dodged.integrity, 3);
  assert.equal(dodged.aero.unshieldedHits, 0);
  assert.ok(dodged.encounteredVolumeIds.includes(hazard.id));
  assert.equal(dodged.eventBuffer.at(-1).type, 'hazard-dodged');

  const shielded = createFlightState(route, { missionId: 'storm-escape', race: 'solo', seed: 8 });
  startFlight(shielded);
  placeFlightAtHazard(shielded, hazard);
  const shieldEnergy = shielded.energy;
  stepFlight(shielded, 0.01, {}, route, { shield: true });
  assert.equal(shielded.integrity, 3);
  assert.equal(shielded.aero.shieldHits, 1);
  assert.ok(shielded.energy < shieldEnergy);
  assert.equal(shielded.eventBuffer.at(-1).type, 'hazard-blocked');

  const hit = createFlightState(route, { missionId: 'storm-escape', race: 'solo', seed: 9 });
  startFlight(hit);
  placeFlightAtHazard(hit, hazard);
  stepFlight(hit, 0.01, {}, route);
  assert.equal(hit.integrity, 2);
  assert.equal(hit.aero.unshieldedHits, 1);
  assert.equal(hit.eventBuffer.at(-1).type, 'hazard-hit');

  const unavoidableHazard = Object.freeze({ ...hazard, id: 'authored-unavoidable', unavoidable: true });
  const unavoidableRoute = Object.freeze({
    ...route,
    volumes: Object.freeze({ ...route.volumes, hazards: Object.freeze([unavoidableHazard]) }),
  });
  const unavoidable = createFlightState(unavoidableRoute, { missionId: 'storm-escape', race: 'solo', seed: 10 });
  startFlight(unavoidable);
  placeFlightAtHazard(unavoidable, unavoidableHazard, { outside: true });
  stepFlight(unavoidable, 0.01, {}, unavoidableRoute);
  assert.equal(unavoidable.integrity, 2);
  assert.equal(unavoidable.eventBuffer.at(-1).type, 'hazard-hit');
  assert.equal(unavoidable.eventBuffer.at(-1).unavoidable, true);
});

test('all eight full-route autopilot runs still complete and replay to equal frozen snapshots', () => {
  for(const missionId of WING_MISSION_IDS){
    const tape = buildMissionCommandTape(missionId, { routeId: 'full', seed: 0x7e57 });
    const replay = replayMissionCommandTape(tape);
    assert.equal(tape.routeId, 'full', missionId);
    assert.equal(tape.finalSnapshot.status, FLIGHT_STATUS.FINISHED, missionId);
    assert.equal(tape.finalSnapshot.result?.outcome, 'success', missionId);
    assert.deepEqual(replay, tape.finalSnapshot, missionId);
    assert.equal(Object.isFrozen(replay), true, missionId);
    assert.equal(Object.isFrozen(replay.rescue), true, missionId);
  }
});

test('all eight mission plans expose multiple deterministic phases', () => {
  assert.equal(Object.keys(MISSION_FLIGHT_PLANS).length, 8);
  for(const plan of Object.values(MISSION_FLIGHT_PLANS)){
    assert.ok(plan.phases.length >= 2, plan.id);
    assert.ok(plan.phases.every(phase => phase.objectives.some(objective => objective.required)), plan.id);
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  }
});
