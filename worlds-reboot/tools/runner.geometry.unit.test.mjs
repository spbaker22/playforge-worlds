import test from 'node:test';
import assert from 'node:assert/strict';

import * as THREE from 'three';

import { buildCity } from '../runner/src/city.js';
import { createRunnerCourseModel } from '../runner/src/course.js';

function canvasDocumentStub(){
  const context = new Proxy({}, {
    get(target, property){
      if(!(property in target)) target[property] = () => undefined;
      return target[property];
    },
    set(target, property, value){
      target[property] = value;
      return true;
    },
  });
  return {
    createElement(tagName){
      assert.equal(tagName, 'canvas');
      return { width: 0, height: 0, getContext: () => context };
    },
  };
}

function vertex(attribute, index){
  return new THREE.Vector3().fromBufferAttribute(attribute, index);
}

test('actual hazard body child meshes use outward, nondegenerate FrontSide triangles', () => {
  const previousDocument = globalThis.document;
  globalThis.document = canvasDocumentStub();

  try {
    const course = createRunnerCourseModel();
    const city = buildCity(new THREE.Scene(), course, { lowfx: true });
    assert.deepEqual([...city.hazardBodies.keys()], [
      'lane-blocker-01:lane:0',
      'slide-gate-01:gate',
      'combined-lane-gate:lane:-1',
      'combined-lane-gate:lane:1',
    ]);

    for(const [bodyKey, body] of city.hazardBodies){
      const hazardGroup = city.hazardGroups.get(body.userData.hazardId);
      assert.ok(body.isMesh, `${bodyKey} must be an actual mesh`);
      assert.strictEqual(body.parent, hazardGroup, `${bodyKey} must be a direct hazard-group child`);
      assert.match(body.name, /^hazard-body:/, `${bodyKey} must retain its hazard-body identity`);

      const materials = Array.isArray(body.material) ? body.material : [body.material];
      assert.ok(materials.length > 0, `${bodyKey} must have a material`);
      for(const material of materials){
        assert.equal(material.side, THREE.FrontSide, `${bodyKey} must render with FrontSide culling`);
      }

      const geometry = body.geometry;
      const positions = geometry.getAttribute('position');
      const normals = geometry.getAttribute('normal');
      const indices = geometry.index;
      assert.ok(positions?.count >= 8, `${bodyKey} must expose body vertices`);
      assert.ok(normals, `${bodyKey} must expose computed vertex normals`);
      assert.ok(indices, `${bodyKey} must use indexed exterior triangles`);
      assert.equal(indices.count % 3, 0, `${bodyKey} index count must contain complete triangles`);

      const interior = new THREE.Vector3();
      for(let index = 0; index < positions.count; index += 1) interior.add(vertex(positions, index));
      interior.multiplyScalar(1 / positions.count);

      for(let offset = 0; offset < indices.count; offset += 3){
        const triangleIndex = offset / 3;
        const ia = indices.getX(offset);
        const ib = indices.getX(offset + 1);
        const ic = indices.getX(offset + 2);
        const a = vertex(positions, ia);
        const b = vertex(positions, ib);
        const c = vertex(positions, ic);
        const faceNormal = b.clone().sub(a).cross(c.clone().sub(a));
        const doubledArea = faceNormal.length();
        assert.ok(
          doubledArea > 1e-8,
          `${bodyKey} triangle ${triangleIndex} [${ia},${ib},${ic}] is degenerate`,
        );

        const triangleCenter = a.clone().add(b).add(c).multiplyScalar(1 / 3);
        const outwardDot = faceNormal.dot(triangleCenter.sub(interior));
        assert.ok(
          outwardDot > 1e-7,
          `${bodyKey} triangle ${triangleIndex} [${ia},${ib},${ic}] points inward (${outwardDot})`,
        );

        const computedNormal = vertex(normals, ia).add(vertex(normals, ib)).add(vertex(normals, ic));
        assert.ok(
          computedNormal.lengthSq() > 1e-12 && faceNormal.dot(computedNormal) > 0,
          `${bodyKey} triangle ${triangleIndex} has a computed normal inconsistent with its winding`,
        );
      }
    }

    assert.equal(city.alignmentReport().ok, true, 'geometry winding must not disturb exact body alignment');
  } finally {
    if(previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
