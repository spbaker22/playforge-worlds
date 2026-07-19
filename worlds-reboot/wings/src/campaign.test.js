import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMPAIGN_STATE_VERSION, applyMissionResult, campaignMissionRecord, createCampaignState, mergeCampaignStates, restoreCampaignState, serializeCampaignState } from './campaign.js';

test('a new versioned campaign starts at Flight School only', () => {
  const state = createCampaignState();
  assert.equal(state.version, CAMPAIGN_STATE_VERSION);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.unlockedMissionIds, ['flight-school']);
  assert.deepEqual(state.completedMissionIds, []);
  assert.equal(Object.keys(state.missions).length, 8);
  assert.doesNotThrow(() => JSON.stringify(state));
});

test('completion unlocks the DAG while a failed attempt does not', () => {
  const initial = createCampaignState();
  const failed = applyMissionResult(initial, { missionId: 'flight-school', completed: false, score: 500, stars: 0, timeMs: 90000 });
  assert.deepEqual(failed.unlockedMissionIds, ['flight-school']);
  assert.equal(failed.missions['flight-school'].attempts, 1);
  const passed = applyMissionResult(failed, { missionId: 'flight-school', completed: true, score: 2200, stars: 2, timeMs: 78000, combo: 6, completedObjectiveIds: ['school-gates'] });
  assert.deepEqual(passed.completedMissionIds, ['flight-school']);
  assert.deepEqual(passed.unlockedMissionIds, ['flight-school', 'ridge-race']);
  assert.equal(passed.totalStars, 2);
  assert.equal(initial.missions['flight-school'].attempts, 0, 'reducer must not mutate prior state');
});

test('worse replays cannot lower any best or remove objectives and unlocks', () => {
  let state = createCampaignState();
  state = applyMissionResult(state, { missionId: 'flight-school', completed: true, score: 3200, stars: 3, timeMs: 62000, combo: 9, completedObjectiveIds: ['school-gates', 'school-thermals'] });
  state = applyMissionResult(state, { missionId: 'flight-school', completed: false, score: 40, stars: 0, timeMs: 99000, combo: 1, completedObjectiveIds: [] });
  const record = campaignMissionRecord(state, 'flight-school');
  assert.deepEqual({ attempts: record.attempts, completions: record.completions, completed: record.completed, bestScore: record.bestScore, bestStars: record.bestStars, bestTimeMs: record.bestTimeMs, bestCombo: record.bestCombo },
    { attempts: 2, completions: 1, completed: true, bestScore: 3200, bestStars: 3, bestTimeMs: 62000, bestCombo: 9 });
  assert.deepEqual(record.completedObjectiveIds, ['school-gates', 'school-thermals']);
  assert.ok(state.unlockedMissionIds.includes('ridge-race'));
});

test('restore and merge preserve monotonic progress without storage APIs', () => {
  const left = applyMissionResult(createCampaignState(), { missionId: 'flight-school', completed: true, score: 3000, stars: 2, timeMs: 70000 });
  const right = applyMissionResult(createCampaignState(), { missionId: 'flight-school', completed: true, score: 2000, stars: 3, timeMs: 65000, combo: 12 });
  const merged = mergeCampaignStates(left, right);
  assert.equal(merged.missions['flight-school'].bestScore, 3000);
  assert.equal(merged.missions['flight-school'].bestStars, 3);
  assert.equal(merged.missions['flight-school'].bestTimeMs, 65000);
  assert.equal(merged.missions['flight-school'].bestCombo, 12);
  assert.deepEqual(restoreCampaignState(serializeCampaignState(merged)), merged);
  assert.throws(() => restoreCampaignState({ version: CAMPAIGN_STATE_VERSION + 1 }), /unsupported campaign version/);
});

test('locked missions and unknown missions fail closed', () => {
  assert.throws(() => applyMissionResult(createCampaignState(), { missionId: 'target-run', completed: true }), /locked/);
  assert.throws(() => applyMissionResult(createCampaignState(), { missionId: 'unknown', completed: true }), /unknown mission/);
});
