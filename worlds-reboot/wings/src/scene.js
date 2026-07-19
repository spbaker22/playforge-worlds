/* PAPER WINGS - procedural alpine world and folded glider family. */
import * as THREE from 'three';
import { raceStanding, rivalProgress, routePointAtS, WING_RIVALS } from './route.js';
import { getMissionDressing, MISSION_IDS } from './mission-dressing.js';
import { createBoundedPool } from './scene-pools.js';

const tempPoint = { x: 0, y: 33 };
const presentationPoint = { x: 0, y: 33 };
const dummy = new THREE.Object3D();
const DARK_INK = 0x15292e;
const EMPTY_LIST = Object.freeze([]);
const EMPTY_OBJECT = Object.freeze({});

export const PRESENTATION_POOL_BUDGETS = Object.freeze({
  full: Object.freeze({
    targets: 24, projectiles: 48, hazards: 24, rescue: 16, trails: 32, impacts: 24,
    thermals: 16, windRibbons: 40, routeForks: 24,
  }),
  lowfx: Object.freeze({
    targets: 12, projectiles: 20, hazards: 12, rescue: 8, trails: 16, impacts: 10,
    thermals: 8, windRibbons: 18, routeForks: 12,
  }),
});

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function seeded(seed = 1){
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function meshGeometry(positions, indices){
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addHeroInkSilhouette(group, geometry, name){
  const underside = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: DARK_INK,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  }));
  underside.name = `paper-wings-${name}-underside`;
  underside.position.y = -0.075;
  underside.scale.set(1.045, 1, 1.045);
  underside.castShadow = true;
  group.add(underside);
}

function foldedWingGeometry(style){
  if(style === 'delta'){
    return meshGeometry([
      0, 0.18, -5.5, -5.7, 0, 2.5, 0, 0.55, 1.1,
      0, 0.18, -5.5, 0, 0.55, 1.1, 5.7, 0, 2.5,
    ], [0, 1, 2, 3, 4, 5]);
  }
  if(style === 'swept'){
    return meshGeometry([
      0, 0.22, -5.8, -5.4, 0, 1.8, -0.2, 0.48, 0.7,
      0, 0.22, -5.8, 0.2, 0.48, 0.7, 5.4, 0, 1.8,
    ], [0, 1, 2, 3, 4, 5]);
  }
  return meshGeometry([
    0, 0.28, -5.9, -6.2, 0, 2.7, -0.18, 0.7, 1.15,
    0, 0.28, -5.9, 0.18, 0.7, 1.15, 6.2, 0, 2.7,
  ], [0, 1, 2, 3, 4, 5]);
}

function addFold(group, color){
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.02 });
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.22, 7.3), material);
  spine.name = 'paper-wings-fold-spine';
  spine.position.set(0, 0.28, -1.0);
  spine.rotation.x = 0.015;
  group.add(spine);
  return material;
}

export function buildPaperGlider(color = 0xf5efe2, style = 'paper', hero = false){
  const group = new THREE.Group();
  group.name = hero ? 'paper-wings-player' : `paper-wings-${style}`;
  const wingMaterial = new THREE.MeshStandardMaterial({
    color,
    roughness: hero ? 0.74 : 0.58,
    metalness: hero ? 0.01 : 0.08,
    side: THREE.DoubleSide,
    emissive: hero ? 0x22130f : 0x000000,
    emissiveIntensity: hero ? 0.14 : 0,
  });
  const wing = new THREE.Mesh(foldedWingGeometry(style), wingMaterial);
  wing.castShadow = true;
  group.add(wing);
  if(hero) addHeroInkSilhouette(group, wing.geometry, 'wing');
  const foldMaterial = addFold(group, hero ? DARK_INK : color);

  if(style === 'biplane'){
    const top = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.18, 1.0), wingMaterial);
    top.position.set(0, 1.2, 0.5);
    const lower = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.16, 0.9), wingMaterial);
    lower.position.set(0, -0.35, 0.7);
    group.add(top, lower);
    for(const x of [-2.8, 2.8]){
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.6, 0.12), foldMaterial);
      strut.position.set(x, 0.42, 0.55);
      group.add(strut);
    }
  }

  if(style === 'delta'){
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.42, 2.4, 3), foldMaterial);
    fin.position.set(0, 0.8, 1.3);
    fin.rotation.z = Math.PI / 2;
    group.add(fin);
  } else {
    const tailMaterial = new THREE.MeshStandardMaterial({ color: hero ? 0xf1dfcc : color, roughness: 0.68, side: THREE.DoubleSide });
    const tailGeometry = meshGeometry([
      0, 0.25, 0.4, -2.3, 0.08, 3.4, 0, 0.5, 2.4,
      0, 0.25, 0.4, 0, 0.5, 2.4, 2.3, 0.08, 3.4,
    ], [0, 1, 2, 3, 4, 5]);
    const tail = new THREE.Mesh(tailGeometry, tailMaterial);
    tail.castShadow = true;
    group.add(tail);
    if(hero) addHeroInkSilhouette(group, tailGeometry, 'tail');
  }

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.7, 5), foldMaterial);
  nose.name = 'paper-wings-fold-nose';
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 0.16, -5.5);
  group.add(nose);
  group.scale.setScalar(hero ? 0.72 : 0.60);
  group.userData.style = style;
  group.userData.wing = wing;
  return group;
}

function terrainHeight(x, s){
  const wall = Math.max(0, Math.abs(x) - 34) * 0.37;
  const ridge = Math.max(0, Math.abs(x) - 96) * 0.23;
  const detail = Math.sin(x * 0.055 + s * 0.014) * 3.2 + Math.sin(s * 0.031 - x * 0.022) * 2.0;
  return 2.5 + wall + ridge + detail;
}

function buildTerrain(scene, route, lowfx){
  const xSegments = lowfx ? 26 : 42;
  const sSegments = lowfx ? 58 : 92;
  const width = 440;
  const length = route.finishS + 420;
  const positions = [];
  const colors = [];
  const indices = [];
  const rock = new THREE.Color(0x53696d);
  const pine = new THREE.Color(0x345557);
  const snow = new THREE.Color(0xe9f1ed);
  const color = new THREE.Color();
  for(let row = 0; row <= sSegments; row += 1){
    const s = -80 + row / sSegments * length;
    for(let column = 0; column <= xSegments; column += 1){
      const x = -width / 2 + column / xSegments * width;
      const y = terrainHeight(x, s);
      positions.push(x, y, -s);
      const snowMix = THREE.MathUtils.smoothstep(y, 35, 65);
      const pineMix = THREE.MathUtils.smoothstep(y, 5, 28) * (1 - snowMix);
      color.copy(rock).lerp(pine, pineMix * 0.72).lerp(snow, snowMix * 0.92);
      colors.push(color.r, color.g, color.b);
    }
  }
  const stride = xSegments + 1;
  for(let row = 0; row < sSegments; row += 1){
    for(let column = 0; column < xSegments; column += 1){
      const a = row * stride + column;
      indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
    }
  }
  const geometry = meshGeometry(positions, indices);
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.0,
  }));
  terrain.receiveShadow = true;
  scene.add(terrain);

  const riverPositions = [];
  const riverIndices = [];
  const riverSteps = lowfx ? 60 : 100;
  for(let i = 0; i <= riverSteps; i += 1){
    const s = -40 + i / riverSteps * (route.finishS + 260);
    const x = Math.sin(s * 0.018) * 9 + Math.sin(s * 0.005) * 4;
    riverPositions.push(x - 5.5, 3.05, -s, x + 5.5, 3.05, -s);
    if(i < riverSteps){
      const k = i * 2;
      riverIndices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const river = new THREE.Mesh(meshGeometry(riverPositions, riverIndices), new THREE.MeshStandardMaterial({
    color: 0x5a9da8,
    roughness: 0.22,
    metalness: 0.18,
    emissive: 0x183e48,
    emissiveIntensity: 0.18,
    side: THREE.DoubleSide,
  }));
  scene.add(river);
}

function buildForest(scene, route, lowfx){
  const count = lowfx ? 90 : 180;
  const random = seeded(9173);
  const tree = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.8, 6.5, 6),
    new THREE.MeshStandardMaterial({ color: 0x214c47, roughness: 0.96 }),
    count,
  );
  tree.castShadow = !lowfx;
  tree.receiveShadow = true;
  for(let i = 0; i < count; i += 1){
    const side = random() < 0.5 ? -1 : 1;
    const x = side * (48 + random() * 88);
    const s = random() * (route.finishS + 180) - 30;
    const scale = 0.72 + random() * 1.5;
    dummy.position.set(x, terrainHeight(x, s) + 2.8 * scale, -s);
    dummy.rotation.set(0, random() * Math.PI, 0);
    dummy.scale.set(scale, scale, scale);
    dummy.updateMatrix();
    tree.setMatrixAt(i, dummy.matrix);
  }
  tree.instanceMatrix.needsUpdate = true;
  scene.add(tree);
}

