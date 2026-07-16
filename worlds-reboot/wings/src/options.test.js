import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStoredSharedOptions } from './options.js';

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
