/* Gridlock Run Phase 4 — deterministic articulated courier family.
   The courier is presentation-only: the authoritative simulation owns every
   distance, lane, action window, result, and recovery decision. */
import * as THREE from 'three';
import { mergeGeos, smooth } from '../../engine/util.js';

const PROFILE_DEFS = Object.freeze({
  player: Object.freeze({
    id: 'player', callSign: 'K-6', silhouette: 'relay-courier', cadence: 1,
    shell: 0xDDE9EE, fabric: 0x121827, accent: 0x38E4F5, secondary: 0xFF4ABF,
    stature: 1, shoulder: 1.08, torso: 1.02, depth: 1.05, limb: 1.02, parcelSide: 1,
    parcelScale: [0.92, 0.90], parcelY: 0.30, stride: 1,
  }),
  volt: Object.freeze({
    id: 'volt', callSign: 'VOLT', silhouette: 'split-fin-sprinter', cadence: 1.12,
    shell: 0xBCEEFF, fabric: 0x0B2230, accent: 0x25E5FF, secondary: 0x7BFAFF,
    stature: 1.06, shoulder: 0.87, torso: 1.02, depth: 0.88, limb: 1.12, parcelSide: -1,
    parcelScale: [0.62, 0.82], parcelY: 0.34, stride: 1.16,
  }),
  nyx: Object.freeze({
    id: 'nyx', callSign: 'NYX', silhouette: 'hooded-angle-scout', cadence: 0.94,
    shell: 0xE6D7E9, fabric: 0x211126, accent: 0xFF45CD, secondary: 0xB675FF,
    stature: 0.94, shoulder: 0.92, torso: 0.91, depth: 0.92, limb: 0.92, parcelSide: 1,
    parcelScale: [0.72, 0.58], parcelY: 0.18, stride: 0.94,
  }),
  jet: Object.freeze({
    id: 'jet', callSign: 'JET', silhouette: 'twin-pack-power-runner', cadence: 0.86,
    shell: 0xF1E1B6, fabric: 0x251E14, accent: 0xFFC24B, secondary: 0xFF713D,
    stature: 1.02, shoulder: 1.23, torso: 1.04, depth: 1.13, limb: 0.95, parcelSide: -1,
    parcelScale: [0.78, 0.68], parcelY: 0.29, stride: 0.88,
  }),
});

export const COURIER_SLIDE_BOUNDS = Object.freeze({ floor: -0.015, ceiling: 1.40, samples: 65 });

// A single immutable traversal list keeps the pose hot path allocation-free.
// Each rig retains this exact identity so the browser audit can prove the
// reset contract did not silently regress to a per-frame array literal.
const RESET_JOINT_NAMES = Object.freeze([
  'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle',
]);

const geometryCache = new Map();
function cachedGeometry(key, create){
  if(!geometryCache.has(key)) geometryCache.set(key, create());
  return geometryCache.get(key);
}

function transformed(geometry, matrix){
  geometry.applyMatrix4(matrix);
  return geometry;
}

function matrix(position, scale = null, rotation = null){
  const object = new THREE.Object3D();
  object.position.copy(position);
  if(scale) object.scale.copy(scale);
  if(rotation) object.rotation.set(rotation.x, rotation.y, rotation.z);
  object.updateMatrix();
  return object.matrix;
}

function mergeParts(geometries){
  for(const geometry of geometries){
    if(geometry.index) continue;
    const indices = new Uint32Array(geometry.getAttribute('position').count);
    for(let index = 0; index < indices.length; index += 1) indices[index] = index;
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  }
  return mergeGeos(geometries);
}

function torsoShellGeometry(){
  return cachedGeometry('athletic-rib-shell', () => {
    const half = new THREE.Shape();
    half.moveTo(0.025, 0.05);
    half.lineTo(0.14, 0.02);
    half.lineTo(0.265, 0.40);
    half.lineTo(0.305, 0.57);
    half.lineTo(0.19, 0.64);
    half.lineTo(0.055, 0.53);
    half.closePath();
    const createHalf = sign => {
      const geometry = new THREE.ExtrudeGeometry(half, {
        depth: 0.26, bevelEnabled: true, bevelThickness: 0.018,
        bevelSize: 0.016, bevelSegments: 1, curveSegments: 2,
      });
      geometry.translate(0, 0, -0.13);
      geometry.scale(sign, 1, 1);
      return geometry;
    };
    return smooth(mergeParts([createHalf(1), createHalf(-1)]));
  });
}

function torsoCoreGeometry(){
  return cachedGeometry('tapered-torso-core', () => {
    const geometry = new THREE.CylinderGeometry(0.255, 0.145, 0.56, 6, 1, false);
    geometry.translate(0, 0.30, 0);
    geometry.rotateY(Math.PI / 6);
    return smooth(geometry);
  });
}