function buildClouds(scene, lowfx){
  const random = seeded(441);
  const material = new THREE.MeshBasicMaterial({
    color: 0xf1f5f1,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    fog: true,
  });
  const geometry = new THREE.SphereGeometry(1, lowfx ? 8 : 12, lowfx ? 5 : 7);
  const cloudCount = lowfx ? 4 : 8;
  const clouds = [];
  for(let c = 0; c < cloudCount; c += 1){
    const cloud = new THREE.Group();
    const lumps = lowfx ? 3 : 5;
    for(let i = 0; i < lumps; i += 1){
      const lump = new THREE.Mesh(geometry, material);
      lump.position.set((i - lumps / 2) * 5 + random() * 3, random() * 2, random() * 3);
      lump.scale.set(6 + random() * 5, 2.0 + random() * 2, 3.5 + random() * 4);
      cloud.add(lump);
    }
    cloud.position.set((random() - 0.5) * 240, 60 + random() * 28, -80 - random() * 720);
    cloud.userData.speed = 0.3 + random() * 0.5;
    scene.add(cloud);
    clouds.push(cloud);
  }
  return clouds;
}

function buildGate(scene, gate, index){
  const group = new THREE.Group();
  group.position.set(gate.x, gate.y, -gate.s);
  const rimMaterial = new THREE.MeshStandardMaterial({
    color: DARK_INK,
    emissive: 0x081416,
    emissiveIntensity: 0.34,
    roughness: 0.62,
    metalness: 0.06,
  });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(gate.radius, 0.68, 10, 48), rimMaterial);
  rim.position.z = -0.72;
  const material = new THREE.MeshStandardMaterial({
    color: 0xff795c,
    emissive: 0xb83226,
    emissiveIntensity: 0.95,
    roughness: 0.3,
    metalness: 0.35,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(gate.radius, 0.44, 8, 48), material);
  ring.position.z = 0.12;
  group.add(rim, ring);
  const vaneMaterial = new THREE.MeshStandardMaterial({ color: 0xf6eee2, emissive: 0x3a2119, emissiveIntensity: 0.2 });
  for(let i = 0; i < 4; i += 1){
    const angle = i * Math.PI / 2;
    const vane = new THREE.Mesh(new THREE.BoxGeometry(0.42, 2.1, 0.42), vaneMaterial);
    vane.position.set(Math.cos(angle) * (gate.radius + 1.25), Math.sin(angle) * (gate.radius + 1.25), 0);
    vane.rotation.z = angle;
    group.add(vane);
  }
  group.userData = { gate, index, material, ring, rim, rimMaterial, baseRadius: gate.radius };
  scene.add(group);
  return group;
}

function buildFinish(scene, route){
  const point = routePointAtS(route, route.finishS);
  const group = new THREE.Group();
  group.position.set(point.x, point.y - 7.5, -route.finishS);
  const pale = new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.72 });
  const coral = new THREE.MeshStandardMaterial({ color: 0xff795c, emissive: 0x8f281f, emissiveIntensity: 0.55 });
  for(const x of [-9, 9]){
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 15, 0.7), pale);
    post.position.x = x;
    post.castShadow = true;
    group.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(18.7, 0.85, 0.85), coral);
  beam.position.y = 7.2;
  group.add(beam);
  const pennant = new THREE.Mesh(new THREE.ConeGeometry(1.2, 3.5, 3), pale);
  pennant.rotation.z = Math.PI / 2;
  pennant.position.y = 9.2;
  group.add(pennant);
  scene.add(group);
  return group;
}

function createLighting(scene, lowfx){
  scene.background = new THREE.Color(0x91b5c2);
  scene.fog = new THREE.FogExp2(0xa7c0c5, lowfx ? 0.0025 : 0.0021);
  const hemi = new THREE.HemisphereLight(0xc9edf1, 0x40504b, 2.25);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe3bd, 3.3);
  sun.position.set(-120, 180, 100);
  sun.castShadow = !lowfx;
  sun.shadow.mapSize.set(lowfx ? 512 : 1024, lowfx ? 512 : 1024);
  sun.shadow.camera.left = -48;
  sun.shadow.camera.right = 48;
  sun.shadow.camera.top = 48;
  sun.shadow.camera.bottom = -48;
  sun.shadow.camera.near = 50;
  sun.shadow.camera.far = 500;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0x718fa9, 0.65);
  fill.position.set(120, 40, -160);
  scene.add(fill);
  return Object.freeze({ sun, hemi, fill });
}

function worldPositionFromEntity(route, entity, out){
  const s = finite(entity?.s, finite(entity?.distance, 0));
  routePointAtS(route, s, presentationPoint, entity?.routeState || null);
  out.set(
    Number.isFinite(entity?.worldX) ? entity.worldX
      : Number.isFinite(entity?.x) ? entity.x
        : presentationPoint.x + finite(entity?.lateral, 0),
    Number.isFinite(entity?.worldY) ? entity.worldY
      : Number.isFinite(entity?.y) ? entity.y
        : presentationPoint.y + finite(entity?.altitude, 0),
    -s,
  );
  return out;
}

function makeTargetView(index){
  const group = new THREE.Group();
  group.name = `paper-wings-target-${index}`;
  const ink = new THREE.Mesh(
    new THREE.OctahedronGeometry(2.15, 0),
    new THREE.MeshStandardMaterial({ color: DARK_INK, roughness: 0.82, metalness: 0.02 }),
  );
  const paper = new THREE.Mesh(
    new THREE.OctahedronGeometry(1.72, 0),
    new THREE.MeshStandardMaterial({ color: 0xf2ece0, emissive: 0x6f261f, emissiveIntensity: 0.18, roughness: 0.6 }),
  );
  const lock = new THREE.Mesh(
    new THREE.TorusGeometry(2.8, 0.13, 6, 24),
    new THREE.MeshBasicMaterial({ color: 0xff795c, transparent: true, opacity: 0.9 }),
  );
  lock.position.z = 0.1;
  group.add(ink, paper, lock);
  group.userData.paper = paper;
  group.userData.lock = lock;
  return group;
}

function makeProjectileView(index){
  const projectile = new THREE.Mesh(
    new THREE.ConeGeometry(0.28, 2.2, 4),
    new THREE.MeshStandardMaterial({
      color: 0xffd4a8, emissive: 0xff795c, emissiveIntensity: 1.1, roughness: 0.35,
    }),
  );
  projectile.name = `paper-wings-projectile-${index}`;
  projectile.rotation.x = -Math.PI / 2;
  return projectile;
}

