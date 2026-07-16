/* Gridlock Run Phase 4 — production district scenery.
   Repeated architecture is instanced, motion reuses caller-owned pose buffers,
   and presentation safety is derived from rendered world bounds rather than
   authored "safe" flags. */
import * as THREE from 'three';
import { canvasTex, mulberry } from '../../engine/util.js';

// Presentation constants mirror the deck vocabulary without importing city.js
// back into this leaf module (which would create a render-module cycle).
const DECK_HW = 4.65;
const ACTIVE_CORRIDOR_HALF_WIDTH = 3.65;
const RUNNER_CLEARANCE_MIN = -0.08;
const RUNNER_CLEARANCE_MAX = 2.35;
const PAL = Object.freeze({ cyan: 0x2EE6FF, magenta: 0xFF3EC8, gold: 0xFFC24B });

// A compact canonical geometry kit keeps the scene under the Phase-4 resource
// ceiling. Shape is created with instance transforms instead of one-off boxes.
const unitBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
const unitCylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 10);
const relayMastGeometry = new THREE.CylinderGeometry(0.36, 1, 1, 10);
const markerGeometry = new THREE.OctahedronGeometry(1, 0);
const ringGeometry = new THREE.TorusGeometry(1, 0.12, 6, 24);
const trafficGeometry = new THREE.CapsuleGeometry(0.34, 2.4, 4, 10);
trafficGeometry.rotateX(Math.PI / 2);

export const DISTRICT_DEFS = Object.freeze([
  Object.freeze({ id: 'dispatch-roof', name: 'DISPATCH ROOF', s0: 0, s1: 25, color: 0x37E4F4 }),
  Object.freeze({ id: 'rain-span', name: 'RAIN SPAN', s0: 25, s1: 60, color: 0x638CFF }),
  Object.freeze({ id: 'switchyard', name: 'SWITCHYARD', s0: 60, s1: 90, color: 0xFFC457 }),
  Object.freeze({ id: 'maglev-undercroft', name: 'MAGLEV UNDERCROFT', s0: 90, s1: 112, color: 0xFF4BC7 }),
  Object.freeze({ id: 'relay-causeway', name: 'RELAY CAUSEWAY', s0: 112, s1: 150, color: 0x74F4D1 }),
]);

function createRawPoseOutput(){
  return {
    s: 0, requestedS: 0, rawS: 0, lane: 0, lateral: 0,
    position: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 },
    tangent: { x: 0, y: 0, z: 1 }, right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 },
    yaw: 0,
  };
}

function createPoseState(){
  return {
    raw: createRawPoseOutput(),
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, 1),
    right: new THREE.Vector3(1, 0, 0),
    yaw: 0,
  };
}

const buildPose = createPoseState();
function writePose(course, s, lane, out){
  const raw = course.poseAtInto(s, lane, out.raw);
  out.position.set(raw.position.x, raw.position.y, raw.position.z);
  out.tangent.set(raw.tangent.x, raw.tangent.y, raw.tangent.z).normalize();
  out.right.set(raw.right.x, raw.right.y, raw.right.z).normalize();
  out.yaw = Number.isFinite(raw.yaw) ? raw.yaw : Math.atan2(out.tangent.x, out.tangent.z);
  return out;
}

function applyPose(object, pose, lateral, y, extraYaw = 0){
  object.position.copy(pose.position).addScaledVector(pose.right, lateral);
  object.position.y += y;
  object.rotation.set(0, pose.yaw + extraYaw, 0);
  return object;
}

function placeAt(course, object, s, lateral, y = 0, pose = buildPose){
  return applyPose(object, writePose(course, s, 0, pose), lateral, y);
}

function setInstanceAt(course, object, s, lateral, y, sx, sy, sz, extraYaw = 0, pose = buildPose){
  applyPose(object, writePose(course, s, 0, pose), lateral, y, extraYaw);
  object.scale.set(sx, sy, sz);
  object.updateMatrix();
  return object.matrix;
}