function upperArmGeometry(){
  return cachedGeometry('layered-upper-arm', () => {
    const cap = transformed(new THREE.SphereGeometry(0.112, 8, 6),
      matrix(new THREE.Vector3(0, -0.025, 0), new THREE.Vector3(1.14, 0.76, 1.04)));
    const bicep = new THREE.CylinderGeometry(0.064, 0.084, 0.31, 7);
    bicep.translate(0, -0.175, 0);
    return smooth(mergeParts([cap, bicep]));
  });
}

function forearmGeometry(){
  return cachedGeometry('layered-forearm-hand', () => {
    const elbow = transformed(new THREE.SphereGeometry(0.074, 7, 5),
      matrix(new THREE.Vector3(0, -0.015, 0), new THREE.Vector3(1.05, 0.68, 1)));
    const forearm = new THREE.CylinderGeometry(0.052, 0.073, 0.29, 7);
    forearm.translate(0, -0.165, 0);
    const cuff = transformed(new THREE.CylinderGeometry(0.052, 0.052, 0.055, 7),
      matrix(new THREE.Vector3(0, -0.315, 0)));
    const hand = transformed(new THREE.BoxGeometry(0.095, 0.115, 0.105),
      matrix(new THREE.Vector3(0, -0.385, 0.028), new THREE.Vector3(0.8, 1, 0.78), new THREE.Vector3(0.12, 0, 0)));
    return smooth(mergeParts([elbow, forearm, cuff, hand]));
  });
}

function thighGeometry(){
  return cachedGeometry('tapered-thigh', () => {
    const hip = transformed(new THREE.SphereGeometry(0.122, 8, 6),
      matrix(new THREE.Vector3(0, -0.025, 0), new THREE.Vector3(1, 0.72, 0.94)));
    const thigh = new THREE.CylinderGeometry(0.084, 0.116, 0.39, 7);
    thigh.translate(0, -0.22, 0);
    return smooth(mergeParts([hip, thigh]));
  });
}

function shinGeometry(){
  return cachedGeometry('armored-shin', () => {
    const knee = transformed(new THREE.SphereGeometry(0.087, 8, 6),
      matrix(new THREE.Vector3(0, -0.018, 0.016), new THREE.Vector3(1.06, 0.72, 1.12)));
    const shin = new THREE.CylinderGeometry(0.058, 0.082, 0.41, 7);
    shin.translate(0, -0.23, 0);
    const ankle = transformed(new THREE.CylinderGeometry(0.049, 0.049, 0.055, 7),
      matrix(new THREE.Vector3(0, -0.445, 0)));
    return smooth(mergeParts([knee, shin, ankle]));
  });
}

function footGeometry(){
  return cachedGeometry('tapered-running-shoe', () => {
    const positions = new Float32Array([
      -0.070,  0.015, -0.075,   0.070,  0.015, -0.075,
      -0.070, -0.095, -0.075,   0.070, -0.095, -0.075,
      -0.105, -0.005,  0.275,   0.105, -0.005,  0.275,
      -0.090, -0.080,  0.275,   0.090, -0.080,  0.275,
    ]);
    const indices = [
      0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6,
      0, 4, 2, 4, 6, 2, 1, 3, 5, 5, 3, 7,
      0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7,
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  });
}

function parcelGeometry(){
  return cachedGeometry('compact-courier-pack', () => {
    const shape = new THREE.Shape();
    shape.moveTo(-0.17, -0.21);
    shape.lineTo(0.14, -0.21);
    shape.lineTo(0.18, -0.13);
    shape.lineTo(0.16, 0.20);
    shape.lineTo(0.09, 0.25);
    shape.lineTo(-0.14, 0.22);
    shape.lineTo(-0.18, 0.13);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.14, bevelEnabled: true, bevelThickness: 0.016,
      bevelSize: 0.014, bevelSegments: 1, curveSegments: 2,
    });
    geometry.translate(0, 0, -0.07);
    return smooth(geometry);
  });
}

function backPlateGeometry(){
  return cachedGeometry('courier-back-armor', () => {
    const shape = new THREE.Shape();
    shape.moveTo(-0.18, -0.18);
    shape.lineTo(0.18, -0.18);
    shape.lineTo(0.22, 0.12);
    shape.lineTo(0.13, 0.20);
    shape.lineTo(-0.13, 0.20);
    shape.lineTo(-0.22, 0.12);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.045, bevelEnabled: true, bevelThickness: 0.009,
      bevelSize: 0.008, bevelSegments: 1, curveSegments: 2,
    });
    geometry.translate(0, 0, -0.0225);
    return smooth(geometry);
  });
}

function pelvisArmorGeometry(){
  return cachedGeometry('courier-pelvis-armor', () => {
    const geometry = new THREE.CylinderGeometry(0.205, 0.235, 0.20, 6, 1, false);
    geometry.rotateY(Math.PI / 6);
    return smooth(geometry);
  });
}

