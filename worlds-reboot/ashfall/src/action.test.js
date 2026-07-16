import test from 'node:test';
import assert from 'node:assert/strict';
import { createAshfallActionController } from './action.js';

test('direct drag preserves the pickup offset and clamps to the arena', () => {
  const action = createAshfallActionController();
  action.begin({ pointerId: 7, screenX: 100, screenY: 100, groundX: 2, groundZ: 2, playerX: 1, playerZ: 1, time: 1 });
  assert.deepEqual(action.move({ pointerId: 7, screenX: 180, screenY: 150, groundX: 10, groundZ: -10 }), { x: 6.2, z: -4.4 });
  const ended = action.end({ pointerId: 7, screenX: 180, screenY: 150, time: 1.2 });
  assert.equal(ended.type, 'move');
  assert.equal(action.state.active, false);
});

test('a short tap yields exactly one dash action', () => {
  const action = createAshfallActionController({ tapSlop: 12, tapSeconds: 0.3 });
  action.begin({ pointerId: 1, screenX: 50, screenY: 60, groundX: 0, groundZ: 0, playerX: 0, playerZ: 0, time: 3 });
  const first = action.end({ pointerId: 1, screenX: 55, screenY: 64, time: 3.18 });
  assert.equal(first.type, 'dash');
  assert.equal(action.end({ pointerId: 1, screenX: 55, screenY: 64, time: 3.2 }), null);
});

test('a tap keeps the tapped world point as the dash target', () => {
  const action = createAshfallActionController();
  action.begin({ pointerId: 4, screenX: 220, screenY: 180, groundX: -3.4, groundZ: -1.7, playerX: 1.2, playerZ: 2.1, time: 5 });
  const result = action.end({ pointerId: 4, screenX: 224, screenY: 183, time: 5.12 });
  assert.equal(result.type, 'dash');
  assert.deepEqual(result.target, { x: -3.4, z: -1.7 });
});

test('second pointers cannot steal an active drag', () => {
  const action = createAshfallActionController();
  assert.ok(action.begin({ pointerId: 2, screenX: 0, screenY: 0, groundX: 0, groundZ: 0, playerX: 0, playerZ: 0, time: 0 }));
  assert.equal(action.begin({ pointerId: 3, screenX: 0, screenY: 0, groundX: 0, groundZ: 0, playerX: 0, playerZ: 0, time: 0 }), false);
  assert.equal(action.move({ pointerId: 3, screenX: 10, screenY: 10, groundX: 2, groundZ: 2 }), null);
  assert.equal(action.cancel(2).type, 'cancel');
});