function districtTexture(){
  const texture = canvasTex(512, 256, (context, width, height) => {
    context.fillStyle = '#1a243b';
    context.fillRect(0, 0, width, height);
    context.fillStyle = 'rgba(63,78,112,.52)';
    context.fillRect(width * 0.16, 0, width * 0.68, height);
    context.fillStyle = 'rgba(100,225,255,.18)';
    for(let x = 14; x < width; x += 42) context.fillRect(x, 0, 3, height);
    context.fillStyle = 'rgba(255,190,92,.34)';
    for(let x = 29; x < width; x += 84) context.fillRect(x, 0, 12, height);
    context.fillStyle = 'rgba(5,10,22,.5)';
    context.fillRect(0, height * 0.72, width, height * 0.07);
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 2);
  return texture;
}

function districtLabelAtlas(){
  const rowHeight = 112;
  return canvasTex(512, rowHeight * DISTRICT_DEFS.length, (context, width) => {
    context.fillStyle = 'rgba(5,10,24,.94)';
    context.fillRect(0, 0, width, rowHeight * DISTRICT_DEFS.length);
    for(let index = 0; index < DISTRICT_DEFS.length; index += 1){
      const district = DISTRICT_DEFS[index];
      const y = index * rowHeight;
      context.strokeStyle = `#${district.color.toString(16).padStart(6, '0')}`;
      context.lineWidth = 6;
      context.strokeRect(3, y + 3, width - 6, rowHeight - 6);
      context.fillStyle = '#F2F6FF';
      context.font = '800 39px -apple-system, Helvetica, Arial';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(district.name, width / 2, y + rowHeight / 2 + 1);
    }
  });
}

function labelGeometry(index){
  const geometry = new THREE.PlaneGeometry(3.5, 0.76);
  const uv = geometry.getAttribute('uv');
  const rows = DISTRICT_DEFS.length;
  const low = 1 - (index + 1) / rows;
  const high = 1 - index / rows;
  for(let vertexIndex = 0; vertexIndex < uv.count; vertexIndex += 1){
    uv.setY(vertexIndex, low + uv.getY(vertexIndex) * (high - low));
  }
  return geometry;
}

function createMaterialKit(sharedAccents = {}){
  const facade = new THREE.MeshStandardMaterial({
    map: districtTexture(), color: 0x566A8D, roughness: 0.66, metalness: 0.2,
    emissive: 0x213854, emissiveIntensity: 0.72,
  });
  const facadeDark = new THREE.MeshStandardMaterial({
    color: 0x222F4A, roughness: 0.78, metalness: 0.24,
    emissive: 0x0C1830, emissiveIntensity: 0.34,
  });
  const metal = new THREE.MeshStandardMaterial({ color: 0x71819A, roughness: 0.38, metalness: 0.7 });
  const cyan = sharedAccents.cyan || new THREE.MeshBasicMaterial({ color: PAL.cyan });
  return {
    facade,
    facadeDark,
    metal,
    pale: metal,
    cyan,
    magenta: sharedAccents.magenta || new THREE.MeshBasicMaterial({ color: PAL.magenta }),
    gold: sharedAccents.gold || new THREE.MeshBasicMaterial({ color: PAL.gold }),
    mint: cyan,
    // Opaque warm windows carry depth without adding a transparent renderable.
    windows: new THREE.MeshBasicMaterial({ color: 0xFFC878 }),
    labels: new THREE.MeshBasicMaterial({ map: districtLabelAtlas(), side: THREE.DoubleSide }),
    ground: facadeDark,
  };
}

function recordProp(semantics, kind, s, lateral, y, detail = null){
  semantics.props.push({ kind, s, lateral, y, detail });
}

function districtProfileAt(s){
  if(s < 25) return { near: 14, spread: 14, height: 18, variance: 13, density: 0.9 };
  if(s < 60) return { near: 23, spread: 20, height: 18, variance: 15, density: 0.34 };
  if(s < 90) return { near: 13, spread: 14, height: 19, variance: 14, density: 1.0 };
  if(s < 112) return { near: 17, spread: 18, height: 27, variance: 18, density: 0.78 };
  return { near: 23, spread: 24, height: 21, variance: 16, density: 0.3 };
}

function buildFacadeHierarchy(group, course, materials, lowfx, semantics){
  const random = mulberry(0xA57E2204);
  const count = lowfx ? 26 : 40;
  const bases = new THREE.InstancedMesh(unitBoxGeometry, materials.facadeDark, count);
  bases.name = 'district:facade-bases';
  bases.userData.titleOccluder = true;
  const mids = new THREE.InstancedMesh(unitBoxGeometry, materials.facade, count);
  mids.name = 'district:facade-midsections';
  mids.userData.titleOccluder = true;
  const roofs = new THREE.InstancedMesh(unitBoxGeometry, materials.metal, count);
  roofs.name = 'district:facade-rooflines';
  roofs.userData.titleOccluder = true;
  const windows = new THREE.InstancedMesh(unitBoxGeometry, materials.windows, count * 3);
  windows.name = 'district:warm-window-banks';
  windows.userData.titleOccluder = true;
  const dummy = new THREE.Object3D();
  let windowIndex = 0;
  for(let index = 0; index < count; index += 1){
    let s = random() * course.length;
    // Keep the Rain Span and Relay Causeway deliberately open; rejected shots
    // read as one continuous wall of black towers.
    const profile = districtProfileAt(s);
    if(random() > profile.density){
      s = s < 60 ? 60 + random() * 30 : random() * 25;
    }
    const side = random() < 0.5 ? -1 : 1;
    const lateral = side * (profile.near + random() * profile.spread);
    const width = 4.5 + random() * 5.5;
    const depth = 4.5 + random() * 7;
    const height = profile.height + random() * profile.variance;
    const baseHeight = Math.min(7.5, 4.4 + height * 0.08);
    const midHeight = height - baseHeight;
    const baseY = -4.8 + baseHeight / 2;
    const midY = -4.8 + baseHeight + midHeight / 2;
    const roofY = -4.8 + height + 0.85;
    const yaw = (random() - 0.5) * 0.16;
    bases.setMatrixAt(index, setInstanceAt(course, dummy, s, lateral, baseY,
      width * 1.18, baseHeight, depth * 1.16, yaw));
    mids.setMatrixAt(index, setInstanceAt(course, dummy, s, lateral, midY,
      width, midHeight, depth, yaw));
    roofs.setMatrixAt(index, setInstanceAt(course, dummy, s, lateral, roofY,
      width * 0.78, 1.7, depth * 0.76, yaw));
    for(let bank = 0; bank < 3; bank += 1){
      const bankY = -1 + height * (0.28 + bank * 0.23);
      const bankLateral = lateral - side * (width / 2 + 0.06);
      windows.setMatrixAt(windowIndex++, setInstanceAt(course, dummy, s + (bank - 1) * depth * 0.2,
        bankLateral, bankY, 0.08, Math.max(0.34, height * 0.045), depth * 0.34, yaw));
    }
    recordProp(semantics, 'tiered-facade', s, lateral, midY, { baseHeight, height });
  }
  for(const mesh of [bases, mids, roofs, windows]) mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  group.add(bases, mids, windows);
  if(!lowfx) group.add(roofs);
}

function buildEdgeArchitecture(group, course, materials, lowfx, semantics){
  const step = lowfx ? 8 : 5;
  const count = Math.floor(course.length / step) + 1;
  const posts = new THREE.InstancedMesh(unitBoxGeometry, materials.metal, count * 2);
  posts.name = 'district:edge-posts';
  const railsA = new THREE.InstancedMesh(unitBoxGeometry, materials.cyan, count);
  railsA.name = 'district:cyan-edge-rail';
  const railsB = new THREE.InstancedMesh(unitBoxGeometry, materials.magenta, count);
  railsB.name = 'district:magenta-edge-rail';
  const dummy = new THREE.Object3D();
  let index = 0;
  for(let s = 0; s <= course.length + 0.01; s += step){
    posts.setMatrixAt(index * 2, setInstanceAt(course, dummy, s, -(DECK_HW + 0.55), 0.56, 0.12, 1.15, 0.12));
    posts.setMatrixAt(index * 2 + 1, setInstanceAt(course, dummy, s, DECK_HW + 0.55, 0.56, 0.12, 1.15, 0.12));
    railsA.setMatrixAt(index, setInstanceAt(course, dummy, s, -(DECK_HW + 0.55), 0.92, 0.12, 0.10, step * 0.9));
    railsB.setMatrixAt(index, setInstanceAt(course, dummy, s, DECK_HW + 0.55, 0.92, 0.12, 0.10, step * 0.9));
    recordProp(semantics, 'edge-architecture', s, DECK_HW + 0.55, 0.92);
    index += 1;
  }
  posts.count = index * 2;
  railsA.count = index;
  railsB.count = index;
  group.add(posts, railsA, railsB);
}

function addDistrictLabels(group, course, materials, semantics){
  for(let index = 0; index < DISTRICT_DEFS.length; index += 1){
    const district = DISTRICT_DEFS[index];
    const marker = new THREE.Group();
    marker.name = `district:${district.id}`;
    placeAt(course, marker, district.s0 + 1.5, -(DECK_HW + 2.2), 2.0);
    const plate = new THREE.Mesh(labelGeometry(index), materials.labels);
    plate.name = `district-label:${district.id}`;
    plate.rotation.y = Math.PI / 2;
    marker.add(plate);
    group.add(marker);
    semantics.labels.push({ id: district.id, name: district.name, s0: district.s0, s1: district.s1, lateral: -(DECK_HW + 2.2) });
  }
}

function addDispatchRoof(group, course, materials, semantics, lowfx){
  const dummy = new THREE.Object3D();
  const canopyCount = lowfx ? 2 : 4;
  const canopies = new THREE.InstancedMesh(unitBoxGeometry, materials.facade, canopyCount);
  canopies.name = 'dispatch:canopy-roofs';
  const supports = new THREE.InstancedMesh(unitBoxGeometry, materials.metal, canopyCount * 2);
  supports.name = 'dispatch:canopy-supports';
  const lockers = new THREE.InstancedMesh(unitBoxGeometry, materials.facadeDark, lowfx ? 6 : 10);
  lockers.name = 'dispatch:parcel-lockers';
  const lamps = new THREE.InstancedMesh(markerGeometry, materials.gold, canopyCount * 2);
  lamps.name = 'dispatch:warm-work-lamps';
  const drains = new THREE.InstancedMesh(unitBoxGeometry, materials.metal, lowfx ? 6 : 10);
  drains.name = 'dispatch:drains-and-wet-breakup';
  for(let index = 0; index < canopyCount; index += 1){
    const side = index % 2 ? 1 : -1;
    const s = 6 + Math.floor(index / 2) * 11;
    const lateral = side * 7.25;
    canopies.setMatrixAt(index, setInstanceAt(course, dummy, s, lateral, 3.45, 3.0, 0.24, 7.6));
    supports.setMatrixAt(index * 2, setInstanceAt(course, dummy, s - 2.8, side * 5.72, 1.7, 0.16, 3.4, 0.16));
    supports.setMatrixAt(index * 2 + 1, setInstanceAt(course, dummy, s + 2.8, side * 5.72, 1.7, 0.16, 3.4, 0.16));
    lamps.setMatrixAt(index * 2, setInstanceAt(course, dummy, s - 2.25, side * 6.0, 3.18, 0.22, 0.22, 0.22));
    lamps.setMatrixAt(index * 2 + 1, setInstanceAt(course, dummy, s + 2.25, side * 6.0, 3.18, 0.22, 0.22, 0.22));
    recordProp(semantics, 'dispatch-canopy', s, lateral, 3.45);
  }
  const lockerCount = lockers.count;
  for(let index = 0; index < lockerCount; index += 1){
    const side = index % 2 ? 1 : -1;
    const s = 3.5 + index * (20 / Math.max(1, lockerCount - 1));
    lockers.setMatrixAt(index, setInstanceAt(course, dummy, s, side * 6.25, 1.05, 1.25, 2.1, 0.9));
    recordProp(semantics, 'dispatch-locker', s, side * 6.25, 1.05);
  }
  for(let index = 0; index < drains.count; index += 1){
    const side = index % 2 ? 1 : -1;
    const s = 2.5 + index * (21 / Math.max(1, drains.count - 1));
    drains.setMatrixAt(index, setInstanceAt(course, dummy, s, side * 4.28, 0.035, 0.34, 0.035, 2.2));
    recordProp(semantics, 'dispatch-drain', s, side * 4.28, 0.035);
  }
  group.add(canopies, lockers, lamps);
  if(!lowfx) group.add(supports, drains);

  const cargoCount = lowfx ? 4 : 8;
  const crates = new THREE.InstancedMesh(unitBoxGeometry, materials.pale, cargoCount);
  crates.name = 'dispatch:cargo-stack';
  for(let index = 0; index < cargoCount; index += 1){
    const side = index % 2 ? 1 : -1;
    const s = 5 + index * (16 / Math.max(1, cargoCount - 1));
    const lateral = side * (6.75 + (index % 3) * 0.58);
    crates.setMatrixAt(index, setInstanceAt(course, dummy, s, lateral, 0.42,
      1.0 + (index % 2) * 0.38, 0.82, 1.25));
    recordProp(semantics, 'dispatch-cargo', s, lateral, 0.42);
  }
  if(!lowfx) group.add(crates);
  // The locker batch exists in both profiles, so the rendered-bounds mutation
  // negative remains meaningful under the constrained profile too.
  semantics.mutationInstance = { object: lockers, index: 0 };
}

function addRainSpan(group, course, materials, lowfx, semantics){
  const dummy = new THREE.Object3D();
  const count = lowfx ? 8 : 12;
  const fins = new THREE.InstancedMesh(unitBoxGeometry, materials.pale, count * 2);
  fins.name = 'rain-span:collector-fins';
  const understructure = new THREE.InstancedMesh(unitBoxGeometry, materials.metal, count);
  understructure.name = 'rain-span:visible-understructure';
  const landingDecks = new THREE.InstancedMesh(unitBoxGeometry, materials.facade, 4);
  landingDecks.name = 'rain-span:landing-decks';
  const puddles = new THREE.InstancedMesh(unitBoxGeometry, materials.cyan, lowfx ? 6 : 10);
  puddles.name = 'rain-span:edge-puddles';
  for(let index = 0; index < count; index += 1){
    const s = 27 + index * (31 / Math.max(1, count - 1));
    for(const side of [-1, 1]){
      const slot = index * 2 + (side > 0 ? 1 : 0);
      fins.setMatrixAt(slot, setInstanceAt(course, dummy, s, side * (DECK_HW + 2.6), 1.9,
        0.16, 3.8, 1.1, side * 0.2));
    }
    understructure.setMatrixAt(index, setInstanceAt(course, dummy, s, 0, -1.35, 10.7, 0.22, 0.26));
    recordProp(semantics, 'rain-understructure', s, 0, -1.35);
  }
  for(let index = 0; index < 4; index += 1){
    const side = index % 2 ? 1 : -1;
    const s = index < 2 ? 31 : 55;
    landingDecks.setMatrixAt(index, setInstanceAt(course, dummy, s, side * 7.05, -0.12, 3.4, 0.38, 7.2));
    recordProp(semantics, 'rain-landing-deck', s, side * 7.05, -0.12);
  }
  for(let index = 0; index < puddles.count; index += 1){
    const side = index % 2 ? 1 : -1;
    const s = 28 + index * (29 / Math.max(1, puddles.count - 1));
    puddles.setMatrixAt(index, setInstanceAt(course, dummy, s, side * 4.3, 0.026,
      0.28 + (index % 3) * 0.08, 0.025, 1.25 + (index % 2) * 0.75));
    recordProp(semantics, 'rain-puddle', s, side * 4.3, 0.026);
  }
  group.add(fins, understructure);
  if(!lowfx) group.add(landingDecks, puddles);
}

function addSwitchyard(group, course, materials, lowfx, semantics){
  const dummy = new THREE.Object3D();
  const cabinetCount = lowfx ? 8 : 12;
  const cabinets = new THREE.InstancedMesh(unitBoxGeometry, materials.facade, cabinetCount);
  cabinets.name = 'switchyard:service-cabinets';
  const carts = new THREE.InstancedMesh(unitBoxGeometry, materials.metal, lowfx ? 5 : 8);
  carts.name = 'switchyard:maintenance-carts';
  const reels = new THREE.InstancedMesh(ringGeometry, materials.gold, lowfx ? 6 : 10);
  reels.name = 'switchyard:cable-reels';
  const signals = new THREE.InstancedMesh(markerGeometry, materials.gold, 8);
  signals.name = 'switchyard:route-signals';
  for(let index = 0; index < cabinetCount; index += 1){
    const side = index % 2 ? 1 : -1;
    const s = 61.5 + index * (27 / Math.max(1, cabinetCount - 1));
    const lateral = side * (6.0 + (index % 3) * 0.55);
    cabinets.setMatrixAt(index, setInstanceAt(course, dummy, s, lateral, 1.15,
      1.1 + (index % 2) * 0.45, 2.3, 1.0));
    recordProp(semantics, 'switch-cabinet', s, lateral, 1.15);
  }
  for(let index = 0; index < carts.count; index += 1){
    const side = index % 2 ? 1 : -1;
    const s = 63 + index * (23 / Math.max(1, carts.count - 1));
    carts.setMatrixAt(index, setInstanceAt(course, dummy, s, side * 7.8, 0.48, 1.8, 0.78, 2.5));
    recordProp(semantics, 'switch-cart', s, side * 7.8, 0.48);
  }
  for(let index = 0; index < reels.count; index += 1){
    const side = index % 2 ? 1 : -1;
    const s = 62.5 + index * (25 / Math.max(1, reels.count - 1));
    reels.setMatrixAt(index, setInstanceAt(course, dummy, s, side * 6.15, 0.72, 0.62, 0.62, 0.62,
      side * Math.PI / 2));
    recordProp(semantics, 'switch-reel', s, side * 6.15, 0.72);
  }
  for(let index = 0; index < signals.count; index += 1){
    const side = index % 2 ? 1 : -1;
    const s = 63 + Math.floor(index / 2) * 7.2;
    signals.setMatrixAt(index, setInstanceAt(course, dummy, s, side * 7.15, 3.55, 0.25, 0.25, 0.25));
  }
  group.add(cabinets, reels);
  if(!lowfx) group.add(carts, signals);
}

function addBatchMover(movers, data){
  const pose = createPoseState();
  movers.push({ ...data, pose, poseIdentity: pose, dummy: new THREE.Object3D(), windowDummy: data.windowBatch ? new THREE.Object3D() : null });
}

function addMaglev(group, course, materials, lowfx, semantics, movers){
  const dummy = new THREE.Object3D();
  const tracks = new THREE.InstancedMesh(unitBoxGeometry, materials.metal, 4);
  tracks.name = 'maglev:paired-guideways';
  let slot = 0;
  for(const side of [-1, 1]){
    for(const railOffset of [-0.22, 0.22]){
      tracks.setMatrixAt(slot++, setInstanceAt(course, dummy, 101, side * (DECK_HW + 3.2) + railOffset,
        6.05, 0.16, 0.22, 26));
    }
    recordProp(semantics, 'maglev-track', 101, side * (DECK_HW + 3.2), 6.05);
  }
  const supportCount = lowfx ? 8 : 12;
  const undercroft = new THREE.InstancedMesh(unitBoxGeometry, materials.facadeDark, supportCount * 2 + Math.floor(supportCount / 2));
  undercroft.name = 'maglev:undercroft-structure';
  slot = 0;
  for(let index = 0; index < supportCount; index += 1){
    const s = 91 + index * (20 / Math.max(1, supportCount - 1));
    for(const side of [-1, 1]){
      undercroft.setMatrixAt(slot++, setInstanceAt(course, dummy, s, side * 5.35, 2.45, 0.32, 4.9, 0.32));
    }
    if(index % 2 === 0){
      undercroft.setMatrixAt(slot++, setInstanceAt(course, dummy, s, 0, 5.0, 10.9, 0.28, 0.34));
    }
    recordProp(semantics, 'maglev-undercroft', s, 5.35, 2.45);
  }
  undercroft.count = slot;

  const vehicleCount = lowfx ? 2 : 3;
  const vehicles = new THREE.InstancedMesh(trafficGeometry, materials.cyan, vehicleCount);
  vehicles.name = 'traffic:maglev-bodies';
  vehicles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const windows = new THREE.InstancedMesh(unitBoxGeometry, materials.magenta, vehicleCount);
  windows.name = 'traffic:maglev-window-bands';
  windows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for(let index = 0; index < vehicleCount; index += 1){
    const lateral = index % 2 ? DECK_HW + 3.2 : -(DECK_HW + 3.2);
    const baseS = 94 + index * 6;
    vehicles.setMatrixAt(index, setInstanceAt(course, dummy, baseS, lateral, 6.55, 1, 1, 1));
    windows.setMatrixAt(index, setInstanceAt(course, dummy, baseS, lateral, 6.72, 0.34, 0.16, 1.3));
    addBatchMover(movers, {
      type: 'maglev', batch: vehicles, windowBatch: lowfx ? null : windows, instanceIndex: index,
      baseS, lateral, speed: 4.2 + index * 0.6, y: 6.55, phase: index * 1.7,
    });
  }
  group.add(tracks, undercroft, vehicles);
  if(!lowfx) group.add(windows);
}

function addRelayCauseway(group, course, materials, semantics, lowfx){
  const tower = new THREE.Group();
  tower.name = 'landmark:aster-relay';
  placeAt(course, tower, 145, 8.6, -4.0);

  const shaft = new THREE.Mesh(relayMastGeometry, materials.facade);
  shaft.name = 'aster-relay:tapered-mast';
  shaft.position.y = 30;
  shaft.scale.set(2.25, 64, 2.25);
  tower.add(shaft);

  const spine = new THREE.Mesh(unitBoxGeometry, materials.metal);
  spine.name = 'aster-relay:offset-spine';
  spine.position.set(1.75, 30.5, 0.25);
  spine.scale.set(0.42, 52, 0.42);
  spine.rotation.z = -0.035;
  if(!lowfx) tower.add(spine);

  const warmCore = new THREE.Mesh(unitCylinderGeometry, materials.gold);
  warmCore.name = 'aster-relay:warm-core';
  // Negative local X faces back toward the course from the Relay's positive
  // lateral perch, keeping the gold core legible in approach and finish shots.
  warmCore.position.set(-1.72, 34, -0.45);
  warmCore.scale.set(0.42, 45, 0.42);
  tower.add(warmCore);

  const rings = new THREE.InstancedMesh(ringGeometry, materials.mint, 7);
  rings.name = 'aster-relay:relay-rings';
  const ringDummy = new THREE.Object3D();
  for(let index = 0; index < 7; index += 1){
    const height = 11 + index * 7.2;
    const radius = 2.45 - index * 0.13;
    ringDummy.position.set(0, height, 0);
    ringDummy.rotation.set(Math.PI / 2, 0, index * 0.18);
    ringDummy.scale.set(radius, radius, 0.7 + index * 0.035);
    ringDummy.updateMatrix();
    rings.setMatrixAt(index, ringDummy.matrix);
  }
  tower.add(rings);

  const crown = new THREE.Mesh(markerGeometry, materials.gold);
  crown.name = 'aster-relay:crown';
  crown.position.set(0.6, 64.5, -0.3);
  crown.scale.set(2.1, 3.2, 2.1);
  if(!lowfx) tower.add(crown);
  group.add(tower);
  semantics.landmarkObject = tower;
  semantics.landmark = { id: 'aster-relay', s: 145, lateral: 8.6, height: 68, named: tower.name };

  const dummy = new THREE.Object3D();
  const ribs = new THREE.InstancedMesh(unitBoxGeometry, materials.pale, 12);
  ribs.name = 'relay-causeway:service-ribs';
  for(let index = 0; index < 6; index += 1){
    const s = 116 + index * 5.5;
    for(const side of [-1, 1]){
      const slot = index * 2 + (side > 0 ? 1 : 0);
      ribs.setMatrixAt(slot, setInstanceAt(course, dummy, s, side * (DECK_HW + 1.7), 2.1,
        0.22, 4.2, 0.22, side * 0.12));
    }
    recordProp(semantics, 'relay-service-rib', s, DECK_HW + 1.7, 2.1);
  }

  // The Relay gate is a three-part luminous frame: side pylons remain beyond
  // the playable shoulder and the lintel remains safely overhead.
  const gateMetal = new THREE.InstancedMesh(unitBoxGeometry, materials.metal, 3);
  gateMetal.name = 'relay-causeway:finish-gate-structure';
  gateMetal.setMatrixAt(0, setInstanceAt(course, dummy, 149, -4.45, 2.85, 0.32, 5.7, 0.34));
  gateMetal.setMatrixAt(1, setInstanceAt(course, dummy, 149, 4.45, 2.85, 0.32, 5.7, 0.34));
  gateMetal.setMatrixAt(2, setInstanceAt(course, dummy, 149, 0, 5.62, 9.2, 0.28, 0.34));
  const gateLight = new THREE.InstancedMesh(unitBoxGeometry, materials.cyan, 3);
  gateLight.name = 'relay-causeway:finish-gate-light';
  gateLight.setMatrixAt(0, setInstanceAt(course, dummy, 149, -4.22, 3.05, 0.09, 4.9, 0.12));
  gateLight.setMatrixAt(1, setInstanceAt(course, dummy, 149, 4.22, 3.05, 0.09, 4.9, 0.12));
  gateLight.setMatrixAt(2, setInstanceAt(course, dummy, 149, 0, 5.36, 8.55, 0.10, 0.13));
  group.add(gateLight);
  if(!lowfx) group.add(ribs, gateMetal);
}

function addTraffic(group, materials, semantics, movers, lowfx){
  const count = lowfx ? 0 : 5;
  if(count === 0) return;
  const traffic = new THREE.InstancedMesh(markerGeometry, materials.gold, count);
  traffic.name = 'traffic:sky-couriers';
  traffic.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const dummy = new THREE.Object3D();
  for(let index = 0; index < count; index += 1){
    const baseS = 13 + index * 22;
    const lateral = (index % 2 ? 1 : -1) * (DECK_HW + 8 + (index % 3) * 2.5);
    dummy.scale.set(0.9, 0.28, 0.42);
    dummy.position.set(0, -1000, 0);
    dummy.updateMatrix();
    traffic.setMatrixAt(index, dummy.matrix);
    addBatchMover(movers, {
      type: 'drone', batch: traffic, windowBatch: null, instanceIndex: index,
      baseS, lateral, speed: 1.2 + index * 0.12, y: 7 + (index % 3) * 2.2, phase: index * 0.9,
    });
    recordProp(semantics, 'sky-traffic-route', baseS, lateral, 7);
  }
  group.add(traffic);
}

function isDescendantOf(object, root){
  let cursor = object;
  while(cursor){
    if(cursor === root) return true;
    cursor = cursor.parent;
  }
  return false;
}

function buildSafetyRegistry(group){
  const registry = [];
  group.traverse(object => {
    if((object.isMesh || object.isInstancedMesh) && !object.userData?.corridorAuditExclude){
      registry.push({
        object,
        name: object.name || object.type,
        uuid: object.uuid,
        isInstanced: Boolean(object.isInstancedMesh),
        expectedCount: object.isInstancedMesh ? object.count : 1,
        expectedCapacity: object.isInstancedMesh ? object.instanceMatrix?.count ?? null : null,
      });
    }
  });
  return registry;
}

function createCorridorAuditor(group, course, registry){
  const instanceMatrix = new THREE.Matrix4();
  const worldMatrix = new THREE.Matrix4();
  const localPoint = new THREE.Vector3();
  const worldPoint = new THREE.Vector3();
  const boxCenter = new THREE.Vector3();
  const nearestPose = createRawPoseOutput();
  const finalPose = createRawPoseOutput();
  const hazards = Array.isArray(course.hazards) ? course.hazards : [];

  function nearestCourseCoordinates(point){
    let bestS = 0;
    let bestDistanceSq = Infinity;
    for(let s = 0; s <= course.length; s += 2){
      const pose = course.poseAtInto(s, 0, nearestPose);
      const dx = point.x - pose.center.x;
      const dz = point.z - pose.center.z;
      const distanceSq = dx * dx + dz * dz;
      if(distanceSq < bestDistanceSq){
        bestDistanceSq = distanceSq;
        bestS = s;
      }
    }
    const low = Math.max(0, bestS - 2);
    const high = Math.min(course.length, bestS + 2);
    for(let s = low; s <= high + 0.0001; s += 0.2){
      const pose = course.poseAtInto(s, 0, nearestPose);
      const dx = point.x - pose.center.x;
      const dz = point.z - pose.center.z;
      const distanceSq = dx * dx + dz * dz;
      if(distanceSq < bestDistanceSq){
        bestDistanceSq = distanceSq;
        bestS = s;
      }
    }
    const pose = course.poseAtInto(bestS, 0, finalPose);
    const dx = point.x - pose.center.x;
    const dy = point.y - pose.center.y;
    const dz = point.z - pose.center.z;
    return {
      s: bestS,
      lateral: dx * pose.right.x + dy * pose.right.y + dz * pose.right.z,
      y: dy,
      distanceSq: bestDistanceSq,
    };
  }

  function inspectMatrix(geometry, matrix){
    if(!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if(!box || box.isEmpty()) return { finite: false, reason: 'empty-bounds' };
    let lateralMin = Infinity, lateralMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;
    let sMin = Infinity, sMax = -Infinity;
    let maxRouteDistanceSq = 0;
    for(let sample = 0; sample < 9; sample += 1){
      if(sample === 8){
        box.getCenter(boxCenter);
        localPoint.copy(boxCenter);
      } else {
        localPoint.set(
          sample & 1 ? box.max.x : box.min.x,
          sample & 2 ? box.max.y : box.min.y,
          sample & 4 ? box.max.z : box.min.z,
        );
      }
      worldPoint.copy(localPoint).applyMatrix4(matrix);
      if(!Number.isFinite(worldPoint.x) || !Number.isFinite(worldPoint.y) || !Number.isFinite(worldPoint.z)){
        return { finite: false, reason: 'non-finite-world-bounds' };
      }
      const coordinates = nearestCourseCoordinates(worldPoint);
      lateralMin = Math.min(lateralMin, coordinates.lateral);
      lateralMax = Math.max(lateralMax, coordinates.lateral);
      yMin = Math.min(yMin, coordinates.y);
      yMax = Math.max(yMax, coordinates.y);
      sMin = Math.min(sMin, coordinates.s);
      sMax = Math.max(sMax, coordinates.s);
      maxRouteDistanceSq = Math.max(maxRouteDistanceSq, coordinates.distanceSq);
    }
    const lateralOverlap = lateralMin < ACTIVE_CORRIDOR_HALF_WIDTH && lateralMax > -ACTIVE_CORRIDOR_HALF_WIDTH;
    const verticalOverlap = yMin < RUNNER_CLEARANCE_MAX && yMax > RUNNER_CLEARANCE_MIN;
    return {
      finite: true,
      sMin, sMax, lateralMin, lateralMax, yMin, yMax,
      maxRouteDistance: Math.sqrt(maxRouteDistanceSq),
      intrudes: lateralOverlap && verticalOverlap,
    };
  }

  function cueVolumesFor(bounds){
    const ids = [];
    for(const hazard of hazards){
      const low = Number.isFinite(hazard.cueStart) ? hazard.cueStart : hazard.s0;
      const high = Number.isFinite(hazard.landingEnd) ? hazard.landingEnd : hazard.s1;
      if(bounds.sMax >= low && bounds.sMin <= high) ids.push(hazard.id);
    }
    return ids;
  }

  function auditCorridorSafety(){
    group.updateWorldMatrix(true, true);
    const violations = [];
    const detached = [];
    const missingRenderables = [];
    const countMismatches = [];
    const unexpectedRenderables = [];
    const nonFinite = [];
    let checkedMeshes = 0;
    let checkedBounds = 0;
    let instancedBounds = 0;
    for(const entry of registry){
      const object = entry.object;
      if(!object || !isDescendantOf(object, group)){
        detached.push({ name: entry.name, uuid: entry.uuid });
        continue;
      }
      if(!object.geometry){
        missingRenderables.push({ name: entry.name, uuid: entry.uuid, reason: 'missing-geometry' });
        continue;
      }
      if(entry.isInstanced && (
        object.count !== entry.expectedCount
        || (object.instanceMatrix?.count ?? null) !== entry.expectedCapacity
      )){
        countMismatches.push({
          name: entry.name,
          uuid: entry.uuid,
          expectedCount: entry.expectedCount,
          actualCount: object.count,
          expectedCapacity: entry.expectedCapacity,
          actualCapacity: object.instanceMatrix?.count ?? null,
        });
      }
      checkedMeshes += 1;
      const instanceCount = object.isInstancedMesh ? object.count : 1;
      for(let index = 0; index < instanceCount; index += 1){
        if(object.isInstancedMesh){
          object.getMatrixAt(index, instanceMatrix);
          worldMatrix.multiplyMatrices(object.matrixWorld, instanceMatrix);
          instancedBounds += 1;
        } else {
          worldMatrix.copy(object.matrixWorld);
        }
        const bounds = inspectMatrix(object.geometry, worldMatrix);
        checkedBounds += 1;
        if(!bounds.finite){
          nonFinite.push({ name: entry.name, instanceIndex: object.isInstancedMesh ? index : null, reason: bounds.reason });
        } else if(bounds.intrudes){
          violations.push({
            name: entry.name,
            instanceIndex: object.isInstancedMesh ? index : null,
            sRange: [bounds.sMin, bounds.sMax],
            lateralRange: [bounds.lateralMin, bounds.lateralMax],
            heightRange: [bounds.yMin, bounds.yMax],
            cueVolumes: cueVolumesFor(bounds),
          });
        }
      }
    }
    const expectedObjects = new Set(registry.map(entry => entry.object));
    group.traverse(object => {
      if((object.isMesh || object.isInstancedMesh)
        && !object.userData?.corridorAuditExclude
        && !expectedObjects.has(object)){
        unexpectedRenderables.push({ name: object.name || object.type, uuid: object.uuid });
      }
    });
    const ok = detached.length === 0
      && missingRenderables.length === 0
      && countMismatches.length === 0
      && unexpectedRenderables.length === 0
      && nonFinite.length === 0
      && violations.length === 0;
    return {
      ok,
      source: 'actual-world-bounds',
      basis: 'rendered-world-bounds',
      activeCorridorHalfWidth: ACTIVE_CORRIDOR_HALF_WIDTH,
      runnerClearance: [RUNNER_CLEARANCE_MIN, RUNNER_CLEARANCE_MAX],
      registryExpected: registry.length,
      expectedRenderables: registry.length,
      presentRenderables: registry.length - detached.length - missingRenderables.length,
      checkedMeshes,
      inspectedMeshes: checkedMeshes,
      checkedBounds,
      instancedBounds,
      inspectedInstances: instancedBounds,
      probeCount: checkedBounds * 9,
      detached,
      missingRenderables,
      countMismatches,
      unexpectedRenderables,
      nonFinite,
      violations,
      cueCorridorHits: violations.filter(row => row.cueVolumes.length > 0),
    };
  }

  return { auditCorridorSafety };
}

function updateMoverInstance(course, mover, s, y){
  const pose = writePose(course, Math.min(course.length - 0.01, s), 0, mover.pose);
  applyPose(mover.dummy, pose, mover.lateral, y);
  if(mover.type === 'drone'){
    mover.dummy.rotation.z = Math.sin(mover.currentTime * 2 + mover.phase) * 0.08;
    mover.dummy.scale.set(0.9, 0.28, 0.42);
  } else {
    mover.dummy.scale.set(1, 1, 1);
  }
  mover.dummy.updateMatrix();
  mover.batch.setMatrixAt(mover.instanceIndex, mover.dummy.matrix);
  mover.batch.instanceMatrix.needsUpdate = true;
  if(mover.windowBatch){
    applyPose(mover.windowDummy, pose, mover.lateral, y + 0.17);
    mover.windowDummy.scale.set(0.34, 0.16, 1.3);
    mover.windowDummy.updateMatrix();
    mover.windowBatch.setMatrixAt(mover.instanceIndex, mover.windowDummy.matrix);
    mover.windowBatch.instanceMatrix.needsUpdate = true;
  }
}

export function buildDistricts(parent, course, { lowfx = false, accentMaterials = null } = {}){
  if(!parent?.add || !course?.poseAtInto) throw new TypeError('buildDistricts requires a parent and RunnerCourseModel');
  const group = new THREE.Group();
  group.name = 'runner-phase4-districts';
  parent.add(group);
  const materials = createMaterialKit(accentMaterials || {});
  const semantics = {
    props: [], labels: [], landmark: null, landmarkObject: null, mutationInstance: null,
    featureSets: {
      'dispatch-roof': ['canopy', 'parcel-lockers', 'drains', 'warm-work-lamps'],
      'rain-span': ['open-span', 'visible-understructure', 'landing-decks', 'edge-puddles'],
      switchyard: ['service-cabinets', 'maintenance-carts', 'cable-reels', 'route-signals'],
      'maglev-undercroft': ['paired-guideways', 'undercroft-structure', 'moving-maglev'],
      'relay-causeway': ['open-skyline', 'finish-gate', 'aster-relay', 'warm-core', 'relay-rings'],
    },
  };
  const movers = [];

  buildFacadeHierarchy(group, course, materials, lowfx, semantics);
  buildEdgeArchitecture(group, course, materials, lowfx, semantics);
  addDistrictLabels(group, course, materials, semantics);
  addDispatchRoof(group, course, materials, semantics, lowfx);
  addRainSpan(group, course, materials, lowfx, semantics);
  addSwitchyard(group, course, materials, lowfx, semantics);
  addMaglev(group, course, materials, lowfx, semantics, movers);
  addRelayCauseway(group, course, materials, semantics, lowfx);
  addTraffic(group, materials, semantics, movers, lowfx);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900).rotateX(-Math.PI / 2), materials.ground);
  ground.name = 'city-basin';
  ground.position.y = -5;
  ground.userData.corridorAuditExclude = true;
  group.add(ground);

  // Put every moving instance at its deterministic t=0 position before the
  // registry baseline is captured; no origin/zero-matrix false positives.
  const tickMetrics = { calls: 0, moverWrites: 0, transientAllocations: 0, stablePoseOutputs: true };
  const districts = { group, course, materials, movers, semantics, tickMetrics };
  tickDistricts(0, districts, course);

  const safetyRegistry = buildSafetyRegistry(group);
  const corridorAuditor = createCorridorAuditor(group, course, safetyRegistry);
  const relayHome = {
    parent: semantics.landmarkObject.parent,
    position: semantics.landmarkObject.position.clone(),
    quaternion: semantics.landmarkObject.quaternion.clone(),
    scale: semantics.landmarkObject.scale.clone(),
  };
  const representativeHome = new THREE.Matrix4();
  const representativeMesh = semantics.mutationInstance.object;
  const representativeMeshHome = {
    parent: representativeMesh.parent,
    count: representativeMesh.count,
  };
  representativeMesh.getMatrixAt(semantics.mutationInstance.index, representativeHome);
  const relayMast = semantics.landmarkObject.getObjectByName('aster-relay:tapered-mast');
  const relayMastHome = { parent: relayMast.parent };
  const mutationPose = createPoseState();
  const mutationDummy = new THREE.Object3D();
  let relayMoved = false;
  let relayScaled = false;
  let instanceMoved = false;
  let relayDetached = false;
  let relayPartRemoved = false;
  let instanceMeshDetached = false;
  let instanceCountDecremented = false;

  function debugMoveAsterRelayIntoCorridor(targetS = 58){
    if(!Number.isFinite(targetS)) throw new TypeError('targetS must be finite');
    placeAt(course, semantics.landmarkObject, targetS, 0, -4, mutationPose);
    semantics.landmarkObject.updateWorldMatrix(true, true);
    relayMoved = true;
    return corridorAuditor.auditCorridorSafety();
  }

  function restoreAsterRelay(){
    const tower = semantics.landmarkObject;
    tower.position.copy(relayHome.position);
    tower.quaternion.copy(relayHome.quaternion);
    tower.scale.copy(relayHome.scale);
    tower.updateWorldMatrix(true, true);
    relayMoved = false;
    return true;
  }

  function debugScaleAsterRelay(scale = 12){
    if(!Number.isFinite(scale) || scale <= 0) throw new TypeError('scale must be a positive finite number');
    semantics.landmarkObject.scale.copy(relayHome.scale).multiplyScalar(scale);
    semantics.landmarkObject.updateWorldMatrix(true, true);
    relayScaled = true;
    return corridorAuditor.auditCorridorSafety();
  }

  function restoreScaledAsterRelay(){
    semantics.landmarkObject.scale.copy(relayHome.scale);
    semantics.landmarkObject.updateWorldMatrix(true, true);
    relayScaled = false;
    return true;
  }

  function debugMoveInstanceIntoCorridor(targetS = 92){
    if(!Number.isFinite(targetS)) throw new TypeError('targetS must be finite');
    const entry = semantics.mutationInstance;
    entry.object.setMatrixAt(entry.index, setInstanceAt(course, mutationDummy, targetS, 0, 1.0, 3.2, 2.0, 3.0, 0, mutationPose));
    entry.object.instanceMatrix.needsUpdate = true;
    entry.object.updateWorldMatrix(true, true);
    instanceMoved = true;
    return corridorAuditor.auditCorridorSafety();
  }

  function restoreMovedInstance(){
    const entry = semantics.mutationInstance;
    entry.object.setMatrixAt(entry.index, representativeHome);
    entry.object.instanceMatrix.needsUpdate = true;
    entry.object.updateWorldMatrix(true, true);
    instanceMoved = false;
    return true;
  }

  function debugDetachDecoration(){
    const tower = semantics.landmarkObject;
    if(tower.parent) tower.parent.remove(tower);
    relayDetached = true;
    return corridorAuditor.auditCorridorSafety();
  }

  function restoreDetachedDecoration(){
    const tower = semantics.landmarkObject;
    if(!tower.parent) relayHome.parent.add(tower);
    tower.updateWorldMatrix(true, true);
    relayDetached = false;
    return true;
  }

  function debugRemoveRelayPart(){
    if(relayMast.parent) relayMast.parent.remove(relayMast);
    relayPartRemoved = true;
    return corridorAuditor.auditCorridorSafety();
  }

  function restoreRelayPart(){
    if(!relayMast.parent) relayMastHome.parent.add(relayMast);
    relayMast.updateWorldMatrix(true, true);
    relayPartRemoved = false;
    return true;
  }

  function debugDetachInstanceMesh(){
    if(representativeMesh.parent) representativeMesh.parent.remove(representativeMesh);
    instanceMeshDetached = true;
    return corridorAuditor.auditCorridorSafety();
  }

  function restoreDetachedInstanceMesh(){
    if(!representativeMesh.parent) representativeMeshHome.parent.add(representativeMesh);
    representativeMesh.updateWorldMatrix(true, true);
    instanceMeshDetached = false;
    return true;
  }

  function debugDecrementInstanceCount(){
    representativeMesh.count = Math.max(0, representativeMeshHome.count - 1);
    instanceCountDecremented = true;
    return corridorAuditor.auditCorridorSafety();
  }

  function restoreInstanceCount(){
    representativeMesh.count = representativeMeshHome.count;
    instanceCountDecremented = false;
    return true;
  }

  function restoreSafetyMutations(){
    restoreInstanceCount();
    restoreDetachedInstanceMesh();
    restoreRelayPart();
    restoreDetachedDecoration();
    restoreScaledAsterRelay();
    restoreAsterRelay();
    restoreMovedInstance();
    return corridorAuditor.auditCorridorSafety();
  }

  function allocationReport(){
    let stablePoseOutputs = tickMetrics.stablePoseOutputs;
    for(const mover of movers) stablePoseOutputs = stablePoseOutputs && mover.pose === mover.poseIdentity;
    return {
      calls: tickMetrics.calls,
      moverWrites: tickMetrics.moverWrites,
      moverCount: movers.length,
      transientAllocations: tickMetrics.transientAllocations,
      stablePoseOutputs,
      usesPoseAtInto: true,
    };
  }

  function semanticReport(){
    const geometryAudit = corridorAuditor.auditCorridorSafety();
    let instancedMeshes = 0;
    let pointLightCount = 0;
    group.traverse(object => { if(object.isInstancedMesh) instancedMeshes += 1; });
    semantics.landmarkObject.traverse(object => { if(object.isPointLight) pointLightCount += 1; });
    return {
      districts: DISTRICT_DEFS.map(district => ({ ...district })),
      labels: semantics.labels.map(label => ({ ...label })),
      districtFeatures: Object.fromEntries(Object.entries(semantics.featureSets).map(([id, features]) => [id, [...features]])),
      landmark: { ...semantics.landmark, pointLightCount },
      propCount: semantics.props.length,
      unsafeDecorations: geometryAudit.violations.map(row => ({ ...row })),
      allDecorationsClearCueCorridor: geometryAudit.ok,
      geometryAudit,
      moverCount: movers.length,
      moverAllocation: allocationReport(),
      instancedMeshes,
      materialCount: new Set(Object.values(materials)).size,
      mutationState: {
        relayMoved, relayScaled, instanceMoved, relayDetached,
        relayPartRemoved, instanceMeshDetached, instanceCountDecremented,
      },
    };
  }

  function setTitlePresentation(active){
    group.traverse(object => {
      if(object.userData?.titleOccluder) object.visible = !active;
    });
  }

  return Object.assign(districts, {
    safetyRegistry,
    auditCorridorSafety: corridorAuditor.auditCorridorSafety,
    semanticReport,
    allocationReport,
    setTitlePresentation,
    debugMoveAsterRelayIntoCorridor,
    restoreAsterRelay,
    debugScaleAsterRelay,
    restoreScaledAsterRelay,
    debugMoveInstanceIntoCorridor,
    restoreMovedInstance,
    debugDetachDecoration,
    restoreDetachedDecoration,
    debugRemoveRelayPart,
    restoreRelayPart,
    debugDetachInstanceMesh,
    restoreDetachedInstanceMesh,
    debugDecrementInstanceCount,
    restoreInstanceCount,
    restoreSafetyMutations,
  });
}

export function tickDistricts(time, districts, course){
  if(!districts?.movers) return;
  const metrics = districts.tickMetrics;
  if(metrics) metrics.calls += 1;
  for(let index = 0; index < districts.movers.length; index += 1){
    const mover = districts.movers[index];
    if(metrics) metrics.stablePoseOutputs = metrics.stablePoseOutputs && mover.pose === mover.poseIdentity;
    const span = mover.type === 'maglev' ? 22 : 38;
    const districtStart = mover.type === 'maglev' ? 90 : Math.max(0, mover.baseS - 8);
    const s = districtStart + ((mover.baseS - districtStart + time * mover.speed + mover.phase) % span);
    const bob = mover.type === 'drone' ? Math.sin(time * 1.7 + mover.phase) * 0.35 : 0;
    mover.currentTime = time;
    updateMoverInstance(course, mover, s, mover.y + bob);
    if(metrics) metrics.moverWrites += 1;
  }
}