function makeHazardView(index){
  const group = new THREE.Group();
  group.name = `paper-wings-hazard-${index}`;
  const debris = new THREE.Mesh(
    new THREE.TetrahedronGeometry(1.35, 0),
    new THREE.MeshStandardMaterial({ color: 0x33484d, emissive: 0x101f24, emissiveIntensity: 0.3, roughness: 0.88 }),
  );
  const lightning = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.34, 10, 4, 1),
    new THREE.MeshBasicMaterial({ color: 0xffe4a3, transparent: true, opacity: 0.95 }),
  );
  lightning.rotation.z = 0.16;
  const downdraft = new THREE.Mesh(
    new THREE.TorusGeometry(3.2, 0.22, 6, 30),
    new THREE.MeshBasicMaterial({ color: 0x8bc6d0, transparent: true, opacity: 0.62 }),
  );
  downdraft.rotation.x = Math.PI / 2;
  group.add(debris, lightning, downdraft);
  group.userData.debris = debris;
  group.userData.lightning = lightning;
  group.userData.downdraft = downdraft;
  return group;
}

function makeRescueView(index){
  const group = new THREE.Group();
  group.name = `paper-wings-rescue-${index}`;
  const pickup = new THREE.Group();
  const balloon = new THREE.Mesh(
    new THREE.SphereGeometry(1.45, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xff795c, emissive: 0x7a241d, emissiveIntensity: 0.52, roughness: 0.62 }),
  );
  const string = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 3.6, 4),
    new THREE.MeshBasicMaterial({ color: DARK_INK }),
  );
  string.position.y = -2.2;
  pickup.add(balloon, string);
  const dropZone = new THREE.Mesh(
    new THREE.TorusGeometry(4.3, 0.34, 8, 36),
    new THREE.MeshStandardMaterial({ color: 0xffb75f, emissive: 0xff795c, emissiveIntensity: 0.72, roughness: 0.5 }),
  );
  dropZone.rotation.x = Math.PI / 2;
  const parcel = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 1.1, 1.4),
    new THREE.MeshStandardMaterial({ color: 0xf1dfc8, emissive: 0x51332a, emissiveIntensity: 0.16, roughness: 0.85 }),
  );
  group.add(pickup, dropZone, parcel);
  group.userData.pickup = pickup;
  group.userData.dropZone = dropZone;
  group.userData.parcel = parcel;
  return group;
}

function makeTrailView(index){
  const trail = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.06, 4.8),
    new THREE.MeshBasicMaterial({ color: 0xffbc68, transparent: true, opacity: 0.62, depthWrite: false }),
  );
  trail.name = `paper-wings-stunt-trail-${index}`;
  return trail;
}

function makeImpactView(index){
  const group = new THREE.Group();
  group.name = `paper-wings-impact-${index}`;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.1, 0.18, 5, 18),
    new THREE.MeshBasicMaterial({ color: 0xffd07a, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  const shard = new THREE.Mesh(
    new THREE.TetrahedronGeometry(0.7, 0),
    new THREE.MeshBasicMaterial({ color: 0xff795c, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  shard.position.x = 1.3;
  group.add(ring, shard);
  group.userData.ring = ring;
  group.userData.shard = shard;
  return group;
}

function createViewBank(scene, name, capacity, makeView){
  const root = new THREE.Group();
  root.name = `paper-wings-${name}-pool`;
  scene.add(root);
  const byId = new Map();
  const fallbackIds = new Array(capacity);
  const stale = new Int32Array(capacity);
  const bank = {
    name, root, byId, fallbackIds, stale, staleCount: 0, serial: 0, dropped: 0, recycleCursor: 0,
    pool: null, collectStale: null,
  };
  for(let index = 0; index < capacity; index += 1) fallbackIds[index] = `${name}-${index}`;
  bank.pool = createBoundedPool({
    capacity,
    create(index){
      const view = makeView(index);
      view.visible = false;
      view.userData.presentationId = null;
      view.userData.presentationSeen = 0;
      root.add(view);
      return view;
    },
    activate(view){ view.visible = true; },
    deactivate(view){
      const id = view.userData.presentationId;
      if(id !== null) byId.delete(id);
      view.userData.presentationId = null;
      view.userData.presentationSeen = 0;
      view.visible = false;
    },
  });
  bank.collectStale = (view, index) => {
    if(view.userData.presentationSeen !== bank.serial) bank.stale[bank.staleCount++] = index;
  };
  return bank;
}

function beginBankSync(bank){
  bank.serial += 1;
  bank.staleCount = 0;
}

function touchBankView(bank, id){
  let view = bank.byId.get(id);
  if(!view){
    view = bank.pool.acquire();
    if(!view){
      bank.dropped += 1;
      return null;
    }
    view.userData.presentationId = id;
    bank.byId.set(id, view);
  }
  view.userData.presentationSeen = bank.serial;
  view.visible = true;
  return view;
}

function finishBankSync(bank){
  bank.pool.forEachActive(bank.collectStale);
  for(let index = 0; index < bank.staleCount; index += 1) bank.pool.release(bank.stale[index], 'snapshot-stale');
  bank.staleCount = 0;
}

function entityId(bank, entity, fallbackIndex){
  if(typeof entity?.id === 'string' || Number.isInteger(entity?.id)) return entity.id;
  if(typeof entity?.targetId === 'string') return entity.targetId;
  if(typeof entity?.projectileId === 'string') return entity.projectileId;
  return bank.fallbackIds[fallbackIndex % bank.pool.capacity];
}

function activeEntity(entity){
  return entity && entity.active !== false && entity.destroyed !== true
    && entity.collected !== true && entity.delivered !== true
    && entity.status !== 'destroyed' && entity.status !== 'collected' && entity.status !== 'delivered';
}

function createRouteInstances(scene, budget){
  const thermalMaterial = new THREE.MeshBasicMaterial({ color: 0xffb65c, transparent: true, opacity: 0.46, depthWrite: false });
  const thermals = new THREE.InstancedMesh(new THREE.TorusGeometry(4.2, 0.18, 6, 30), thermalMaterial, budget.thermals);
  thermals.name = 'paper-wings-thermal-instances';
  thermals.count = 0;
  const ribbonMaterial = new THREE.MeshBasicMaterial({ color: 0xe8f2ed, transparent: true, opacity: 0.38, depthWrite: false });
  const windRibbons = new THREE.InstancedMesh(new THREE.BoxGeometry(0.18, 0.06, 5.4), ribbonMaterial, budget.windRibbons);
  windRibbons.name = 'paper-wings-wind-ribbon-instances';
  windRibbons.count = 0;
  const forkMaterial = new THREE.MeshBasicMaterial({ color: 0xff795c, transparent: true, opacity: 0.78 });
  const routeForks = new THREE.InstancedMesh(new THREE.ConeGeometry(0.65, 2.7, 3), forkMaterial, budget.routeForks);
  routeForks.name = 'paper-wings-route-fork-instances';
  routeForks.count = 0;
  scene.add(thermals, windRibbons, routeForks);
  return Object.freeze({ thermals, windRibbons, routeForks });
}

function configureRouteInstances(route, dressing, instances, budget){
  let count = 0;
  const volumes = route.volumes?.thermals || EMPTY_LIST;
  const ringsPerVolume = dressing.kind === 'stunts' || dressing.kind === 'training' ? 3 : 2;
  for(let volumeIndex = 0; volumeIndex < volumes.length && count < budget.thermals; volumeIndex += 1){
    const volume = volumes[volumeIndex];
    for(let ring = 0; ring < ringsPerVolume && count < budget.thermals; ring += 1){
      dummy.position.set(volume.x, volume.y - 4 + ring * 4, -volume.s);
      dummy.rotation.set(Math.PI / 2, 0, ring * 0.35);
      const scale = 0.75 + ring * 0.14;
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      instances.thermals.setMatrixAt(count++, dummy.matrix);
    }
  }
  instances.thermals.count = count;
  instances.thermals.material.color.setHex(dressing.kind === 'survival' || dressing.kind === 'boss' ? 0x87bdc8 : 0xffbd69);
  instances.thermals.instanceMatrix.needsUpdate = true;

  const desiredRibbons = Math.min(budget.windRibbons, Math.max(6, Math.round(8 + dressing.atmosphere.wind * budget.windRibbons * 0.7)));
  for(let index = 0; index < desiredRibbons; index += 1){
    const s = (index + 1) / (desiredRibbons + 1) * route.finishS;
    routePointAtS(route, s, presentationPoint);
    const side = index % 2 === 0 ? -1 : 1;
    dummy.position.set(presentationPoint.x + side * (10 + index % 3 * 4), presentationPoint.y + (index % 4 - 1.5) * 2.4, -s);
    dummy.rotation.set(0, Math.sin(index * 1.7) * 0.08, side * 0.08);
    dummy.scale.set(1, 1, 0.78 + dressing.atmosphere.wind * 0.5);
    dummy.updateMatrix();
    instances.windRibbons.setMatrixAt(index, dummy.matrix);
  }
  instances.windRibbons.count = desiredRibbons;
  instances.windRibbons.material.color.setHex(dressing.palette.snow);
  instances.windRibbons.instanceMatrix.needsUpdate = true;

  count = 0;
  if(dressing.route.forkStyle !== 'none'){
    for(let forkIndex = 0; forkIndex < (route.forks || EMPTY_LIST).length && count < budget.routeForks; forkIndex += 1){
      const fork = route.forks[forkIndex];
      for(let branchIndex = 0; branchIndex < fork.branches.length && count < budget.routeForks; branchIndex += 1){
        const branch = fork.branches[branchIndex];
        for(let marker = 0; marker < 3 && count < budget.routeForks; marker += 1){
          const phase = (marker + 1) / 4;
          const s = fork.startS + (fork.rejoinS - fork.startS) * phase;
          routePointAtS(route, s, presentationPoint);
          const blend = Math.sin(Math.PI * phase);
          dummy.position.set(presentationPoint.x + branch.offsetX * blend, presentationPoint.y + branch.offsetY * blend + 5.5, -s);
          dummy.rotation.set(-Math.PI / 2, 0, branch.id === fork.safeBranchId ? -0.08 : 0.08);
          dummy.scale.setScalar(branch.id === fork.safeBranchId ? 0.8 : 1.05);
          dummy.updateMatrix();
          instances.routeForks.setMatrixAt(count++, dummy.matrix);
        }
      }
    }
  }
  instances.routeForks.count = count;
  instances.routeForks.material.color.setHex(dressing.palette.signal);
  instances.routeForks.instanceMatrix.needsUpdate = true;
}

function buildHeroConditionViews(hero){
  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(6.4, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0x9ed8df, wireframe: true, transparent: true, opacity: 0.34, depthWrite: false }),
  );
  shield.name = 'paper-wings-hero-shield';
  shield.scale.set(1, 0.56, 1.05);
  shield.visible = false;
  const hullDamage = [];
  for(let index = 0; index < 3; index += 1){
    const tear = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15 + index * 0.2, 0.18),
      new THREE.MeshBasicMaterial({ color: index === 2 ? 0xff795c : DARK_INK, side: THREE.DoubleSide }),
    );
    tear.name = `paper-wings-hull-tear-${index}`;
    tear.position.set((index - 1) * 1.7, 0.58, -0.4 + index * 0.72);
    tear.rotation.set(-Math.PI / 2, 0, 0.25 - index * 0.28);
    tear.visible = false;
    hullDamage.push(tear);
    hero.add(tear);
  }
  hero.add(shield);
  return Object.freeze({ shield, hullDamage: Object.freeze(hullDamage) });
}

