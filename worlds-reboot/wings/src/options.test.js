import test from 'node:test';
import assert from 'node:assert/strict';
import { WING_LOADOUT_VALUES, parseStoredSharedOptions } from './options.js';

test('stored preview options accept only a plain object with safe enum values', () => {
  for(const raw of [null, '', 'null', '[]', '42', '"on"', '{bad json']){
    assert.deepEqual(parseStoredSharedOptions(raw), {});
  }
  assert.deepEqual(
    parseStoredSharedOptions('{"sound":"off","quality":"performance","extra":"ignored"}'),
    { sound: 'off', quality: 'performance' },
  );
  assert.deepEqual(
    parseStoredSharedOptions('{"sound":"LOUD","quality":"ultra"}'),
    {},
  );
});

test('stored Wings options preserve legacy route, control, and race keys', () => {
  assert.deepEqual(
    parseStoredSharedOptions('{"wingsRoute":"quick","wingsControl":"direct","wingsRace":"solo"}'),
    { wingsRoute: 'quick', wingsControl: 'direct', wingsRace: 'solo' },
  );
  assert.deepEqual(
    parseStoredSharedOptions('{"wingsRoute":"full","wingsControl":"guided","wingsRace":"rivals"}'),
    { wingsRoute: 'full', wingsControl: 'guided', wingsRace: 'rivals' },
  );
});

test('mission and loadout options accept only authored stable tokens', () => {
  assert.deepEqual(WING_LOADOUT_VALUES, ['balanced', 'racer', 'stunt', 'guardian']);
  assert.deepEqual(
    parseStoredSharedOptions('{"sound":"on","quality":"auto","wingsMission":"skybreaker-finale","wingsLoadout":"guardian","wingsRoute":"full","wingsControl":"guided","wingsRace":"rivals"}'),
    {
      sound: 'on',
      quality: 'auto',
      wingsRoute: 'full',
      wingsControl: 'guided',
      wingsRace: 'rivals',
      wingsMission: 'skybreaker-finale',
      wingsLoadout: 'guardian',
    },
  );
  assert.deepEqual(
    parseStoredSharedOptions('{"wingsMission":"secret-level","wingsLoadout":"ultimate","wingsRoute":"long","wingsControl":"auto","wingsRace":"online"}'),
    {},
  );
});

test('every approved mission and loadout round-trips independently', () => {
  for(const wingsMission of ['flight-school', 'ridge-race', 'target-run', 'stunt-trial', 'mountain-rescue', 'storm-escape', 'ace-pursuit', 'skybreaker-finale']){
    assert.deepEqual(parseStoredSharedOptions(JSON.stringify({ wingsMission })), { wingsMission });
  }
  for(const wingsLoadout of WING_LOADOUT_VALUES){
    assert.deepEqual(parseStoredSharedOptions(JSON.stringify({ wingsLoadout })), { wingsLoadout });
  }
});