function signatureGeometry(profileId){
  return cachedGeometry(`signature:${profileId}`, () => {
    if(profileId === 'volt'){
      const left = transformed(new THREE.ConeGeometry(0.105, 0.58, 3),
        matrix(new THREE.Vector3(-0.105, 0.20, -0.23), new THREE.Vector3(0.65, 1, 0.42), new THREE.Vector3(-0.45, 0, 0.16)));
      const right = transformed(new THREE.ConeGeometry(0.105, 0.58, 3),
        matrix(new THREE.Vector3(0.105, 0.20, -0.23), new THREE.Vector3(0.65, 1, 0.42), new THREE.Vector3(-0.45, 0, -0.16)));
      return mergeParts([left, right]);
    }
    if(profileId === 'nyx'){
      const hood = new THREE.TorusGeometry(0.205, 0.043, 5, 12, Math.PI * 1.48);
      hood.rotateZ(-Math.PI * 0.74);
      const peak = transformed(new THREE.ConeGeometry(0.12, 0.31, 4),
        matrix(new THREE.Vector3(0, 0.15, -0.105), new THREE.Vector3(0.8, 1, 0.72), new THREE.Vector3(-0.36, 0, 0)));
      return mergeParts([hood, peak]);
    }
    if(profileId === 'jet'){
      const left = transformed(new THREE.BoxGeometry(0.19, 0.43, 0.15),
        matrix(new THREE.Vector3(-0.21, 0.26, -0.18), new THREE.Vector3(1, 1, 0.8), new THREE.Vector3(0, 0, -0.08)));
      const right = transformed(new THREE.BoxGeometry(0.19, 0.43, 0.15),
        matrix(new THREE.Vector3(0.21, 0.26, -0.18), new THREE.Vector3(1, 1, 0.8), new THREE.Vector3(0, 0, 0.08)));
      return mergeParts([left, right]);
    }
    const beacon = transformed(new THREE.BoxGeometry(0.16, 0.052, 0.035),
      matrix(new THREE.Vector3(0.02, 0.205, -0.095), null, new THREE.Vector3(0, 0, -0.08)));
    const node = transformed(new THREE.OctahedronGeometry(0.048, 0),
      matrix(new THREE.Vector3(0.09, 0.205, -0.105), new THREE.Vector3(0.72, 1, 0.72)));
    return mergeParts([beacon, node]);
  });
}

const commonShellMaterial = new THREE.MeshStandardMaterial({
  color: 0xDDE9EE, roughness: 0.31, metalness: 0.18,
  emissive: 0x080A0B, emissiveIntensity: 0.2,
});
const commonFabricMaterial = new THREE.MeshStandardMaterial({
  color: 0x121827, roughness: 0.78, metalness: 0.08,
});
const commonJointMaterial = new THREE.MeshStandardMaterial({
  color: 0x202B3A, roughness: 0.46, metalness: 0.58,
});
const commonVisorMaterial = new THREE.MeshStandardMaterial({
  color: 0x07131E, roughness: 0.20, metalness: 0.74,
  emissive: 0x082B36, emissiveIntensity: 0.42,
});
const commonPackMaterial = new THREE.MeshStandardMaterial({
  color: 0x172536, roughness: 0.48, metalness: 0.42,
  emissive: 0x06111A, emissiveIntensity: 0.25,
});
const commonTetherMaterial = new THREE.LineBasicMaterial({ color: 0xFF4ABF });
const accentMaterials = new Map();
function accentMaterial(color){
  if(!accentMaterials.has(color)) accentMaterials.set(color, new THREE.MeshBasicMaterial({ color }));
  return accentMaterials.get(color);
}
function materialsFor(profile){
  const accent = accentMaterial(profile.accent);
  return {
    shell: commonShellMaterial,
    fabric: commonFabricMaterial,
    joint: commonJointMaterial,
    accent,
    secondary: accent,
    visor: commonVisorMaterial,
    pack: commonPackMaterial,
  };
}

function mesh(name, geometry, material, parent, position = null){
  const object = new THREE.Mesh(geometry, material);
  object.name = name;
  object.castShadow = false;
  object.receiveShadow = false;
  if(position) object.position.copy(position);
  parent.add(object);
  return object;
}

function joint(name, parent, x, y, z){
  const pivot = new THREE.Group();
  pivot.name = name;
  pivot.position.set(x, y, z);
  parent.add(pivot);
  return pivot;
}