function buildSkybreakerView(scene){
  const boss = new THREE.Group();
  boss.name = 'paper-wings-skybreaker';
  const phaseViews = [];

  const armor = new THREE.Group();
  armor.name = 'paper-wings-skybreaker-phase-armor';
  const armorMaterial = new THREE.MeshStandardMaterial({ color: 0x243b43, emissive: 0x0d1d22, emissiveIntensity: 0.4, roughness: 0.7, metalness: 0.25 });
  const armorRing = new THREE.Mesh(new THREE.TorusGeometry(8, 1.05, 8, 32), armorMaterial);
  const armorCross = new THREE.Mesh(new THREE.BoxGeometry(15, 1.3, 1.4), armorMaterial);
  armor.add(armorRing, armorCross);
  phaseViews.push(armor);

  const storm = new THREE.Group();
  storm.name = 'paper-wings-skybreaker-phase-storm';
  const stormMaterial = new THREE.MeshBasicMaterial({ color: 0x9bcbd1, transparent: true, opacity: 0.78 });
  const stormRing = new THREE.Mesh(new THREE.TorusGeometry(9.2, 0.42, 7, 36), stormMaterial);
  stormRing.rotation.y = Math.PI / 2;
  storm.add(stormRing);
  for(let index = 0; index < 6; index += 1){
    const vane = new THREE.Mesh(new THREE.ConeGeometry(0.72, 4.4, 3), stormMaterial);
    const angle = index / 6 * Math.PI * 2;
    vane.position.set(Math.cos(angle) * 7.2, Math.sin(angle) * 7.2, 0);
    vane.rotation.z = angle - Math.PI / 2;
    storm.add(vane);
  }
  phaseViews.push(storm);

  const core = new THREE.Group();
  core.name = 'paper-wings-skybreaker-phase-core';
  const coreMesh = new THREE.Mesh(
    new THREE.IcosahedronGeometry(4.5, 1),
    new THREE.MeshStandardMaterial({ color: 0xff9a66, emissive: 0xff4f3b, emissiveIntensity: 1.25, roughness: 0.28 }),
  );
  const coreRing = new THREE.Mesh(
    new THREE.TorusGeometry(6.2, 0.3, 6, 30),
    new THREE.MeshBasicMaterial({ color: 0xffd087, transparent: true, opacity: 0.86 }),
  );
  core.add(coreMesh, coreRing);
  phaseViews.push(core);

  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(10.5, 14, 9),
    new THREE.MeshBasicMaterial({ color: 0x8fc7d0, wireframe: true, transparent: true, opacity: 0.42 }),
  );
  shield.name = 'paper-wings-skybreaker-shield';
  const weakPoints = [];
  for(let index = 0; index < 3; index += 1){
    const weakPoint = new THREE.Mesh(
      new THREE.OctahedronGeometry(1.25, 0),
      new THREE.MeshStandardMaterial({ color: 0xffe2a8, emissive: 0xff795c, emissiveIntensity: 1.1, roughness: 0.35 }),
    );
    weakPoint.name = `paper-wings-skybreaker-weakpoint-${index}`;
    const angle = index / 3 * Math.PI * 2;
    weakPoint.position.set(Math.cos(angle) * 6.4, Math.sin(angle) * 6.4, 1.4);
    weakPoints.push(weakPoint);
    boss.add(weakPoint);
  }
  boss.add(armor, storm, core, shield);
  boss.visible = false;
  boss.userData.phaseViews = Object.freeze(phaseViews);
  boss.userData.weakPoints = Object.freeze(weakPoints);
  boss.userData.shield = shield;
  boss.userData.phaseIndex = 0;
  scene.add(boss);
  return boss;
}

