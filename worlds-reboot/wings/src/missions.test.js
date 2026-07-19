import test from 'node:test';
import assert from 'node:assert/strict';
import { WING_MISSIONS, WING_MISSION_IDS, getNewlyUnlockedMissionIds, getUnlockedMissionIds, isMissionUnlocked, missionById, validateMissionCatalog } from './missions.js';

test('the approved eight-mission catalog is valid and ordered', () => {
  assert.deepEqual(WING_MISSION_IDS, ['flight-school', 'ridge-race', 'target-run', 'stunt-trial', 'mountain-rescue', 'storm-escape', 'ace-pursuit', 'skybreaker-finale']);
  const verdict = validateMissionCatalog(WING_MISSIONS);
  assert.equal(verdict.valid, true);
  assert.deepEqual(verdict.errors, []);
  assert.deepEqual(verdict.roots, ['flight-school']);
  assert.equal(new Set(verdict.topologicalOrder).size, 8);
});

test('unlock graph opens branches only after all prerequisites are complete', () => {
  assert.deepEqual(getUnlockedMissionIds([]), ['flight-school']);
  assert.deepEqual(getNewlyUnlockedMissionIds([], ['flight-school']), ['ridge-race']);
  assert.deepEqual(getUnlockedMissionIds(['flight-school', 'ridge-race']), ['flight-school', 'ridge-race', 'target-run', 'stunt-trial']);
  assert.equal(isMissionUnlocked('ace-pursuit', ['target-run', 'stunt-trial']), false);
  assert.equal(isMissionUnlocked('ace-pursuit', ['target-run', 'storm-escape']), true);
  assert.equal(isMissionUnlocked('skybreaker-finale', ['mountain-rescue', 'ace-pursuit']), true);
});

test('lookup exposes frozen authored data and rejects unknown ids', () => {
  assert.equal(missionById('target-run').type, 'target');
  assert.equal(missionById('missing'), null);
  assert.equal(Object.isFrozen(WING_MISSIONS), true);
  assert.equal(Object.isFrozen(WING_MISSIONS[0].objectives), true);
});

test('catalog validation rejects missing edges, duplicates, and cycles', () => {
  const base = { order: 1, title: 'TEST', type: 'test', durationSeconds: 10, prerequisites: [], mechanics: ['test'], objectives: [{ id: 'finish', kind: 'finish', target: 1, required: true }], medalScores: { bronze: 1, silver: 2, gold: 3 } };
  const missing = validateMissionCatalog([{ ...base, id: 'one', prerequisites: ['gone'] }]);
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some(error => error.includes('missing mission gone')));
  const duplicate = validateMissionCatalog([{ ...base, id: 'one' }, { ...base, id: 'one', order: 2 }]);
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.errors.some(error => error.includes('duplicated')));
  const cycle = validateMissionCatalog([{ ...base, id: 'one', prerequisites: ['two'] }, { ...base, id: 'two', order: 2, prerequisites: ['one'] }]);
  assert.equal(cycle.valid, false);
  assert.ok(cycle.errors.some(error => error.includes('cycle')));
});