function buildArm(side, chest, profile, materials, joints){
  const sign = side === 'left' ? -1 : 1;
  const shoulder = joint(`${side}Shoulder`, chest, sign * 0.315 * profile.shoulder, 0.51 * profile.torso, 0);
  const upper = mesh(`${side}UpperArm`, upperArmGeometry(), materials.fabric, shoulder);
  upper.scale.set(profile.id === 'jet' ? 1.12 : 1, profile.id === 'volt' ? 1.05 : 1, profile.depth);
  const upperLength = 0.35 * (profile.id === 'volt' ? 1.07 : profile.id === 'nyx' ? 0.93 : 1);
  const elbow = joint(`${side}Elbow`, shoulder, 0, -upperLength, 0);
  const forearm = mesh(`${side}Forearm`, forearmGeometry(), materials.shell, elbow);
  forearm.scale.set(profile.id === 'jet' ? 1.10 : 1, profile.id === 'volt' ? 1.05 : profile.id === 'nyx' ? 0.92 : 1, profile.depth);
  const wrist = joint(`${side}Wrist`, elbow, 0, -0.34 * (profile.id === 'volt' ? 1.05 : profile.id === 'nyx' ? 0.92 : 1), 0);
  const hand = joint(`${side}Hand`, wrist, 0, -0.07, 0.02);
  Object.assign(joints, {
    [`${side}Shoulder`]: shoulder,
    [`${side}Elbow`]: elbow,
    [`${side}Wrist`]: wrist,
    [`${side}Hand`]: hand,
  });
}

function buildLeg(side, pelvis, profile, materials, joints){
  const sign = side === 'left' ? -1 : 1;
  const upperLength = 0.43 * profile.limb;
  const lowerLength = 0.45 * profile.limb;
  const hip = joint(`${side}Hip`, pelvis, sign * 0.142 * (profile.id === 'jet' ? 1.12 : 1), 0.01, 0);
  const thigh = mesh(`${side}Thigh`, thighGeometry(), materials.fabric, hip);
  thigh.scale.set(profile.id === 'jet' ? 1.14 : profile.id === 'volt' ? 0.88 : 1, profile.limb, profile.depth);
  const knee = joint(`${side}Knee`, hip, 0, -upperLength, 0);
  const shin = mesh(`${side}Shin`, shinGeometry(), materials.shell, knee);
  shin.scale.set(profile.id === 'jet' ? 1.10 : profile.id === 'volt' ? 0.86 : 1, profile.limb, profile.depth);
  const ankle = joint(`${side}Ankle`, knee, 0, -lowerLength, 0);
  const foot = mesh(`${side}Foot`, footGeometry(), materials.fabric, ankle);
  foot.scale.set(profile.id === 'jet' ? 1.13 : profile.id === 'nyx' ? 0.88 : 1, profile.id === 'volt' ? 0.96 : 1, profile.id === 'volt' ? 1.10 : 1);
  Object.assign(joints, {
    [`${side}Hip`]: hip,
    [`${side}Knee`]: knee,
    [`${side}Ankle`]: ankle,
    [`${side}Foot`]: foot,
  });
  return upperLength + lowerLength;
}

function addProfileSilhouette(root, chest, head, parcel, profile, materials){
  const signature = new THREE.Group();
  signature.name = `profileSignature:${profile.id}`;
  const parent = profile.id === 'nyx' ? head : profile.id === 'player' ? parcel : chest;
  parent.add(signature);
  const signatureMesh = mesh({
    volt: 'voltSplitFin', nyx: 'nyxAngularHood', jet: 'jetTwinPacks', player: 'k6RelayBlade',
  }[profile.id], signatureGeometry(profile.id), materials.accent, signature);
  if(profile.id === 'nyx') signatureMesh.position.set(0, -0.005, -0.015);
  return signature;
}

function resolveProfile(profileOrId, paint, hero){
  const id = typeof profileOrId === 'string' ? profileOrId : profileOrId?.id;
  const source = PROFILE_DEFS[id] || (hero ? PROFILE_DEFS.player : PROFILE_DEFS.volt);
  if(!Number.isFinite(paint) || paint === source.accent) return source;
  return Object.freeze({ ...source, accent: paint });
}

const tetherScratchByRig = new WeakMap();
function createTetherScratch(attribute){
  return {
    eyeWorld: new THREE.Vector3(), targetWorld: new THREE.Vector3(),
    inverseRoot: new THREE.Matrix4(), attribute, array: attribute.array,
    attributeIdentity: attribute, arrayIdentity: attribute.array,
    updates: 0, skipped: 0, scratchStable: true, attributeStable: true, arrayStable: true,
  };
}

