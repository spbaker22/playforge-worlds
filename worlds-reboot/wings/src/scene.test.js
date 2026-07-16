import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createWingRoute } from './route.js';
import { buildAlpineWorld, buildPaperGlider } from './scene.js';

test('hero paper keeps its warm face inside a dark ink silhouette hierarchy', () => {
  const hero = buildPaperGlider(0xf4eee4, 'paper', true);
  const wingUnderside = hero.getObjectByName('paper-wings-wing-underside');
  const tailUnderside = hero.getObjectByName('paper-wings-tail-underside');
  const fold = hero.getObjectByName('paper-wings-fold-spine');

  assert.equal(hero.userData.wing.material.color.getHex(), 0xf4eee4);
  assert.equal(hero.userData.wing.material.side, THREE.DoubleSide);
  for(const underside of [wingUnderside, tailUnderside]){
    assert.ok(underside?.isMesh);
    assert.equal(underside.material.color.getHex(), 0x15292e);
    assert.equal(underside.material.side, THREE.DoubleSide);
    assert.ok(underside.scale.x > 1 && underside.scale.z > 1);
  }
  assert.equal(hero.children.some(child => child.isLineSegments), false);
  assert.equal(fold.material.color.getHex(), 0x15292e);
});

test('authored gates layer a dark rim behind the stateful inner ring', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const route = createWingRoute('quick');
  const world = buildAlpineWorld(scene, camera, route, { lowfx: true, race: 'solo', reducedMotion: true });
  const [passed, current, upcoming] = world.gateViews;

  for(const gate of world.gateViews){
    assert.ok(gate.userData.rim?.isMesh);
    assert.ok(gate.userData.ring?.isMesh);
    assert.equal(gate.userData.rim.geometry.parameters.tube, 0.68);
    assert.equal(gate.userData.ring.geometry.parameters.tube, 0.44);
    assert.ok(gate.userData.rim.position.z < gate.userData.ring.position.z);
  }

  world.updateFlight({
    gateIndex: 1, s: 0, time: 0, x: 0, y: 33, bank: 0, pitch: 0, speed: 18,
  }, 0, 1 / 120);
  assert.equal(passed.userData.material.color.getHex(), 0x799c8c);
  assert.equal(passed.userData.rimMaterial.color.getHex(), 0x29443c);
  assert.equal(current.userData.material.color.getHex(), 0xff795c);
  assert.equal(current.userData.rimMaterial.color.getHex(), 0x15292e);
  assert.ok(current.userData.material.emissiveIntensity > upcoming.userData.material.emissiveIntensity);
  assert.ok(current.userData.rimMaterial.emissiveIntensity > upcoming.userData.rimMaterial.emissiveIntensity);
});
