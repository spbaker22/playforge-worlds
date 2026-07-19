import test from 'node:test';
import assert from 'node:assert/strict';
import { getMissionDressing, MISSION_DRESSING, MISSION_IDS, missionDressingIndex } from './mission-dressing.js';

test('campaign dressing defines eight unique missions in stable order', () => {
  assert.equal(MISSION_DRESSING.length, 8);
  assert.equal(new Set(MISSION_IDS).size, 8);
  assert.deepEqual(MISSION_DRESSING.map(mission => mission.order), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(MISSION_IDS, [
    'flight-school', 'ridge-race', 'target-run', 'stunt-trial',
    'mountain-rescue', 'storm-escape', 'ace-pursuit', 'skybreaker-finale',
  ]);
});

test('each mission carries complete immutable visual and briefing data', () => {
  for(const mission of MISSION_DRESSING){
    assert.equal(Object.isFrozen(mission), true);
    assert.equal(Object.isFrozen(mission.palette), true);
    assert.equal(Object.isFrozen(mission.landmarks), true);
    assert.equal(Object.isFrozen(mission.props), true);
    assert.equal(Object.isFrozen(mission.hazards), true);
    assert.equal(mission.landmarks.length, 3);
    assert.ok(mission.props.length >= 3);
    assert.ok(mission.hazards.length >= 1);
    assert.equal(mission.palette.signal, 0xff795c);
    assert.ok(mission.briefing.headline.length > 6);
    assert.equal(mission.challenges.length, 3);
    for(const value of Object.values(mission.palette)){
      assert.equal(Number.isInteger(value), true);
      assert.ok(value >= 0 && value <= 0xffffff);
    }
  }
});

test('lookup is stable and unknown mission ids fail closed', () => {
  assert.equal(getMissionDressing('stunt-trial'), MISSION_DRESSING[3]);
  assert.equal(missionDressingIndex('skybreaker-finale'), 7);
  assert.equal(missionDressingIndex('missing'), -1);
  assert.throws(() => getMissionDressing('missing'), /Unknown Paper Wings mission/);
});

test('missions materially change route, atmosphere, hazards, and landmarks', () => {
  assert.equal(new Set(MISSION_DRESSING.map(mission => mission.route.gateStyle)).size, 8);
  assert.equal(new Set(MISSION_DRESSING.map(mission => mission.atmosphere.cloudCover)).size, 8);
  assert.ok(new Set(MISSION_DRESSING.flatMap(mission => mission.hazards.map(hazard => hazard.kind))).size >= 18);
  assert.equal(new Set(MISSION_DRESSING.flatMap(mission => mission.landmarks.map(landmark => landmark.id))).size, 24);
});