/** Backward compatible first two arguments; the third selects a real profile. */
export function buildCourier(paint = 0x38E4F5, hero = true, profileOrId = hero ? 'player' : 'volt'){
  const profile = resolveProfile(profileOrId, paint, hero);
  const materials = materialsFor(profile);
  const group = new THREE.Group();
  group.name = `courier:${profile.id}`;
  const root = new THREE.Group();
  root.name = 'rigRoot';
  group.add(root);

  const joints = {};
  const pelvis = joint('pelvis', root, 0, 0, 0);
  joints.pelvis = pelvis;
  const spine = joint('spine', pelvis, 0, 0.115, 0);
  joints.spine = spine;
  const chest = joint('chest', spine, 0, 0.015, 0);
  joints.chest = chest;

  const torsoCore = mesh('torsoCore', torsoCoreGeometry(), materials.fabric, chest);
  torsoCore.scale.set(profile.shoulder * 0.94, profile.torso, profile.depth);
  const torso = mesh('torsoShell', torsoShellGeometry(), materials.shell, chest);
  torso.scale.set(profile.shoulder, profile.torso, profile.depth);

  const backPlate = mesh('backArmor', backPlateGeometry(), materials.pack, chest, new THREE.Vector3(0, 0.34, -0.158 * profile.depth));
  backPlate.scale.set(profile.shoulder, profile.torso, 1);
  const backStripe = mesh('backArmorStripe', cachedGeometry('back-armor-stripe', () => new THREE.BoxGeometry(0.065, 0.29, 0.018)),
    materials.accent, chest, new THREE.Vector3(0, 0.34, -0.195 * profile.depth));
  const pelvisArmor = mesh('pelvisArmor', pelvisArmorGeometry(), materials.fabric, pelvis, new THREE.Vector3(0, 0.055, 0));
  pelvisArmor.scale.set(profile.id === 'jet' ? 1.12 : 1, 1, profile.depth);
  const belt = mesh('courierBelt', cachedGeometry('courier-belt', () => new THREE.CylinderGeometry(0.225, 0.225, 0.055, 8)),
    materials.accent, pelvis, new THREE.Vector3(0, 0.155, 0));
  belt.scale.set(profile.id === 'jet' ? 1.10 : 1, 1, profile.depth);

  for(const sign of [-1, 1]){
    const shoulderGuard = mesh(sign < 0 ? 'leftShoulderGuard' : 'rightShoulderGuard',
      cachedGeometry('shoulder-guard', () => {
        const geometry = new THREE.SphereGeometry(0.13, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.62);
        geometry.scale(1.15, 0.72, 1.0);
        return smooth(geometry);
      }), materials.shell, chest,
      new THREE.Vector3(sign * 0.315 * profile.shoulder, 0.515 * profile.torso, -0.005));
    shoulderGuard.rotation.z = sign * -0.12;
  }

  const neck = joint('neck', chest, 0, 0.665 * profile.torso, 0);
  joints.neck = neck;
  const head = joint('head', neck, 0, 0.135 * profile.stature, 0);
  joints.head = head;
  const helmet = mesh('helmetShell', cachedGeometry('courier-helmet', () => {
    const geometry = new THREE.CapsuleGeometry(0.128, 0.082, 4, 10);
    geometry.scale(0.92, 1, 1.02);
    return geometry;
  }), materials.shell, head);
  helmet.scale.set(profile.id === 'jet' ? 1.04 : profile.id === 'nyx' ? 0.94 : 1, 1, profile.depth);
  const visor = mesh('visor', cachedGeometry('courier-face-visor', () => {
    const shape = new THREE.Shape();
    shape.moveTo(-0.12, -0.045);
    shape.lineTo(0.12, -0.045);
    shape.lineTo(0.105, 0.052);
    shape.lineTo(0.07, 0.075);
    shape.lineTo(-0.07, 0.075);
    shape.lineTo(-0.105, 0.052);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.022, bevelEnabled: false });
    geometry.translate(0, 0, -0.011);
    return geometry;
  }), materials.visor, head, new THREE.Vector3(0, -0.005, 0.127));
  visor.scale.copy(helmet.scale);
  const visorBrow = mesh('visorBrow', cachedGeometry('visor-brow', () => new THREE.BoxGeometry(0.19, 0.018, 0.016)),
    materials.accent, head, new THREE.Vector3(0, 0.043, 0.145));
  visorBrow.scale.x = helmet.scale.x;
  const helmetRearBand = mesh('helmetRearBand', cachedGeometry('helmet-rear-band', () => new THREE.BoxGeometry(0.19, 0.075, 0.022)),
    materials.fabric, head, new THREE.Vector3(0, -0.015, -0.132 * profile.depth));
  helmetRearBand.scale.x = helmet.scale.x;
  const helmetBeacon = mesh('helmetBeacon', cachedGeometry('helmet-beacon', () => new THREE.BoxGeometry(0.048, 0.048, 0.018)),
    materials.accent, head, new THREE.Vector3(0, 0.025, -0.149 * profile.depth));

  buildArm('left', chest, profile, materials, joints);
  buildArm('right', chest, profile, materials, joints);
  const leftLegLength = buildLeg('left', pelvis, profile, materials, joints);
  buildLeg('right', pelvis, profile, materials, joints);
  const standingRootY = leftLegLength + 0.095;

  const parcel = new THREE.Group();
  parcel.name = 'asymmetricParcel';
  parcel.position.set(profile.parcelSide * (profile.id === 'nyx' ? 0.16 : 0.11), profile.parcelY, -0.235 * profile.depth);
  parcel.rotation.z = profile.parcelSide * (profile.id === 'nyx' ? -0.16 : -0.045);
  chest.add(parcel);
  const parcelCase = mesh('parcelCase', parcelGeometry(), materials.pack, parcel);
  parcelCase.scale.set(profile.parcelScale[0], profile.parcelScale[1], profile.depth);
  const parcelPanel = mesh('parcelPanel', cachedGeometry('parcel-panel', () => new THREE.BoxGeometry(0.19, 0.17, 0.025)),
    materials.accent, parcel, new THREE.Vector3(0, 0.015, -0.086 * profile.depth));
  parcelPanel.scale.set(profile.parcelScale[0], profile.parcelScale[1], 1);
  const parcelLatch = mesh('parcelLatch', cachedGeometry('parcel-latch', () => new THREE.BoxGeometry(0.085, 0.035, 0.02)),
    materials.shell, parcel, new THREE.Vector3(0, -0.115 * profile.parcelScale[1], -0.104 * profile.depth));
  const parcelEye = joint('parcelEye', parcel, profile.parcelSide * 0.065, 0.20 * profile.parcelScale[1], -0.012);

  const tetherGeometry = new THREE.BufferGeometry();
  const tetherAttribute = new THREE.BufferAttribute(new Float32Array(6), 3);
  tetherGeometry.setAttribute('position', tetherAttribute);
  const tether = new THREE.Line(tetherGeometry, commonTetherMaterial);
  tether.name = 'parcelTether';
  tether.frustumCulled = false;
  tether.visible = false;
  root.add(tether);
  tetherScratchByRig.set(group, createTetherScratch(tetherAttribute));

  const signature = addProfileSilhouette(root, chest, head, parcel, profile, materials);
  const jointNames = Object.keys(joints);
  group.userData = {
    root, pelvis, spine, chest, head, helmet, visor, visorBrow, helmetRearBand, helmetBeacon,
    torso, torsoCore, backPlate, backStripe, pelvisArmor, belt,
    parcel, parcelCase, parcelPanel, parcelLatch, parcelEye, tether,
    signature, joints, jointNames, materials, profile, standingRootY,
    resetJointNames: RESET_JOINT_NAMES,
    profileId: profile.id, callSign: profile.callSign, silhouette: profile.silhouette,
    cadence: profile.cadence, deterministicPose: true, tetherFromParcelEye: true,
  };
  if(hero){
    const shadowNames = /^(torsoShell|backArmor|pelvisArmor|helmetShell|leftShoulderGuard|rightShoulderGuard|leftUpperArm|rightUpperArm|leftForearm|rightForearm|leftThigh|rightThigh|leftShin|rightShin|leftFoot|rightFoot|parcelCase)$/;
    group.traverse(object => { if(object.isMesh) object.castShadow = shadowNames.test(object.name); });
  }
  poseCourier(group, 'crouch', 0, 0, 0);
  return group;
}

