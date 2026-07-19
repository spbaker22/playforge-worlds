import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMissionResult, createCampaignState } from './campaign.js';
import { WING_FLOW_ACTION, canSelectWingMission, createWingFlowState, reduceWingFlow, wingFlowSnapshot } from './flow.js';

function reduce(state, type, fields = {}, campaign = createCampaignState()){
  return reduceWingFlow(state, { type, ...fields }, { campaign });
}

function enterPlay(campaign = createCampaignState(), missionId = 'flight-school'){
  let state = createWingFlowState();
  state = reduce(state, WING_FLOW_ACTION.OPEN_CAMPAIGN, {}, campaign);
  state = reduce(state, WING_FLOW_ACTION.SELECT_MISSION, { missionId }, campaign);
  state = reduce(state, WING_FLOW_ACTION.CONFIRM_BRIEFING, {}, campaign);
  state = reduce(state, WING_FLOW_ACTION.COUNTDOWN_COMPLETE, {}, campaign);
  return state;
}

test('guarded campaign flow reaches play through one authoritative mode', () => {
  const campaign = createCampaignState();
  let state = createWingFlowState();
  assert.equal(state.mode, 'title');
  state = reduce(state, WING_FLOW_ACTION.OPEN_CAMPAIGN, {}, campaign);
  assert.equal(state.mode, 'campaign');
  state = reduce(state, WING_FLOW_ACTION.SELECT_MISSION, { missionId: 'flight-school' }, campaign);
  assert.equal(state.mode, 'briefing');
  assert.equal(state.activeMissionId, 'flight-school');
  state = reduce(state, WING_FLOW_ACTION.CONFIRM_BRIEFING, {}, campaign);
  assert.equal(state.mode, 'countdown');
  state = reduce(state, WING_FLOW_ACTION.COUNTDOWN_COMPLETE, {}, campaign);
  assert.equal(state.mode, 'play');

  state = reduce(state, WING_FLOW_ACTION.PHASE_CHANGE, { phaseId: 'thermal-run', label: 'RIDE THE LIFT' }, campaign);
  assert.equal(state.mode, 'play', 'phase overlay must not become a competing mode');
  assert.deepEqual(state.overlay, { id: 'phase-overlay-0001', type: 'phase-change', phaseId: 'thermal-run', label: 'RIDE THE LIFT' });
  state = reduce(state, WING_FLOW_ACTION.DISMISS_OVERLAY, {}, campaign);
  assert.equal(state.mode, 'play');
  assert.equal(state.overlay, null);
});

test('mission selection fails closed for locked and unknown missions', () => {
  const campaign = createCampaignState();
  let state = reduce(createWingFlowState(), WING_FLOW_ACTION.OPEN_CAMPAIGN, {}, campaign);
  state = reduce(state, WING_FLOW_ACTION.SELECT_MISSION, { missionId: 'ridge-race' }, campaign);
  assert.equal(state.mode, 'campaign');
  assert.deepEqual({ accepted: state.lastDecision.accepted, code: state.lastDecision.code }, { accepted: false, code: 'mission-locked' });
  state = reduce(state, WING_FLOW_ACTION.SELECT_MISSION, { missionId: 'not-a-mission' }, campaign);
  assert.equal(state.lastDecision.code, 'unknown-mission');
  assert.equal(canSelectWingMission(campaign, 'flight-school'), true);
  assert.equal(canSelectWingMission(campaign, 'ridge-race'), false);
});

test('recovery returns to the same mission play authority', () => {
  const campaign = createCampaignState();
  let state = enterPlay(campaign);
  state = reduce(state, WING_FLOW_ACTION.BEGIN_RECOVERY, { reason: 'missed-gate', checkpointId: 'gate-4' }, campaign);
  assert.equal(state.mode, 'recovery');
  assert.deepEqual(state.recovery, { reason: 'missed-gate', checkpointId: 'gate-4' });
  assert.equal(state.activeMissionId, 'flight-school');
  state = reduce(state, WING_FLOW_ACTION.COMPLETE_RECOVERY, {}, campaign);
  assert.equal(state.mode, 'play');
  assert.equal(state.recovery, null);
});

test('pause preserves mode and emits one pointer-cancel signal', () => {
  const campaign = createCampaignState();
  let state = enterPlay(campaign);
  state = reduce(state, WING_FLOW_ACTION.PAUSE, { reason: 'preview-menu-open' }, campaign);
  assert.equal(state.mode, 'play');
  assert.equal(state.paused, true);
  assert.deepEqual(state.signals, [{ id: 'flow-signal-00000', type: 'cancel-pointers', reason: 'preview-menu-open' }]);

  const rejected = reduce(state, WING_FLOW_ACTION.PAUSE, {}, campaign);
  assert.equal(rejected.lastDecision.code, 'flow-paused');
  assert.equal(rejected.signals.length, 1);
  state = reduce(rejected, WING_FLOW_ACTION.ACK_SIGNALS, {}, campaign);
  assert.deepEqual(state.signals, []);
  state = reduce(state, WING_FLOW_ACTION.RESUME, {}, campaign);
  assert.equal(state.mode, 'play');
  assert.equal(state.paused, false);
});

test('success supports unlocked next mission and map while failure supports replay', () => {
  let campaign = createCampaignState();
  let success = enterPlay(campaign);
  success = reduce(success, WING_FLOW_ACTION.MISSION_SUCCESS, { score: 2300, stars: 2, timeMs: 70000, completedObjectiveIds: ['school-gates'] }, campaign);
  assert.equal(success.mode, 'results');
  assert.equal(success.result.outcome, 'success');

  campaign = applyMissionResult(campaign, { missionId: 'flight-school', completed: true, score: 2300, stars: 2, timeMs: 70000 });
  const next = reduce(success, WING_FLOW_ACTION.NEXT, {}, campaign);
  assert.equal(next.mode, 'briefing');
  assert.equal(next.activeMissionId, 'ridge-race');
  const map = reduce(next, WING_FLOW_ACTION.MAP, {}, campaign);
  assert.equal(map.mode, 'campaign');

  let failure = enterPlay(campaign, 'ridge-race');
  failure = reduce(failure, WING_FLOW_ACTION.MISSION_FAIL, { reason: 'hull-lost' }, campaign);
  assert.equal(failure.mode, 'fail');
  const replay = reduce(failure, WING_FLOW_ACTION.REPLAY, {}, campaign);
  assert.equal(replay.mode, 'briefing');
  assert.equal(replay.activeMissionId, 'ridge-race');
  assert.equal(replay.result, null);
});

test('invalid transitions are serializable rejections without mutating prior state', () => {
  const initial = createWingFlowState();
  const rejected = reduce(initial, WING_FLOW_ACTION.COUNTDOWN_COMPLETE);
  assert.equal(initial.lastDecision, null);
  assert.equal(rejected.mode, 'title');
  assert.equal(rejected.lastDecision.accepted, false);
  assert.equal(rejected.lastDecision.code, 'wrong-mode');
  assert.deepEqual(wingFlowSnapshot(rejected), JSON.parse(JSON.stringify(rejected)));
});
