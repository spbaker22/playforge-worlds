import test from 'node:test';
import assert from 'node:assert/strict';
import { fishForCast, harborZoneForCast, tideRunSeed } from './fish.js';

test('cast power and sideways reach select three bounded readable harbor zones', () => {
  assert.equal(harborZoneForCast({ castPower: 0.42, castLateral: 0 }).id, 'pier');
  assert.equal(harborZoneForCast({ castPower: 0.84, castLateral: 0 }).id, 'channel');
  assert.equal(harborZoneForCast({ castPower: 0.84, castLateral: 0.82 }).id, 'breakwater');
  assert.equal(harborZoneForCast({ castPower: 4, castLateral: 0 }).id, 'channel');
  assert.equal(harborZoneForCast({ castPower: -4, castLateral: -4 }).id, 'breakwater');
});

test('lateral zone choice changes deterministic fish odds instead of only moving the float', () => {
  const samples = 512;
  const channel = [];
  const breakwater = [];
  const pier = [];
  for(let seed = 0; seed < samples; seed += 1){
    channel.push(fishForCast({ seed, castIndex: 0, scoring: 'trophy', castPower: 0.84, castLateral: 0 }));
    breakwater.push(fishForCast({ seed, castIndex: 0, scoring: 'trophy', castPower: 0.84, castLateral: 0.82 }));
    pier.push(fishForCast({ seed, castIndex: 0, scoring: 'trophy', castPower: 0.42, castLateral: 0 }));
  }
  const trophyCount = deck => deck.filter(fish => fish.tier === 'trophy').length;
  const averageBite = deck => deck.reduce((sum, fish) => sum + fish.biteDelay, 0) / deck.length;
  assert.ok(trophyCount(channel) > trophyCount(breakwater));
  assert.ok(trophyCount(breakwater) > trophyCount(pier));
  assert.ok(averageBite(channel) > averageBite(pier));
  assert.ok(channel.every(fish => fish.zone === 'channel' && fish.zoneLabel === 'DEEP CHANNEL'));
  assert.ok(breakwater.every(fish => fish.zone === 'breakwater'));
});

test('replay seeds vary by watch while each indexed fish deck remains deterministic', () => {
  const base = 0x10f71de;
  const firstSeed = tideRunSeed(base, 0);
  const replaySeed = tideRunSeed(base, 1);
  assert.equal(firstSeed, base);
  assert.equal(tideRunSeed(base, 1), replaySeed);
  assert.notEqual(replaySeed, firstSeed);

  const deck = seed => Array.from({ length: 6 }, (_, castIndex) => fishForCast({
    seed, castIndex, scoring: 'haul', castPower: 0.76, castLateral: 0,
  }));
  assert.deepEqual(deck(replaySeed), deck(tideRunSeed(base, 1)));
  assert.notDeepEqual(deck(firstSeed), deck(replaySeed));
});