/** Update only a visible hero tether. target may be a world-space Vector3 or Object3D. */
export function updateCourierTether(group, target = null){
  const user = group?.userData;
  const scratch = tetherScratchByRig.get(group);
  if(!user?.tether || !scratch || !user.tether.visible){
    if(scratch) scratch.skipped += 1;
    return false;
  }
  group.updateWorldMatrix(true, true);
  scratch.eyeWorld.setFromMatrixPosition(user.parcelEye.matrixWorld);
  if(target?.isObject3D){
    target.updateWorldMatrix(true, false);
    scratch.targetWorld.setFromMatrixPosition(target.matrixWorld);
  } else if(target?.isVector3){
    scratch.targetWorld.copy(target);
  } else {
    scratch.targetWorld.setFromMatrixPosition(user.joints.rightHand.matrixWorld);
  }
  scratch.inverseRoot.copy(user.root.matrixWorld).invert();
  scratch.eyeWorld.applyMatrix4(scratch.inverseRoot);
  scratch.targetWorld.applyMatrix4(scratch.inverseRoot);
  const attribute = user.tether.geometry.getAttribute('position');
  const array = attribute.array;
  array[0] = scratch.eyeWorld.x;
  array[1] = scratch.eyeWorld.y;
  array[2] = scratch.eyeWorld.z;
  array[3] = scratch.targetWorld.x;
  array[4] = scratch.targetWorld.y;
  array[5] = scratch.targetWorld.z;
  attribute.needsUpdate = true;
  scratch.attributeStable = scratch.attributeStable && attribute === scratch.attributeIdentity;
  scratch.arrayStable = scratch.arrayStable && array === scratch.arrayIdentity;
  scratch.scratchStable = scratch.scratchStable && tetherScratchByRig.get(group) === scratch;
  scratch.updates += 1;
  return true;
}

function resetJoints(user){
  user.root.rotation.set(0, 0, 0);
  user.pelvis.rotation.set(0, 0, 0);
  user.spine.rotation.set(0, 0, 0);
  user.chest.rotation.set(0, 0, 0);
  user.head.rotation.set(0, 0, 0);
  for(let index = 0; index < RESET_JOINT_NAMES.length; index += 1){
    user.joints[RESET_JOINT_NAMES[index]].rotation.set(0, 0, 0);
  }
}