export function buildAlpineWorld(scene, camera, route, {
  lowfx = false,
  race = 'rivals',
  reducedMotion = false,
  missionId = MISSION_IDS[0],
} = {}){
  if(!scene?.isScene || !camera?.isCamera || !route?.gates?.length) throw new TypeError('buildAlpineWorld requires a scene, camera, and route');
  const budget = lowfx ? PRESENTATION_POOL_BUDGETS.lowfx : PRESENTATION_POOL_BUDGETS.full;
  const lighting = createLighting(scene, lowfx);
  const sun = lighting.sun;
  buildTerrain(scene, route, lowfx);
  buildForest(scene, route, lowfx);
  const clouds = buildClouds(scene, lowfx);
  const gateViews = route.gates.map((gate, index) => buildGate(scene, gate, index));
  const finish = buildFinish(scene, route);
  const hero = buildPaperGlider(0xf4eee4, 'paper', true);
  scene.add(hero);
  const heroConditionViews = buildHeroConditionViews(hero);
  const rivalViews = WING_RIVALS.map(profile => {
    const mesh = buildPaperGlider(profile.color, profile.style, false);
    mesh.scale.multiplyScalar(0.72);
    mesh.visible = race === 'rivals';
    scene.add(mesh);
    return { profile, mesh };
  });
  const routeInstances = createRouteInstances(scene, budget);
  const targetBank = createViewBank(scene, 'targets', budget.targets, makeTargetView);
  const projectileBank = createViewBank(scene, 'projectiles', budget.projectiles, makeProjectileView);
  const hazardBank = createViewBank(scene, 'hazards', budget.hazards, makeHazardView);
  const rescueBank = createViewBank(scene, 'rescue', budget.rescue, makeRescueView);
  const trailBank = createViewBank(scene, 'trails', budget.trails, makeTrailView);
  const impactBank = createViewBank(scene, 'impacts', budget.impacts, makeImpactView);
  const bossView = buildSkybreakerView(scene);
  const cameraTarget = new THREE.Vector3();
  const desiredCamera = new THREE.Vector3();
  const look = new THREE.Vector3();
  const lastHeroPosition = new THREE.Vector3(0, 33, 0);
  const recentEventIds = new Array(64).fill(null);
  let recentEventCursor = 0;
  let currentDressing = getMissionDressing(missionId);
  let realRivals = false;
  let syncedRank = race === 'rivals' ? 4 : 1;
  let activeBoss = false;
  let syncTime = 0;
  let syncDt = 0;
  let lastFlightS = 0;
  let lastFlightTime = 0;
  let lastAeroEventSequence = -1;
  let lastStuntEventSequence = -1;

  camera.position.set(26, 51, 48);
  camera.lookAt(0, 32, -18);
  camera.fov = 58;
  camera.updateProjectionMatrix();

  function clearDynamicViews(reason = 'mission-change'){
    targetBank.pool.drain(reason);
    projectileBank.pool.drain(reason);
    hazardBank.pool.drain(reason);
    rescueBank.pool.drain(reason);
    trailBank.pool.drain(reason);
    impactBank.pool.drain(reason);
  }

  function loadMission(id = MISSION_IDS[0]){
    const dressing = getMissionDressing(id);
    currentDressing = dressing;
    clearDynamicViews();
    configureRouteInstances(route, dressing, routeInstances, budget);
    scene.background.setHex(dressing.palette.skyTop);
    if(scene.fog?.isFogExp2){
      scene.fog.color.setHex(dressing.palette.fog);
      scene.fog.density = dressing.atmosphere.fogDensity * (lowfx ? 1.12 : 1);
    }
    lighting.hemi.color.setHex(dressing.palette.skyHorizon);
    lighting.hemi.groundColor.setHex(dressing.palette.terrain);
    lighting.hemi.intensity = 1.72 + dressing.atmosphere.exposure * 0.48;
    lighting.fill.color.setHex(dressing.palette.water);
    lighting.fill.intensity = 0.42 + dressing.atmosphere.cloudCover * 0.42;
    sun.color.setHex(dressing.kind === 'survival' || dressing.kind === 'boss' ? 0xd7dfe2 : 0xffe3bd);
    sun.intensity = 2.25 + dressing.atmosphere.exposure;
    for(let index = 0; index < clouds.length; index += 1){
      const threshold = Math.max(1, Math.round(dressing.atmosphere.cloudCover * clouds.length));
      clouds[index].visible = index < threshold;
    }
    for(let index = 0; index < gateViews.length; index += 1){
      gateViews[index].userData.material.color.setHex(dressing.palette.signal);
      gateViews[index].userData.material.emissive.setHex(dressing.palette.signal);
    }
    targetBank.root.visible = dressing.kind === 'targets' || dressing.kind === 'pursuit' || dressing.kind === 'boss';
    projectileBank.root.visible = dressing.kind === 'targets' || dressing.kind === 'pursuit' || dressing.kind === 'boss';
    hazardBank.root.visible = dressing.hazards.length > 0;
    rescueBank.root.visible = dressing.kind === 'rescue' || dressing.kind === 'boss';
    trailBank.root.visible = dressing.kind === 'stunts' || dressing.kind === 'pursuit' || dressing.kind === 'boss';
    heroConditionViews.shield.visible = false;
    for(let index = 0; index < heroConditionViews.hullDamage.length; index += 1) heroConditionViews.hullDamage[index].visible = false;
    bossView.visible = dressing.id === 'skybreaker-finale';
    bossView.position.set(0, 48, -Math.min(route.finishS * 0.68, route.finishS - 25));
    bossView.userData.phaseIndex = 0;
    for(let index = 0; index < bossView.userData.phaseViews.length; index += 1) bossView.userData.phaseViews[index].visible = index === 0;
    bossView.userData.shield.visible = true;
    activeBoss = false;
    realRivals = false;
    recentEventIds.fill(null);
    recentEventCursor = 0;
    lastAeroEventSequence = -1;
    lastStuntEventSequence = -1;
    return dressing;
  }

  function updateTargetView(view, entity){
    worldPositionFromEntity(route, entity, view.position);
    const scale = clamp(finite(entity.radius, 1.5) / 1.5, 0.55, 2.4);
    view.scale.setScalar(scale);
    view.rotation.set(0, syncTime * 0.72 + finite(entity.phase, 0), Math.sin(syncTime * 1.4 + finite(entity.phase, 0)) * 0.18);
    const hpRatio = clamp(finite(entity.hp, 1) / Math.max(0.001, finite(entity.maxHp, finite(entity.hp, 1))), 0, 1);
    view.userData.paper.material.color.setHex(entity.team === 'player' ? 0x8ec9d1 : hpRatio < 0.5 ? 0xff9b70 : 0xf2ece0);
    view.userData.lock.material.opacity = 0.45 + hpRatio * 0.45;
  }

  function updateProjectileView(view, entity){
    worldPositionFromEntity(route, entity, view.position);
    view.scale.setScalar(clamp(finite(entity.radius, 0.2) / 0.2, 0.65, 2.4));
    view.rotation.set(-Math.PI / 2 + Math.atan2(finite(entity.vy, 0), Math.max(0.001, Math.abs(finite(entity.vs, 1)))), 0, -Math.atan2(finite(entity.vx, 0), Math.max(0.001, Math.abs(finite(entity.vs, 1)))));
    view.material.color.setHex(entity.team === 'enemy' ? 0xff8a68 : 0xffd4a8);
  }

  function updateHazardView(view, entity){
    worldPositionFromEntity(route, entity, view.position);
    const kind = typeof entity.kind === 'string' ? entity.kind : typeof entity.type === 'string' ? entity.type : 'downdraft';
    const lightning = kind.includes('lightning') || kind.includes('strike');
    const debris = kind.includes('debris') || kind.includes('rock') || kind.includes('shard');
    view.userData.lightning.visible = lightning;
    view.userData.debris.visible = debris;
    view.userData.downdraft.visible = !lightning && !debris;
    const severity = clamp(finite(entity.severity, finite(entity.turbulence, 0.5)), 0.15, 1);
    view.scale.setScalar(0.72 + severity * 0.72);
    view.rotation.y = syncTime * (lightning ? 0.15 : 0.75) + finite(entity.phase, 0);
    view.userData.lightning.material.opacity = reducedMotion ? 0.82 : 0.62 + Math.sin(syncTime * 17 + finite(entity.phase, 0)) * 0.28;
  }

  function updateRescueView(view, entity){
    worldPositionFromEntity(route, entity, view.position);
    const kind = typeof entity.kind === 'string' ? entity.kind : typeof entity.type === 'string' ? entity.type : 'pickup';
    const isDrop = kind.includes('drop-zone') || kind.includes('rescue-ring') || kind === 'zone';
    const isParcel = kind.includes('parcel') || kind.includes('supply-drop');
    view.userData.pickup.visible = !isDrop && !isParcel;
    view.userData.dropZone.visible = isDrop;
    view.userData.parcel.visible = isParcel;
    view.rotation.y = reducedMotion ? 0 : syncTime * 0.38 + finite(entity.phase, 0);
    view.userData.dropZone.rotation.z = reducedMotion ? 0 : syncTime * 0.32;
    view.scale.setScalar(clamp(finite(entity.radius, isDrop ? 4 : 1.5) / (isDrop ? 4 : 1.5), 0.65, 2.2));
  }

  function updateTrailView(view, entity){
    worldPositionFromEntity(route, entity, view.position);
    view.rotation.set(finite(entity.pitch, 0), finite(entity.yaw, 0), -finite(entity.bank, finite(entity.roll, 0)));
    const intensity = clamp(finite(entity.intensity, 0.7), 0.15, 1);
    view.scale.set(1, 1, 0.55 + intensity * 0.85);
    view.material.opacity = 0.22 + intensity * 0.58;
    view.material.color.setHex(currentDressing.kind === 'survival' || currentDressing.kind === 'boss' ? 0x9ad4dc : 0xffbc68);
  }

  function syncBankArray(bank, source, update, fallbackOffset = 0){
    if(!Array.isArray(source)) return fallbackOffset;
    for(let index = 0; index < source.length; index += 1){
      const entity = source[index];
      if(!activeEntity(entity)) continue;
      const view = touchBankView(bank, entityId(bank, entity, fallbackOffset + index));
      if(view) update(view, entity);
    }
    return fallbackOffset + source.length;
  }

  function syncRivalViews(source, playerS){
    if(!Array.isArray(source)) return;
    realRivals = true;
    syncedRank = 1;
    for(let viewIndex = 0; viewIndex < rivalViews.length; viewIndex += 1){
      const view = rivalViews[viewIndex];
      let state = null;
      for(let rivalIndex = 0; rivalIndex < source.length; rivalIndex += 1){
        if(source[rivalIndex]?.id === view.profile.id){ state = source[rivalIndex]; break; }
      }
      if(!state){ view.mesh.visible = false; continue; }
      const s = finite(state.s, 0);
      routePointAtS(route, s, presentationPoint, state);
      view.mesh.visible = state.status !== 'destroyed' && s < route.finishS + 10;
      view.mesh.position.set(
        Number.isFinite(state.x) ? state.x : presentationPoint.x + finite(state.lateral, view.profile.lane),
        Number.isFinite(state.y) ? state.y : presentationPoint.y + finite(state.altitude, view.profile.altitude),
        -s,
      );
      const actionBank = state.action === 'boost' ? 0.28 : state.action === 'attack' ? -0.18 : 0;
      view.mesh.rotation.set(Math.sin(syncTime * 0.62 + viewIndex) * 0.05, 0, actionBank + Math.sin(syncTime * 0.72 + viewIndex) * 0.12);
      view.mesh.userData.presentationAction = state.action || 'cruise';
      view.mesh.userData.presentationS = s;
      if(!state.finished && s > playerS + 0.01) syncedRank += 1;
      if(state.finished) syncedRank += 1;
    }
  }

  function updateHeroCondition(aero){
    const shieldActive = aero?.shieldActive === true || aero?.shield === true;
    heroConditionViews.shield.visible = shieldActive;
    heroConditionViews.shield.rotation.y = reducedMotion ? 0 : syncTime * 0.75;
    heroConditionViews.shield.material.opacity = shieldActive ? 0.27 + (reducedMotion ? 0 : Math.sin(syncTime * 4.2) * 0.07) : 0;
    const maximum = Math.max(1, Math.floor(finite(aero?.maxIntegrity, 3)));
    const integrity = clamp(Math.floor(finite(aero?.integrity, maximum)), 0, maximum);
    const damage = maximum - integrity;
    for(let index = 0; index < heroConditionViews.hullDamage.length; index += 1) heroConditionViews.hullDamage[index].visible = index < damage;
    hero.userData.presentationIntegrity = integrity;
    hero.userData.presentationMaxIntegrity = maximum;
  }

  function updateBoss(entity){
    if(!entity || entity.status === 'destroyed'){
      activeBoss = false;
      bossView.visible = false;
      return;
    }
    activeBoss = true;
    bossView.visible = true;
    worldPositionFromEntity(route, entity, bossView.position);
    const phaseIndex = clamp(Math.floor(finite(entity.phaseIndex, 0)), 0, 2);
    bossView.userData.phaseIndex = phaseIndex;
    for(let index = 0; index < bossView.userData.phaseViews.length; index += 1) bossView.userData.phaseViews[index].visible = index === phaseIndex;
    bossView.userData.shield.visible = entity.vulnerable === false;
    const weakPoints = Array.isArray(entity.weakPoints) ? entity.weakPoints : EMPTY_LIST;
    for(let index = 0; index < bossView.userData.weakPoints.length; index += 1){
      const weakPoint = bossView.userData.weakPoints[index];
      const state = weakPoints[index];
      weakPoint.visible = entity.status !== 'destroyed' && (!state || activeEntity(state));
      weakPoint.scale.setScalar(entity.vulnerable === false ? 0.72 : 1 + (reducedMotion ? 0 : Math.sin(syncTime * 5 + index) * 0.12));
    }
    const scale = clamp(finite(entity.radius, 5) / 5, 0.72, 2.4);
    bossView.scale.setScalar(scale);
    bossView.rotation.y = reducedMotion ? 0 : syncTime * (phaseIndex === 2 ? 0.55 : 0.24);
    bossView.rotation.z = reducedMotion ? 0 : Math.sin(syncTime * 0.62) * (phaseIndex + 1) * 0.035;
  }

  function wasEventSeen(id){
    if(id === null || id === undefined) return false;
    for(let index = 0; index < recentEventIds.length; index += 1){
      if(recentEventIds[index] === id) return true;
    }
    recentEventIds[recentEventCursor] = id;
    recentEventCursor = (recentEventCursor + 1) % recentEventIds.length;
    return false;
  }

  function spawnImpact(type, source){
    let view = impactBank.pool.acquire();
    if(!view){
      impactBank.pool.release(impactBank.recycleCursor, 'impact-recycle');
      impactBank.recycleCursor = (impactBank.recycleCursor + 1) % impactBank.pool.capacity;
      view = impactBank.pool.acquire();
    }
    if(!view) return;
    view.userData.presentationId = null;
    const target = source?.targetId !== undefined ? targetBank.byId.get(source.targetId) : null;
    if(target) view.position.copy(target.position);
    else if((source?.bossId !== undefined || type.includes('boss')) && bossView.visible) view.position.copy(bossView.position);
    else if(Number.isFinite(source?.s) || Number.isFinite(source?.x) || Number.isFinite(source?.y)) worldPositionFromEntity(route, source, view.position);
    else view.position.copy(lastHeroPosition);
    const blocked = type.includes('blocked') || type.includes('shield');
    const rescue = type.includes('rescue') || type.includes('drop') || type.includes('pickup');
    view.userData.ring.material.color.setHex(blocked ? 0x8fd0d9 : rescue ? 0xffd36d : 0xff795c);
    view.userData.shard.material.color.setHex(blocked ? 0xd7f1f2 : rescue ? 0xf4ece0 : 0xff9b70);
    view.userData.life = reducedMotion ? 0.28 : 0.58;
    view.userData.duration = view.userData.life;
    view.scale.setScalar(0.65);
    view.rotation.set(0, 0, 0);
  }

  function processEvents(events){
    if(!Array.isArray(events)) return;
    for(let index = 0; index < events.length; index += 1){
      const event = events[index];
      if(!event || typeof event.type !== 'string' || wasEventSeen(event.id)) continue;
      if(event.type.includes('hit') || event.type.includes('destroyed') || event.type.includes('blocked')
        || event.type.includes('impact') || event.type.includes('rescue') || event.type.includes('drop')
        || event.type.includes('pickup') || event.type.includes('lightning')) spawnImpact(event.type, event);
    }
  }

  function ageImpact(view, index){
    view.userData.life -= syncDt;
    if(view.userData.life <= 0){ impactBank.stale[impactBank.staleCount++] = index; return; }
    const life = view.userData.life / Math.max(0.001, view.userData.duration);
    view.scale.setScalar(0.65 + (1 - life) * 1.65);
    view.rotation.z += syncDt * 3.2;
    view.userData.ring.material.opacity = life * 0.9;
    view.userData.shard.material.opacity = life * 0.9;
  }

  function updateImpactPool(){
    impactBank.staleCount = 0;
    impactBank.pool.forEachActive(ageImpact);
    for(let index = 0; index < impactBank.staleCount; index += 1) impactBank.pool.release(impactBank.stale[index], 'impact-ended');
    impactBank.staleCount = 0;
  }

  function syncPresentation(snapshot = EMPTY_OBJECT, eventsOrOptions = null, timeArgument = undefined, dtArgument = undefined){
    const root = snapshot && typeof snapshot === 'object' ? snapshot : EMPTY_OBJECT;
    let explicitEvents = null;
    if(Array.isArray(eventsOrOptions)) explicitEvents = eventsOrOptions;
    else if(eventsOrOptions && typeof eventsOrOptions === 'object') explicitEvents = Array.isArray(eventsOrOptions.events) ? eventsOrOptions.events : null;
    syncTime = finite(
      eventsOrOptions && !Array.isArray(eventsOrOptions) ? eventsOrOptions.time : timeArgument,
      finite(root.time, finite(root.flight?.time, lastFlightTime)),
    );
    syncDt = clamp(finite(eventsOrOptions && !Array.isArray(eventsOrOptions) ? eventsOrOptions.dt : dtArgument, 0), 0, 0.1);
    const combat = root.combat && typeof root.combat === 'object' ? root.combat : root;
    const aero = root.aero && typeof root.aero === 'object' ? root.aero
      : root.player?.aero && typeof root.player.aero === 'object' ? root.player.aero
        : root.flight?.aero && typeof root.flight.aero === 'object' ? root.flight.aero
          : root.player && typeof root.player === 'object' ? root.player : root;
    const flight = root.flight && typeof root.flight === 'object' ? root.flight
      : root.player?.flight && typeof root.player.flight === 'object' ? root.player.flight
        : root.player && typeof root.player === 'object' ? root.player : root;

    beginBankSync(targetBank);
    syncBankArray(targetBank, Array.isArray(combat.targets) ? combat.targets : root.targets, updateTargetView);
    finishBankSync(targetBank);

    beginBankSync(projectileBank);
    syncBankArray(projectileBank, Array.isArray(combat.projectiles) ? combat.projectiles : root.projectiles, updateProjectileView);
    finishBankSync(projectileBank);

    beginBankSync(hazardBank);
    const hazardSource = Array.isArray(root.hazards) ? root.hazards
      : Array.isArray(root.storm?.hazards) ? root.storm.hazards
        : currentDressing.kind === 'survival' || currentDressing.kind === 'boss' ? route.volumes?.hazards : null;
    syncBankArray(hazardBank, hazardSource, updateHazardView);
    finishBankSync(hazardBank);

    beginBankSync(rescueBank);
    const rescue = root.rescue && typeof root.rescue === 'object' ? root.rescue : root;
    let rescueOffset = 0;
    rescueOffset = syncBankArray(rescueBank, rescue.entities, updateRescueView, rescueOffset);
    rescueOffset = syncBankArray(rescueBank, rescue.pickups, updateRescueView, rescueOffset);
    rescueOffset = syncBankArray(rescueBank, rescue.dropZones, updateRescueView, rescueOffset);
    syncBankArray(rescueBank, rescue.parcels, updateRescueView, rescueOffset);
    finishBankSync(rescueBank);

    beginBankSync(trailBank);
    const stunt = root.stunts && typeof root.stunts === 'object' ? root.stunts
      : root.stunt && typeof root.stunt === 'object' ? root.stunt : null;
    syncBankArray(trailBank, Array.isArray(root.stuntTrails) ? root.stuntTrails : root.trails, updateTrailView);
    if(stunt?.active){
      const syntheticCount = Math.min(6, trailBank.pool.capacity);
      for(let index = 0; index < syntheticCount; index += 1){
        const view = touchBankView(trailBank, trailBank.fallbackIds[index]);
        if(!view) break;
        const spacing = 3.2 + index * 2.4;
        view.position.set(hero.position.x, hero.position.y + Math.sin(syncTime * 3 + index) * 0.22, hero.position.z + spacing);
        view.rotation.copy(hero.rotation);
        view.scale.set(1, 1, 0.9 + index * 0.12);
        view.material.opacity = 0.58 * (1 - index / (syntheticCount + 1));
        view.material.color.setHex(currentDressing.kind === 'boss' ? 0x9ad4dc : 0xffbc68);
      }
    }
    finishBankSync(trailBank);

    const rivalSource = Array.isArray(root.rivals) ? root.rivals
      : Array.isArray(root.rivalField) ? root.rivalField
        : Array.isArray(root.race?.rivals) ? root.race.rivals : null;
    const playerS = finite(flight.s, lastFlightS);
    syncRivalViews(rivalSource, playerS);
    updateHeroCondition(aero);
    updateBoss(combat.boss || root.boss || null);

    const eventSource = explicitEvents || (Array.isArray(combat.events) ? combat.events : Array.isArray(root.events) ? root.events : null);
    processEvents(eventSource);
    if(aero?.event && finite(aero.eventSequence, -1) !== lastAeroEventSequence){
      lastAeroEventSequence = finite(aero.eventSequence, lastAeroEventSequence);
      if(aero.event.includes('impact') || aero.event === 'disabled') spawnImpact(aero.event, flight);
    }
    if(stunt?.event && finite(stunt.eventSequence, -1) !== lastStuntEventSequence){
      lastStuntEventSequence = finite(stunt.eventSequence, lastStuntEventSequence);
      if(stunt.event.startsWith('completed:')) spawnImpact(stunt.event, flight);
    }
    updateImpactPool();
    return campaignViews;
  }

  function syncEvents(events, time = lastFlightTime, dt = 0){
    syncTime = finite(time, lastFlightTime);
    syncDt = clamp(finite(dt, 0), 0, 0.1);
    processEvents(events);
    updateImpactPool();
    return campaignViews;
  }

  function stageTitle(time){
    const titleTime = reducedMotion ? 0 : time;
    hero.position.set(Math.sin(titleTime * 0.28) * 1.8, 32 + Math.sin(titleTime * 0.6) * 0.45, -12);
    hero.rotation.set(-0.04 + Math.sin(titleTime * 0.31) * 0.025, 0.06, Math.sin(titleTime * 0.45) * 0.09);
    lastHeroPosition.copy(hero.position);
    for(let index = 0; index < rivalViews.length; index += 1){
      const view = rivalViews[index];
      view.mesh.visible = race === 'rivals';
      view.mesh.position.set(-12 + index * 11, 28 + index * 2.3, -24 - index * 5);
      view.mesh.rotation.set(0, 0, Math.sin(titleTime * 0.5 + index) * 0.08);
    }
    if(currentDressing.id === 'skybreaker-finale' && !activeBoss){
      bossView.visible = true;
      bossView.rotation.y = titleTime * 0.12;
    }
    cameraTarget.set(24, 50, 45);
    camera.position.lerp(cameraTarget, 0.025);
    look.set(0, 32, -17);
    camera.lookAt(look);
  }

  function updateFlight(state, time, dt){
    const s = finite(state?.s, 0);
    const x = finite(state?.x, 0);
    const y = finite(state?.y, 33);
    const bank = finite(state?.bank, 0);
    const pitch = finite(state?.pitch, 0);
    const speed = finite(state?.speed, 18);
    lastFlightS = s;
    lastFlightTime = finite(state?.time, time);
    hero.position.set(x, y, -s);
    lastHeroPosition.copy(hero.position);
    hero.rotation.x = pitch * 0.34;
    hero.rotation.y = bank * 0.08;
    hero.rotation.z = -bank * 0.78;
    const flex = 1 + Math.sin(time * 7.5) * Math.min(0.022, speed * 0.0008);
    hero.userData.wing.scale.y = flex;

    for(let index = 0; index < rivalViews.length; index += 1){
      const view = rivalViews[index];
      if(race !== 'rivals'){
        view.mesh.visible = false;
        continue;
      }
      if(realRivals){
        view.mesh.rotation.x += reducedMotion ? 0 : Math.sin(time * 0.6 + index) * 0.0015;
        continue;
      }
      const rivalS = rivalProgress(view.profile, lastFlightTime, route);
      const point = routePointAtS(route, rivalS, tempPoint);
      view.mesh.visible = rivalS < route.finishS + 10;
      view.mesh.position.set(
        point.x + view.profile.lane + Math.sin(time * 0.75 + index) * 2.4,
        point.y + view.profile.altitude + Math.sin(time * 0.9 + index) * 0.6,
        -rivalS,
      );
      view.mesh.rotation.set(Math.sin(time * 0.6 + index) * 0.05, 0, Math.sin(time * 0.72 + index) * 0.22);
    }

    for(let index = 0; index < gateViews.length; index += 1){
      const view = gateViews[index];
      const passed = index < finite(state?.gateIndex, 0);
      const current = index === finite(state?.gateIndex, 0);
      view.visible = view.userData.gate.s > s - 45;
      view.userData.material.color.setHex(passed ? 0x799c8c : currentDressing.palette.signal);
      view.userData.material.emissive.setHex(passed ? 0x183329 : currentDressing.palette.signal);
      view.userData.material.emissiveIntensity = current ? 1.35 : passed ? 0.12 : 0.48;
      view.userData.rimMaterial.color.setHex(passed ? 0x29443c : DARK_INK);
      view.userData.rimMaterial.emissive.setHex(passed ? 0x0d211b : 0x081416);
      view.userData.rimMaterial.emissiveIntensity = current ? 0.52 : passed ? 0.10 : 0.26;
      const pulse = current && !reducedMotion ? 1 + Math.sin(time * 3.4) * 0.025 : 1;
      view.scale.setScalar(pulse);
      view.rotation.z = current && !reducedMotion ? Math.sin(time * 0.45) * 0.055 : 0;
    }

    const cameraRate = 1 - Math.exp(-4.2 * Math.min(finite(dt, 0), 0.05));
    desiredCamera.set(x - bank * 2.8, y + 5.0 - pitch * 1.6, -s + 16.5);
    camera.position.lerp(desiredCamera, cameraRate);
    const nextPoint = routePointAtS(route, s + 30, tempPoint);
    look.set(nextPoint.x * 0.55 + x * 0.45, nextPoint.y * 0.62 + y * 0.38, -s - 26);
    camera.lookAt(look);
    const targetFov = 57 + speed * 0.22;
    camera.fov += (targetFov - camera.fov) * cameraRate;
    camera.updateProjectionMatrix();

    sun.position.set(x - 120, y + 180, -s + 100);
    sun.target.position.set(x, y, -s - 30);
    for(let index = 0; index < clouds.length; index += 1){
      const cloud = clouds[index];
      if(!cloud.visible) continue;
      cloud.position.x += cloud.userData.speed * finite(dt, 0);
      if(cloud.position.x > 180) cloud.position.x = -180;
    }
    if(bossView.visible && !reducedMotion){
      bossView.userData.phaseViews[1].rotation.z += finite(dt, 0) * 0.85;
      bossView.userData.phaseViews[2].rotation.y += finite(dt, 0) * 0.55;
    }
    finish.visible = s > route.finishS - 280;
  }

  function diagnostics(state = {}){
    let visibleRivals = 0;
    for(let index = 0; index < rivalViews.length; index += 1) if(rivalViews[index].mesh.visible) visibleRivals += 1;
    const standing = realRivals ? null : raceStanding(finite(state.s, lastFlightS), finite(state.time, lastFlightTime), route, race);
    const poolDiagnostics = Object.freeze({
      targets: Object.freeze({ ...targetBank.pool.diagnostics(), dropped: targetBank.dropped }),
      projectiles: Object.freeze({ ...projectileBank.pool.diagnostics(), dropped: projectileBank.dropped }),
      hazards: Object.freeze({ ...hazardBank.pool.diagnostics(), dropped: hazardBank.dropped }),
      rescue: Object.freeze({ ...rescueBank.pool.diagnostics(), dropped: rescueBank.dropped }),
      trails: Object.freeze({ ...trailBank.pool.diagnostics(), dropped: trailBank.dropped }),
      impacts: Object.freeze({ ...impactBank.pool.diagnostics(), dropped: impactBank.dropped }),
    });
    return Object.freeze({
      gates: gateViews.length,
      rivals: visibleRivals,
      rank: realRivals ? syncedRank : standing.rank,
      sceneChildren: scene.children.length,
      lowfx,
      missionId: currentDressing.id,
      pools: poolDiagnostics,
      instances: Object.freeze({
        thermals: routeInstances.thermals.count,
        windRibbons: routeInstances.windRibbons.count,
        routeForks: routeInstances.routeForks.count,
      }),
      hero: Object.freeze({
        shield: heroConditionViews.shield.visible,
        integrity: hero.userData.presentationIntegrity ?? 3,
        hullDamage: heroConditionViews.hullDamage.reduce((count, view) => count + (view.visible ? 1 : 0), 0),
      }),
      boss: Object.freeze({ active: activeBoss, phase: bossView.userData.phaseIndex }),
    });
  }

  const campaignViews = Object.freeze({
    missionIds: MISSION_IDS,
    routeInstances,
    targetPool: targetBank.pool,
    projectilePool: projectileBank.pool,
    hazardPool: hazardBank.pool,
    rescuePool: rescueBank.pool,
    trailPool: trailBank.pool,
    impactPool: impactBank.pool,
    heroShield: heroConditionViews.shield,
    hullDamage: heroConditionViews.hullDamage,
    boss: bossView,
  });

  loadMission(missionId);
  return Object.freeze({
    hero,
    rivalViews,
    gateViews,
    campaignViews,
    stageTitle,
    updateFlight,
    loadMission,
    setMissionDressing: loadMission,
    currentMission: () => currentDressing,
    syncPresentation,
    syncSnapshot: syncPresentation,
    syncEvents,
    diagnostics,
  });
}
