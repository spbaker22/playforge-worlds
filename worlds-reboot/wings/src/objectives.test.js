import test from 'node:test';
import assert from 'node:assert/strict';
import { WING_MISSIONS } from './missions.js';
import {
  createMissionObjectiveState,
  missionObjectiveSummary,
  reduceMissionObjectives,
} from './objectives.js';

const phasedMission = {
  id: 'test-sortie',
  phases: [
    {
      id: 'opening',
      timeLimit: 20,
      objectives: [
        { id: 'gates', kind: 'gates', target: 2, required: true },
        { id: 'thermal', kind: 'thermals', target: 1, required: false },
      ],
    },
    {
      id: 'assault',
      timeLimit: 12,
      objectives: [
        { id: 'targets', kind: 'targets', target: 2, required: true },
        { id: 'clean', kind: 'clean-run', target: 1, required: false },
      ],
    },
  ],
};

test('objective reducer tracks progress, optionals, phases, and success verdict', () => {
  let state = createMissionObjectiveState(phasedMission);
  assert.equal(state.phaseId, 'opening');
  assert.equal(state.objectives.gates.status, 'active');
  assert.equal(state.objectives.targets.status, 'locked');

  state = reduceMissionObjectives(state, { type: 'progress', kind: 'thermals' });
  state = reduceMissionObjectives(state, { type: 'progress', objectiveId: 'gates', amount: 1 });
  state = reduceMissionObjectives(state, { type: 'progress', objectiveId: 'gates', amount: 1 });
  assert.equal(state.phaseId, 'assault');
  assert.deepEqual(state.completedPhaseIds, ['opening']);
  assert.equal(state.objectives.targets.status, 'active');

  state = reduceMissionObjectives(state, { type: 'progress', kind: 'targets', value: 2 });
  assert.equal(state.status, 'completed');
  assert.equal(state.verdict.outcome, 'success');
  assert.equal(state.objectives.clean.status, 'missed');
  assert.deepEqual(state.verdict.completedObjectiveIds, ['gates', 'thermal', 'targets']);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  assert.equal(reduceMissionObjectives(state, { type: 'mission-fail' }), state);
});

test('optional failure does not end a mission but required failure does', () => {
  let state = createMissionObjectiveState(phasedMission);
  state = reduceMissionObjectives(state, { type: 'objective-fail', objectiveId: 'thermal' });
  assert.equal(state.status, 'active');
  assert.equal(state.objectives.thermal.status, 'failed');
  state = reduceMissionObjectives(state, { type: 'objective-fail', objectiveId: 'gates' });
  assert.equal(state.status, 'failed');
  assert.equal(state.verdict.outcome, 'failure');
  assert.equal(state.verdict.reason, 'required-objective-failed');
});

test('phase clock produces a deterministic terminal timeout verdict', () => {
  let state = createMissionObjectiveState(phasedMission);
  state = reduceMissionObjectives(state, { type: 'tick', dt: 19.5 });
  assert.equal(state.status, 'active');
  state = reduceMissionObjectives(state, { type: 'tick', dt: 0.5 });
  assert.equal(state.status, 'failed');
  assert.equal(state.verdict.reason, 'phase-timeout');
  assert.equal(state.objectives.gates.status, 'failed');
  assert.equal(state.objectives.thermal.status, 'missed');
});

test('catalog missions normalize into a serializable single phase', () => {
  const mission = WING_MISSIONS.find(entry => entry.id === 'ridge-race');
  let state = createMissionObjectiveState(mission);
  state = reduceMissionObjectives(state, { type: 'objective-complete', objectiveId: 'ridge-podium' });
  state = reduceMissionObjectives(state, { type: 'objective-complete', objectiveId: 'ridge-finish' });
  const summary = missionObjectiveSummary(state);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.requiredCompleted, 1);
  assert.equal(summary.optionalCompleted, 1);
  assert.equal(summary.phaseCount, 1);
});