function setArmPose(user, leftShoulder, rightShoulder, leftElbow, rightElbow, leftZ = 0, rightZ = 0){
  user.joints.leftShoulder.rotation.x = leftShoulder;
  user.joints.rightShoulder.rotation.x = rightShoulder;
  user.joints.leftShoulder.rotation.z = leftZ;
  user.joints.rightShoulder.rotation.z = rightZ;
  user.joints.leftElbow.rotation.x = leftElbow;
  user.joints.rightElbow.rotation.x = rightElbow;
}

function setLegPose(user, leftHip, rightHip, leftKnee, rightKnee, leftAnkle = 0, rightAnkle = leftAnkle){
  user.joints.leftHip.rotation.x = leftHip;
  user.joints.rightHip.rotation.x = rightHip;
  user.joints.leftKnee.rotation.x = leftKnee;
  user.joints.rightKnee.rotation.x = rightKnee;
  user.joints.leftAnkle.rotation.x = leftAnkle;
  user.joints.rightAnkle.rotation.x = rightAnkle;
}

function readyPose(user, profile){
  user.root.position.y = user.standingRootY - (profile.id === 'nyx' ? 0.08 : 0.06);
  user.root.rotation.x = profile.id === 'nyx' ? 0.25 : profile.id === 'volt' ? 0.20 : 0.15;
  user.root.rotation.z = profile.id === 'jet' ? -0.03 : profile.id === 'nyx' ? 0.08 : 0;
  user.pelvis.rotation.x = -0.08;
  if(profile.id === 'volt'){
    setLegPose(user, 0.66, -0.28, -0.92, -0.62, 0.17, -0.04);
    setArmPose(user, 0.52, -0.88, -0.62, -0.80, -0.05, 0.08);
  } else if(profile.id === 'nyx'){
    setLegPose(user, 0.38, -0.50, -1.04, -0.74, 0.22, 0.08);
    setArmPose(user, 0.10, -0.62, -1.10, -0.64, 0.14, -0.18);
    user.spine.rotation.y = -0.16;
  } else if(profile.id === 'jet'){
    setLegPose(user, 0.46, -0.26, -0.78, -0.72, 0.08, 0.02);
    setArmPose(user, 0.26, -0.42, -1.04, -1.04, 0.34, -0.34);
  } else {
    setLegPose(user, 0.52, -0.36, -0.88, -0.76, 0.12, 0.04);
    setArmPose(user, 0.34, -0.54, -0.72, -0.82, 0.05, -0.05);
  }
}

/* Absolute poses make identical simulation snapshots render identically.
   dt remains in the signature for the Phase 3 caller contract. */
