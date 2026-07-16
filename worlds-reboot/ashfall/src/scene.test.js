import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createAshfallScene } from './scene.js';

function snapshot(overrides = {}){
  return {
    status: 'running',
    time: 1,
    x: 0,
    z: 1.2,
    targetX: 0,
    targetZ: -2,
    vx: 0,
    vz: 0,
    facingX: 0,
    facingZ: -1,
    dashDuration: 0,
    invulnerable: 0,
    hazards: [],
    ...overrides,
  };
}

test('the exact safe-zone border is visible and shield state keeps the survivor readable', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const visual = createAshfallScene({ scene, camera, renderer: {}, lowfx: true });
  visual.update(snapshot({ invulnerable: 0.8 }), { dt: 1 / 60, time: 2, mode: 'play' });
  assert.equal(visual.diagnostics.boundaryVisible, true);
  assert.equal(visual.diagnostics.shieldActive, true);
  assert.equal(visual.player.visible, true);
  assert.equal(visual.world.boundary.children.length, 4);
  visual.update(snapshot(), { dt: 1 / 60, time: 2.1, mode: 'play' });
  assert.equal(visual.diagnostics.shieldActive, false);
  assert.equal(visual.player.visible, true);
});
