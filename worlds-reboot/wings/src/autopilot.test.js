import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMissionCommandTape,
  createMissionAutopilot,
  nextMissionAutopilot,
  replayMissionCommandTape,
} from './autopilot.js';
import { createFlightState, FLIGHT_STATUS, MISSION_STEP_ORDER, startFlight } from './flight.js';
import { WING_MISSION_IDS } from './missions.js';
import { createWingRoute } from './route.js';

test('autopilot commands are deterministic plain data with explicit subsystem order', () => {
  const route = createWingRoute('full');
  const flight = createFlightState(route, { missionId: 'ridge-race', seed: 77 });
  startFlight(flight);
  const original = createMissionAutopilot('ridge-race');
  const first = nextMissionAutopilot(original, flight, route);
  const second = nextMissionAutopilot(original, flight, route);
  assert.deepEqual(first, second);
  assert.equal(original.step, 0);
  assert.equal(first.command.branch, 'shortcut');
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.deepEqual(MISSION_STEP_ORDER, [
    'command', 'route', 'aero', 'movement', 'gates-and-volumes',
    'stunts', 'combat', 'rivals', 'objectives', 'scoring', 'terminal',
  ]);
});

test('scripted command tapes complete all eight authored missions', () => {
  for(const missionId of WING_MISSION_IDS){
    const tape = buildMissionCommandTape(missionId, { seed: 0x51a7 });
    assert.equal(tape.finalSnapshot.status, FLIGHT_STATUS.FINISHED, missionId);
    assert.equal(tape.finalSnapshot.result.completed, true, missionId);
    assert.equal(tape.finalSnapshot.result.outcome, 'success', missionId);
    assert.equal(tape.finalSnapshot.objectives.verdict.requiredCompleted, tape.finalSnapshot.objectives.verdict.requiredTotal, missionId);
    assert.equal(tape.finalSnapshot.gatesPassed, 12, missionId);
    assert.ok(tape.frames.length > 0 && tape.frames.length < 60 * 90, missionId);
    assert.doesNotThrow(() => JSON.stringify(tape), missionId);
  }
});

test('every recorded mission tape replays to an identical immutable snapshot', () => {
  for(const missionId of WING_MISSION_IDS){
    const tape = buildMissionCommandTape(missionId, { seed: 0xabc123 });
    const replay = replayMissionCommandTape(tape);
    assert.deepEqual(replay, tape.finalSnapshot, missionId);
    assert.equal(Object.isFrozen(replay), true);
    assert.equal(Object.isFrozen(replay.objectives), true);
    assert.equal(Object.isFrozen(replay.eventBuffer), true);
  }
});