export function poseCourier(group, state, phase, speed, _dt){
  const user = group.userData;
  const profile = user.profile || PROFILE_DEFS.player;
  const cycle = phase * profile.cadence;
  const stride = Math.min(1.02, (0.38 + Math.max(0, speed) * 0.033) * profile.stride);
  user.currentPose = state;
  user.posePhase = phase;
  resetJoints(user);
  user.root.position.x = 0;
  user.root.position.z = 0;

  if(state === 'run'){
    const swing = Math.sin(cycle);
    const leftPlant = Math.max(0, -swing);
    const rightPlant = Math.max(0, swing);
    user.root.position.y = user.standingRootY + Math.abs(Math.sin(cycle * 2)) * 0.032;
    user.root.rotation.x = (profile.id === 'nyx' ? 0.18 : 0.11) + Math.min(0.075, speed * 0.0035);
    user.root.rotation.z = swing * (profile.id === 'jet' ? 0.018 : 0.028);
    user.pelvis.rotation.y = swing * 0.08;
    user.spine.rotation.y = -swing * (profile.id === 'volt' ? 0.12 : 0.09);
    setLegPose(user,
      swing * stride, -swing * stride,
      -0.10 - leftPlant * 0.76, -0.10 - rightPlant * 0.76,
      -0.12 + leftPlant * 0.22, -0.12 + rightPlant * 0.22);
    setArmPose(user,
      -swing * stride * 0.80, swing * stride * 0.80,
      -0.50 - Math.max(0, swing) * 0.32, -0.50 - Math.max(0, -swing) * 0.32,
      profile.id === 'jet' ? 0.12 : 0.02, profile.id === 'jet' ? -0.12 : -0.02);
    user.head.rotation.y = -swing * 0.04;
  } else if(state === 'air'){
    user.root.position.y = user.standingRootY;
    user.root.rotation.x = 0.23;
    user.spine.rotation.x = -0.11;
    setLegPose(user, 0.82, -0.28, -1.05, -0.62, 0.22, -0.08);
    setArmPose(user, -1.20, -1.36, -0.36, -0.28, 0.06, -0.06);
  } else if(state === 'slide'){
    user.root.position.y = 0.71 * profile.limb + 0.015;
    user.root.rotation.x = 0.98;
    user.root.rotation.z = -0.075;
    user.spine.rotation.x = 0.16;
    user.head.rotation.x = -0.31;
    user.head.rotation.y = -0.10;
    setLegPose(user, -1.80, 1.08, 0.12, -0.68, -0.50, 0.08);
    setArmPose(user, 0.74, -0.86, -0.92, -0.58, 0.14, -0.08);
  } else if(state === 'stumble'){
    user.root.position.y = user.standingRootY + 0.02;
    user.root.rotation.x = 0.38;
    user.root.rotation.z = -0.24;
    user.spine.rotation.z = 0.16;
    user.head.rotation.x = -0.18;
    setLegPose(user, 0.94, -0.12, -0.74, -0.28, 0.26, -0.18);
    setArmPose(user, -0.72, 0.92, -0.30, -0.48, 0.72, -0.62);
  } else if(state === 'recover'){
    user.root.position.y = user.standingRootY - 0.06;
    user.root.rotation.x = 0.29;
    user.root.rotation.z = 0.10;
    user.spine.rotation.y = 0.24;
    user.head.rotation.y = 0.28;
    setLegPose(user, 0.62, -0.42, -1.02, -0.74, 0.22, 0.06);
    setArmPose(user, -0.46, 1.08, -0.72, -0.38, 0.18, -0.22);
  } else if(state === 'win'){
    user.root.position.y = user.standingRootY;
    user.root.rotation.x = -0.035;
    user.spine.rotation.z = -0.06;
    user.head.rotation.y = 0.18;
    setLegPose(user, -0.08, 0.18, -0.12, -0.42, 0.02, 0.12);
    setArmPose(user, -2.66, -1.95, -0.34, -0.72, 0.18, -0.28);
  } else if(state === 'fail'){
    user.root.position.y = user.standingRootY;
    user.root.position.x = profile.id === 'player' ? -0.78
      : profile.id === 'jet' ? 0.72 : profile.id === 'volt' ? 0.34 : 0;
    user.root.rotation.x = 0.25;
    user.spine.rotation.x = 0.18;
    user.head.rotation.x = 0.42;
    setLegPose(user, 0.22, -0.18, -0.62, -0.52, 0.12, 0.08);
    setArmPose(user, 0.24, -0.18, -0.22, -0.24, 0.12, -0.12);
  } else {
    readyPose(user, profile);
  }
  return group;
}

export function courierHotPathReport(groups){
  const rows = groups.map(group => {
    const scratch = tetherScratchByRig.get(group);
    return {
      profileId: group?.userData?.profileId || null,
      updates: scratch?.updates || 0,
      skipped: scratch?.skipped || 0,
      scratchStable: Boolean(scratch?.scratchStable),
      attributeStable: Boolean(scratch?.attributeStable),
      arrayStable: Boolean(scratch?.arrayStable),
      resetJointNamesStable: group?.userData?.resetJointNames === RESET_JOINT_NAMES,
    };
  });
  return {
    rows,
    updates: rows.reduce((sum, row) => sum + row.updates, 0),
    skipped: rows.reduce((sum, row) => sum + row.skipped, 0),
    identitiesStable: rows.every(row => row.scratchStable && row.attributeStable
      && row.arrayStable && row.resetJointNamesStable),
  };
}

export function courierSemanticReport(group){
  const user = group?.userData || {};
  const required = [
    'leftShoulder', 'leftElbow', 'leftWrist', 'leftHip', 'leftKnee', 'leftAnkle',
    'rightShoulder', 'rightElbow', 'rightWrist', 'rightHip', 'rightKnee', 'rightAnkle',
  ];
  return {
    profileId: user.profileId,
    callSign: user.callSign,
    silhouette: user.silhouette,
    cadence: user.cadence,
    deterministicPose: Boolean(user.deterministicPose),
    currentPose: user.currentPose || null,
    asymmetricParcel: user.parcel?.name === 'asymmetricParcel' && Math.abs(user.parcel.position.x) > 0.1,
    tetherFromParcelEye: Boolean(user.tetherFromParcelEye && user.parcelEye && user.tether),
    namedBilateralJoints: required.every(name => user.joints?.[name]?.name === name),
    layeredAthleticShell: Boolean(user.torso && user.torsoCore && user.torso.geometry !== user.torsoCore.geometry),
    readableFace: Boolean(user.visor && user.visorBrow && user.helmetRearBand && user.helmetBeacon),
    athleticSilhouette: Boolean(user.backPlate && user.pelvisArmor && user.belt
      && user.joints?.leftShoulder && user.joints?.rightShoulder),
    compactCourierPack: Boolean(user.parcelCase && user.parcelPanel && user.parcelLatch
      && Math.abs(user.parcel.position.x) <= 0.17),
    jointNames: [...(user.jointNames || [])],
    signatureName: user.signature?.name || null,
  };
}

export const COURIER_PROFILES = PROFILE_DEFS;
