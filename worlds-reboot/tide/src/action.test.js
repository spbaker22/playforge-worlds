import test from 'node:test';
import assert from 'node:assert/strict';
import { createTideActionController } from './action.js';

test('a cast belongs to one pointer and resolves once on release', () => {
  const action = createTideActionController({ castDeadzone: 20, castRange: 220, lateralRange: 100 });
  assert.equal(action.begin({ pointerId: 1, x: 200, y: 100, phase: 'aim', time: 1 }).type, 'cast-start');
  assert.equal(action.begin({ pointerId: 2, x: 0, y: 0, phase: 'aim', time: 1 }), null);
  const preview = action.move({ pointerId: 1, x: 250, y: 300 });
  assert.equal(preview.type, 'cast-preview');
  assert.equal(preview.lateral, -0.5);
  assert.ok(preview.power > 0.9);
  const cast = action.end({ pointerId: 1, x: 250, y: 300, time: 1.4 });
  assert.equal(cast.type, 'cast');
  assert.equal(action.end({ pointerId: 1, x: 250, y: 300, time: 1.5 }), null);
});

test('a hook tap never becomes an implicit reel hold', () => {
  const action = createTideActionController();
  assert.equal(action.begin({ pointerId: 7, x: 20, y: 30, phase: 'bite', time: 2 }).type, 'hook');
  assert.equal(action.state.active, false);
  assert.equal(action.end({ pointerId: 7, x: 20, y: 30, time: 2.1 }), null);
  assert.equal(action.begin({ pointerId: 8, x: 20, y: 30, phase: 'reeling', time: 2.2 }).type, 'reel-start');
  assert.equal(action.end({ pointerId: 8, x: 20, y: 30, time: 2.8 }).type, 'reel-stop');
});

test('short aim taps and cancelled casts never fire', () => {
  const action = createTideActionController({ castDeadzone: 24 });
  action.begin({ pointerId: 1, x: 100, y: 100, phase: 'aim', time: 0 });
  assert.equal(action.end({ pointerId: 1, x: 104, y: 108, time: 0.1 }).type, 'cast-cancel');
  action.begin({ pointerId: 2, x: 100, y: 100, phase: 'aim', time: 1 });
  action.move({ pointerId: 2, x: 100, y: 250 });
  assert.equal(action.cancel(2).type, 'cast-cancel');
});

test('invalid phases do not capture touch ownership', () => {
  const action = createTideActionController();
  assert.equal(action.begin({ pointerId: 1, x: 1, y: 1, phase: 'waiting', time: 0 }), null);
  assert.equal(action.state.active, false);
});

