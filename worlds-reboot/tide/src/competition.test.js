import test from 'node:test';
import assert from 'node:assert/strict';
import { tideCompetition, tideRivalTargets, tideRivalTotals, tideScoreboard } from './competition.js';

test('each current session and scoring option selects its audited rival targets', () => {
  assert.deepEqual(tideRivalTargets({ session: 'quick', scoring: 'haul' }), { mara: 12.5, elias: 10.5 });
  assert.deepEqual(tideRivalTargets({ session: 'full', scoring: 'haul' }), { mara: 21.5, elias: 18.5 });
  assert.deepEqual(tideRivalTargets({ session: 'quick', scoring: 'trophy' }), { mara: 1400, elias: 1150 });
  assert.deepEqual(tideRivalTargets({ session: 'full', scoring: 'trophy' }), { mara: 2250, elias: 1850 });
});

test('rivals start at zero and land exactly on their format endpoints', () => {
  for(const session of ['quick', 'full']){
    for(const scoring of ['haul', 'trophy']){
      const duration = session === 'quick' ? 45 : 90;
      assert.deepEqual(tideRivalTotals({ session, scoring, time: 0, duration }), { mara: 0, elias: 0 });
      assert.deepEqual(
        tideRivalTotals({ session, scoring, time: duration, duration }),
        tideRivalTargets({ session, scoring }),
      );
    }
  }
});

test('scoreboard semantics keep Trophy points primary and Haul kilograms primary', () => {
  assert.deepEqual(tideScoreboard({ scoring: 'trophy', haulKg: 8.4, score: 1320 }), {
    primary: { value: 1320, unit: 'PTS' },
    secondary: { value: 8.4, unit: 'KG' },
  });
  assert.deepEqual(tideScoreboard({ scoring: 'haul', haulKg: 8.4, score: 1320 }), {
    primary: { value: 8.4, unit: 'KG' },
    secondary: { value: 1320, unit: 'PTS' },
  });
});

test('one competition snapshot keeps player metric, rivals, and rank consistent', () => {
  const trophy = tideCompetition({ session: 'quick', scoring: 'trophy', time: 45, duration: 45, haulKg: 10.2, score: 1200 });
  assert.equal(trophy.player, trophy.metrics.primary.value);
  assert.deepEqual(trophy.rivals, { mara: 1400, elias: 1150 });
  assert.equal(trophy.rank, 2);

  const haul = tideCompetition({ session: 'full', scoring: 'haul', time: 90, duration: 90, haulKg: 22, score: 900 });
  assert.equal(haul.player, 22);
  assert.deepEqual(haul.rivals, { mara: 21.5, elias: 18.5 });
  assert.equal(haul.rank, 1);
});
