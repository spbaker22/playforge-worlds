/* PAPER WINGS - procedural alpine world and folded glider family. */
import * as THREE from 'three';
import { raceStanding, rivalProgress, routePointAtS, WING_RIVALS } from './route.js';

const tempPoint = { x: 0, y: 33 };
const dummy = new THREE.Object3D();
const DARK_INK = 0x15292e;

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
  return sun;
}

export function buildAlpineWorld(scene, camera, route, { lowfx = false, race = 'rivals', reducedMotion = false } = {}){
  const sun = createLighting(scene, lowfx);
  buildTerrain(scene, route, lowfx);
  buildForest(scene, route, lowfx);
  const clouds = buildClouds(scene, lowfx);
  const gateViews = route.gates.map((gate, index) => buildGate(scene, gate, index));
  const finish = buildFinish(scene, route);
  const hero = buildPaperGlider(0xf4eee4, 'paper', true);
  scene.add(hero);
  const rivalViews = WING_RIVALS.map(profile => {
    const mesh = buildPaperGlider(profile.color, profile.style, false);
    mesh.scale.multiplyScalar(0.72);
    mesh.visible = race === 'rivals';
    scene.add(mesh);
    return { profile, mesh };
  });
  const cameraTarget = new THREE.Vector3();
  const desiredCamera = new THREE.Vector3();
  const look = new THREE.Vector3();
  camera.position.set(26, 51, 48);
  camera.lookAt(0, 32, -18);
  camera.fov = 58;
  camera.updateProjectionMatrix();

  function stageTitle(time){
    const titleTime = reducedMotion ? 0 : time;
    hero.position.set(Math.sin(titleTime * 0.28) * 1.8, 32 + Math.sin(titleTime * 0.6) * 0.45, -12);
    hero.rotation.set(-0.04 + Math.sin(titleTime * 0.31) * 0.025, 0.06, Math.sin(titleTime * 0.45) * 0.09);
    rivalViews.forEach(({ mesh, profile }, index) => {
      mesh.visible = race === 'rivals';
      mesh.position.set(-12 + index * 11, 28 + index * 2.3, -24 - index * 5);
      mesh.rotation.set(0, 0, Math.sin(titleTime * 0.5 + index) * 0.08);
    });
    cameraTarget.set(24, 50, 45);
    camera.position.lerp(cameraTarget, 0.025);
    look.set(0, 32, -17);
    camera.lookAt(look);
  }

  function updateFlight(state, time, dt){
    hero.position.set(state.x, state.y, -state.s);
    hero.rotation.x = state.pitch * 0.34;
    hero.rotation.y = state.bank * 0.08;
    hero.rotation.z = -state.bank * 0.78;
    const flex = 1 + Math.sin(time * 7.5) * Math.min(0.022, state.speed * 0.0008);
    hero.userData.wing.scale.y = flex;

    rivalViews.forEach(({ profile, mesh }, index) => {
      if(race !== 'rivals'){
        mesh.visible = false;
        return;
      }
      const s = rivalProgress(profile, state.time, route);
      const point = routePointAtS(route, s, tempPoint);
      mesh.visible = s < route.finishS + 10;
      mesh.position.set(
        point.x + profile.lane + Math.sin(time * 0.75 + index) * 2.4,
        point.y + profile.altitude + Math.sin(time * 0.9 + index) * 0.6,
        -s,
      );
      mesh.rotation.set(Math.sin(time * 0.6 + index) * 0.05, 0, Math.sin(time * 0.72 + index) * 0.22);
    });

    gateViews.forEach((view, index) => {
      const passed = index < state.gateIndex;
      const current = index === state.gateIndex;
      view.visible = view.userData.gate.s > state.s - 45;
      view.userData.material.color.setHex(passed ? 0x799c8c : 0xff795c);
      view.userData.material.emissive.setHex(passed ? 0x183329 : 0xb83226);
      view.userData.material.emissiveIntensity = current ? 1.35 : passed ? 0.12 : 0.48;
      view.userData.rimMaterial.color.setHex(passed ? 0x29443c : DARK_INK);
      view.userData.rimMaterial.emissive.setHex(passed ? 0x0d211b : 0x081416);
      view.userData.rimMaterial.emissiveIntensity = current ? 0.52 : passed ? 0.10 : 0.26;
      const pulse = current && !reducedMotion ? 1 + Math.sin(time * 3.4) * 0.025 : 1;
      view.scale.setScalar(pulse);
      view.rotation.z = current && !reducedMotion ? Math.sin(time * 0.45) * 0.055 : 0;
    });

    const cameraRate = 1 - Math.exp(-4.2 * Math.min(dt, 0.05));
    desiredCamera.set(state.x - state.bank * 2.8, state.y + 5.0 - state.pitch * 1.6, -state.s + 16.5);
    camera.position.lerp(desiredCamera, cameraRate);
    const nextPoint = routePointAtS(route, state.s + 30, tempPoint);
    look.set(nextPoint.x * 0.55 + state.x * 0.45, nextPoint.y * 0.62 + state.y * 0.38, -state.s - 26);
    camera.lookAt(look);
    const targetFov = 57 + state.speed * 0.22;
    camera.fov += (targetFov - camera.fov) * cameraRate;
    camera.updateProjectionMatrix();

    sun.position.set(state.x - 120, state.y + 180, -state.s + 100);
    sun.target.position.set(state.x, state.y, -state.s - 30);
    for(const cloud of clouds){
      cloud.position.x += cloud.userData.speed * dt;
      if(cloud.position.x > 180) cloud.position.x = -180;
    }
    finish.visible = state.s > route.finishS - 280;
  }

  function diagnostics(state){
    const standing = raceStanding(state.s, state.time, route, race);
    return Object.freeze({
      gates: gateViews.length,
      rivals: rivalViews.filter(view => view.mesh.visible).length,
      rank: standing.rank,
      sceneChildren: scene.children.length,
      lowfx,
    });
  }

  return Object.freeze({ hero, rivalViews, gateViews, stageTitle, updateFlight, diagnostics });
}
