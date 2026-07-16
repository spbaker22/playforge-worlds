import * as THREE from 'three';
import { Particles } from '../../engine/fx.js';
import { ASHFALL_BOUNDS } from './rules.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function seeded(seed){
  let value = seed >>> 0;
  return () => {
    value = value + 0x6D2B79F5 | 0;
    let out = Math.imul(value ^ value >>> 15, 1 | value);
    out = out + Math.imul(out ^ out >>> 7, 61 | out) ^ out;
    return ((out ^ out >>> 14) >>> 0) / 4294967296;
  };
}

function standard(color, extras = {}){
  return new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.08, ...extras });
}

function mesh(geometry, material, { cast = true, receive = true } = {}){
  const value = new THREE.Mesh(geometry, material);
  value.castShadow = cast;
  value.receiveShadow = receive;
  return value;
}

function makeLimb(material, radius, length){
  const pivot = new THREE.Group();
  const part = mesh(new THREE.CapsuleGeometry(radius, length, 4, 8), material);
  part.position.y = -length * 0.55;
  pivot.add(part);
  return pivot;
}

export function buildAshfallSurvivor({ accent = 0xFF7138, companion = false } = {}){
  const root = new THREE.Group();
  const suit = standard(companion ? 0x25262E : 0x1C222C, { roughness: 0.58, metalness: 0.18 });
  const armor = standard(companion ? 0x34333A : 0x33404A, { roughness: 0.42, metalness: 0.28 });
  const accentMaterial = standard(accent, { emissive: accent, emissiveIntensity: companion ? 0.08 : 0.22, roughness: 0.4 });
  const skin = standard(0xBCA087, { roughness: 0.76 });

  const hips = mesh(new THREE.CapsuleGeometry(0.34, 0.36, 4, 8), suit);
  hips.position.y = 0.94;
  root.add(hips);

  const torso = mesh(new THREE.CapsuleGeometry(0.38, 0.72, 5, 9), armor);
  torso.position.y = 1.55;
  torso.scale.set(1, 1, 0.72);
  root.add(torso);

  const chestStripe = mesh(new THREE.BoxGeometry(0.7, 0.12, 0.38), accentMaterial, { receive: false });
  chestStripe.position.set(0, 1.62, 0.25);
  chestStripe.rotation.z = -0.13;
  root.add(chestStripe);

  const pack = mesh(new THREE.BoxGeometry(0.52, 0.72, 0.24), suit);
  pack.position.set(0, 1.55, -0.36);
  root.add(pack);

  const neck = mesh(new THREE.CylinderGeometry(0.14, 0.15, 0.18, 8), skin);
  neck.position.y = 2.08;
  root.add(neck);
  const head = mesh(new THREE.SphereGeometry(0.31, 14, 11), skin);
  head.position.y = 2.35;
  head.scale.z = 0.88;
  root.add(head);
  const visor = mesh(new THREE.BoxGeometry(0.48, 0.17, 0.08), standard(0x11151C, { roughness: 0.18, metalness: 0.62 }));
  visor.position.set(0, 2.38, 0.27);
  root.add(visor);

  const leftArm = makeLimb(suit, 0.13, 0.68);
  const rightArm = makeLimb(suit, 0.13, 0.68);
  leftArm.position.set(-0.48, 1.87, 0);
  rightArm.position.set(0.48, 1.87, 0);
  leftArm.rotation.z = -0.08;
  rightArm.rotation.z = 0.08;
  root.add(leftArm, rightArm);

  const leftLeg = makeLimb(suit, 0.16, 0.74);
  const rightLeg = makeLimb(suit, 0.16, 0.74);
  leftLeg.position.set(-0.22, 0.93, 0);
  rightLeg.position.set(0.22, 0.93, 0);
  root.add(leftLeg, rightLeg);

  const leftBoot = mesh(new THREE.BoxGeometry(0.3, 0.2, 0.48), armor);
  const rightBoot = leftBoot.clone();
  leftBoot.position.set(-0.22, 0.12, 0.08);
  rightBoot.position.set(0.22, 0.12, 0.08);
  root.add(leftBoot, rightBoot);

  const scarf = mesh(new THREE.BoxGeometry(companion ? 0.12 : 0.18, 0.08, companion ? 0.82 : 1.18), accentMaterial, { receive: false });
  scarf.geometry.translate(0, 0, -0.46);
  scarf.position.set(companion ? 0.15 : 0.19, 2.02, -0.28);
  scarf.rotation.z = 0.08;
  root.add(scarf);

  root.userData.parts = { torso, head, leftArm, rightArm, leftLeg, rightLeg, scarf, visor };
  root.userData.accent = accentMaterial;
  root.userData.materials = [suit, armor, accentMaterial, skin];
  root.scale.setScalar(companion ? 0.84 : 0.96);
  return root;
}

function poseSurvivor(actor, { time, speed = 0, dash = 0, invulnerable = 0, companionPhase = null }){
  const p = actor.userData.parts;
  if(companionPhase !== null){
    const wave = Math.sin(time * 2.2 + companionPhase);
    p.leftArm.rotation.x = -0.4 + wave * 0.12;
    p.rightArm.rotation.x = -2.25 + wave * 0.32;
    p.rightArm.rotation.z = 0.28;
    p.leftLeg.rotation.x = p.rightLeg.rotation.x = 0;
  } else {
    const strideAmount = clamp(speed / 7, 0, 1);
    const stride = Math.sin(time * (7.5 + speed * 0.55)) * 0.68 * strideAmount;
    p.leftArm.rotation.z = -0.08;
    p.rightArm.rotation.z = 0.08;
    p.leftArm.rotation.x = -stride * 0.75 - dash * 0.45;
    p.rightArm.rotation.x = stride * 0.75 - dash * 0.45;
    p.leftLeg.rotation.x = stride;
    p.rightLeg.rotation.x = -stride;
    p.torso.rotation.x = dash * 0.22;
    p.scarf.rotation.x = -0.04 - strideAmount * 0.14 - dash * 0.2;
    p.scarf.rotation.y = Math.sin(time * 7) * 0.08;
  }
  actor.visible = true;
}

function buildCaldera(scene, lowfx){
  const basalt = standard(0x3A2D2E, { roughness: 0.94, metalness: 0.02 });
  const floor = mesh(new THREE.CircleGeometry(10.3, lowfx ? 48 : 72).rotateX(-Math.PI / 2), basalt, { cast: false });
  floor.position.y = -0.02;
  scene.add(floor);

  const boundaryWidth = ASHFALL_BOUNDS.maxX - ASHFALL_BOUNDS.minX;
  const boundaryDepth = ASHFALL_BOUNDS.maxZ - ASHFALL_BOUNDS.minZ;
  const boundaryCenterX = (ASHFALL_BOUNDS.minX + ASHFALL_BOUNDS.maxX) / 2;
  const boundaryCenterZ = (ASHFALL_BOUNDS.minZ + ASHFALL_BOUNDS.maxZ) / 2;
  const safeZone = mesh(
    new THREE.PlaneGeometry(boundaryWidth, boundaryDepth).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xFFB36F, transparent: true, opacity: 0.045, depthWrite: false }),
    { cast: false, receive: false },
  );
  safeZone.position.set(boundaryCenterX, 0.012, boundaryCenterZ);
  scene.add(safeZone);
  const boundary = new THREE.Group();
  const boundaryMaterial = standard(0xFF9A58, {
    emissive: 0xFF5A28,
    emissiveIntensity: 1.1,
    roughness: 0.38,
    metalness: 0.08,
  });
  const horizontal = new THREE.BoxGeometry(boundaryWidth + 0.12, 0.045, 0.09);
  const vertical = new THREE.BoxGeometry(0.09, 0.045, boundaryDepth + 0.12);
  for(const z of [ASHFALL_BOUNDS.minZ, ASHFALL_BOUNDS.maxZ]){
    const edge = mesh(horizontal, boundaryMaterial, { cast: false, receive: false });
    edge.position.set(boundaryCenterX, 0.04, z);
    boundary.add(edge);
  }
  for(const x of [ASHFALL_BOUNDS.minX, ASHFALL_BOUNDS.maxX]){
    const edge = mesh(vertical, boundaryMaterial, { cast: false, receive: false });
    edge.position.set(x, 0.04, boundaryCenterZ);
    boundary.add(edge);
  }
  scene.add(boundary);
  const random = seeded(0xA54F11);

  const plateGeometry = new THREE.CylinderGeometry(1.05, 1.2, 0.045, 6);
  const plateMaterial = standard(0x463638, { roughness: 0.98, flatShading: true });
  const plates = new THREE.InstancedMesh(plateGeometry, plateMaterial, lowfx ? 18 : 30);
  const plateMatrix = new THREE.Matrix4();
  const platePosition = new THREE.Vector3();
  const plateRotation = new THREE.Quaternion();
  const plateScale = new THREE.Vector3();
  for(let i = 0; i < plates.count; i += 1){
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * 7.3;
    platePosition.set(Math.cos(angle) * radius, 0.006, Math.sin(angle) * radius);
    plateRotation.setFromEuler(new THREE.Euler(0, random() * Math.PI, 0));
    const size = 0.58 + random() * 0.72;
    plateScale.set(size, 1, size * (0.7 + random() * 0.4));
    plateMatrix.compose(platePosition, plateRotation, plateScale);
    plates.setMatrixAt(i, plateMatrix);
  }
  plates.receiveShadow = true;
  scene.add(plates);

  const rimMaterial = standard(0x19171C, { roughness: 1, flatShading: true, side: THREE.DoubleSide });
  const segments = lowfx ? 30 : 46;
  const positions = [];
  const indices = [];
  for(let i = 0; i <= segments; i += 1){
    const angle = i / segments * Math.PI * 2;
    const wobble = 0.55 * Math.sin(angle * 5 + 0.7) + 0.4 * Math.sin(angle * 11);
    const inner = 9.7 + wobble * 0.22;
    const outer = 12.4 + wobble + random() * 0.7;
    const height = 2.2 + random() * 3.6;
    positions.push(Math.cos(angle) * inner, -0.35, Math.sin(angle) * inner);
    positions.push(Math.cos(angle) * outer, height, Math.sin(angle) * outer);
    if(i < segments){
      const base = i * 2;
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }
  const rimGeometry = new THREE.BufferGeometry();
  rimGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  rimGeometry.setIndex(indices);
  rimGeometry.computeVertexNormals();
  scene.add(mesh(rimGeometry, rimMaterial));

  const rockGeometry = new THREE.DodecahedronGeometry(0.7, 0);
  const rockMaterial = standard(0x302C31, { roughness: 1, flatShading: true });
  const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, lowfx ? 30 : 54);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  for(let i = 0; i < rocks.count; i += 1){
    const angle = random() * Math.PI * 2;
    const radius = 9.3 + random() * 3.1;
    position.set(Math.cos(angle) * radius, 0.2 + random() * 0.9, Math.sin(angle) * radius);
    quaternion.setFromEuler(new THREE.Euler(random() * 2, random() * 2, random() * 2));
    scale.set(0.55 + random() * 1.5, 0.6 + random() * 2.2, 0.55 + random() * 1.4);
    matrix.compose(position, quaternion, scale);
    rocks.setMatrixAt(i, matrix);
  }
  rocks.castShadow = !lowfx;
  rocks.receiveShadow = true;
  scene.add(rocks);

  const lavaMaterial = new THREE.MeshBasicMaterial({ color: 0xFF5A24, transparent: true, opacity: 0.72 });
  const lavaBedMaterial = standard(0x6B2318, { emissive: 0xE43E17, emissiveIntensity: 1.2, roughness: 0.5 });
  const fissures = [];
  for(let i = 0; i < 8; i += 1){
    const angle = i / 8 * Math.PI * 2 + 0.18;
    const side = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
    const points = [];
    for(let j = 0; j < 5; j += 1){
      const radius = 7.9 + j * 1.05;
      points.push(new THREE.Vector3(
        Math.cos(angle) * radius + side.x * Math.sin(j * 2.2 + i) * 0.5,
        0.035,
        Math.sin(angle) * radius + side.z * Math.sin(j * 2.2 + i) * 0.5,
      ));
    }
    const curve = new THREE.CatmullRomCurve3(points);
    const bed = mesh(new THREE.TubeGeometry(curve, lowfx ? 12 : 20, 0.16, 5, false), lavaBedMaterial, { cast: false, receive: false });
    const glow = mesh(new THREE.TubeGeometry(curve, lowfx ? 12 : 20, 0.07, 5, false), lavaMaterial, { cast: false, receive: false });
    scene.add(bed, glow);
    fissures.push(glow);
  }

  const ledgeMaterial = standard(0x363239, { roughness: 0.9, flatShading: true });
  const leftLedge = mesh(new THREE.CylinderGeometry(2.05, 2.55, 1.25, 7), ledgeMaterial);
  const rightLedge = leftLedge.clone();
  leftLedge.position.set(-7.8, 0.25, -4.75);
  rightLedge.position.set(7.8, 0.2, -4.55);
  scene.add(leftLedge, rightLedge);

  return { floor, safeZone, boundary, plates, rocks, fissures, ledges: [leftLedge, rightLedge] };
}

function makeHazardView(scene){
  const root = new THREE.Group();
  const telegraph = new THREE.Group();
  const disc = mesh(
    new THREE.CircleGeometry(1.2, 30).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xFF4A22, transparent: true, opacity: 0.16, depthWrite: false }),
    { cast: false, receive: false },
  );
  const ring = mesh(
    new THREE.RingGeometry(1.03, 1.24, 36).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xFFB05C, transparent: true, opacity: 0.82, depthWrite: false, side: THREE.DoubleSide }),
    { cast: false, receive: false },
  );
  const innerRing = mesh(
    new THREE.RingGeometry(0.43, 0.52, 28).rotateX(-Math.PI / 2),
    ring.material.clone(),
    { cast: false, receive: false },
  );
  const pillar = mesh(
    new THREE.CylinderGeometry(0.06, 0.26, 3.8, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xFF8A45, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }),
    { cast: false, receive: false },
  );
  pillar.position.y = 1.9;
  telegraph.add(disc, ring, innerRing, pillar);

  const meteor = new THREE.Group();
  const coreMaterial = standard(0x281A18, { emissive: 0xFF3816, emissiveIntensity: 1.5, roughness: 0.72, flatShading: true });
  const core = mesh(new THREE.DodecahedronGeometry(0.46, 1), coreMaterial);
  const halo = mesh(
    new THREE.SphereGeometry(0.68, 12, 9),
    new THREE.MeshBasicMaterial({ color: 0xFF6B2E, transparent: true, opacity: 0.2, depthWrite: false }),
    { cast: false, receive: false },
  );
  const tail = mesh(
    new THREE.ConeGeometry(0.5, 4.2, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xFF6A2B, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
    { cast: false, receive: false },
  );
  tail.position.y = 2.35;
  meteor.add(core, halo, tail);

  const shock = mesh(
    new THREE.RingGeometry(0.72, 0.98, 36).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xFF7A32, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    { cast: false, receive: false },
  );
  root.add(telegraph, meteor, shock);
  root.visible = false;
  scene.add(root);
  return { root, telegraph, disc, ring, innerRing, pillar, meteor, core, halo, tail, shock };
}

export function createAshfallScene({ scene, camera, renderer, lowfx = false } = {}){
  if(!scene || !camera || !renderer) throw new TypeError('scene, camera, and renderer are required');
  const world = buildCaldera(scene, lowfx);
  const player = buildAshfallSurvivor({ accent: 0xFF7138 });
  scene.add(player);

  const companions = [
    buildAshfallSurvivor({ accent: 0xE9B066, companion: true }),
    buildAshfallSurvivor({ accent: 0xC96B45, companion: true }),
  ];
  companions[0].position.set(-7.75, 1.0, -4.7);
  companions[1].position.set(7.75, 0.95, -4.5);
  companions[0].rotation.y = 0.72;
  companions[1].rotation.y = -0.72;
  scene.add(...companions);

  const rescueLight = new THREE.PointLight(0xFF7138, lowfx ? 10 : 18, 20, 2);
  rescueLight.position.set(0, 4.2, -6.8);
  scene.add(rescueLight);
  scene.add(new THREE.AmbientLight(0xE5A27A, lowfx ? 0.72 : 0.5));

  const target = mesh(
    new THREE.RingGeometry(0.34, 0.46, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xFFD08A, transparent: true, opacity: 0.62, depthWrite: false, side: THREE.DoubleSide }),
    { cast: false, receive: false },
  );
  target.position.y = 0.06;
  scene.add(target);

  const dashAura = mesh(
    new THREE.RingGeometry(0.48, 0.67, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xFFF1BD, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    { cast: false, receive: false },
  );
  scene.add(dashAura);

  const hitShield = mesh(
    new THREE.SphereGeometry(0.88, lowfx ? 14 : 22, lowfx ? 10 : 16),
    new THREE.MeshBasicMaterial({
      color: 0xFFE6A3,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
    { cast: false, receive: false },
  );
  hitShield.scale.y = 1.28;
  hitShield.visible = false;
  scene.add(hitShield);

  const hazardViews = Array.from({ length: lowfx ? 16 : 24 }, () => makeHazardView(scene));
  const embers = new Particles(scene, lowfx ? 90 : 190, true);
  const impacts = new Particles(scene, lowfx ? 80 : 170, true);
  const random = seeded(0xEEB311);
  let emberAccumulator = 0;
  let shake = 0;
  const look = new THREE.Vector3();
  const cameraTarget = new THREE.Vector3();
  const cameraPosition = new THREE.Vector3();

  function triggerEvents(events){
    for(const event of events){
      if(event.type === 'hit') shake = Math.max(shake, 0.85);
      else if(event.type === 'shielded') shake = Math.max(shake, 0.2);
      else if(event.type === 'near-miss') shake = Math.max(shake, 0.34);
      else if(event.type === 'impact') shake = Math.max(shake, 0.13);
      if(!['hit', 'shielded', 'near-miss', 'evade', 'impact'].includes(event.type)) continue;
      const count = lowfx ? 9 : 18;
      const color = event.type === 'shielded' ? [1, 0.88, 0.48] : event.type === 'hit' ? [1, 0.19, 0.06] : [1, 0.42, 0.12];
      for(let index = 0; index < count; index += 1){
        const angle = random() * Math.PI * 2;
        const speed = 2 + random() * 7;
        impacts.emit(event.x, 0.22, event.z, Math.cos(angle) * speed, 2 + random() * 7, Math.sin(angle) * speed, {
          life: 0.42 + random() * 0.46,
          size: 1.2 + random() * 2.1,
          grow: 0.5,
          alpha: 0.82,
          col: color,
          grav: 12,
        });
      }
    }
  }

  function updateHazards(snapshot, visualTime){
    for(let index = 0; index < hazardViews.length; index += 1){
      const view = hazardViews[index];
      const hazard = snapshot.hazards[index];
      if(!hazard){ view.root.visible = false; continue; }
      view.root.visible = true;
      view.root.position.set(hazard.x, 0.05, hazard.z);
      const timeToImpact = hazard.impactAt - snapshot.time;
      const afterImpact = snapshot.time - hazard.impactAt;
      const radiusScale = hazard.radiusScale ?? 1;
      if(timeToImpact > 0){
        const progress = clamp(1 - timeToImpact / hazard.lead, 0, 1);
        const pulse = 1 + Math.sin(visualTime * 12 + hazard.id) * 0.06;
        const warningScale = 0.82 + progress * 0.22;
        view.telegraph.visible = true;
        view.telegraph.scale.setScalar(warningScale * pulse * radiusScale);
        view.ring.material.opacity = 0.52 + progress * 0.42;
        view.innerRing.material.opacity = 0.38 + progress * 0.46;
        view.disc.material.opacity = 0.08 + progress * 0.26;
        view.pillar.material.opacity = 0.08 + progress * 0.2;
        view.pillar.scale.y = 0.65 + progress * 0.7;
        view.meteor.visible = true;
        const height = 0.48 + timeToImpact * hazard.meteorSpeed;
        view.meteor.position.set(timeToImpact * 4.4, height, -timeToImpact * 2.7);
        view.meteor.rotation.x = visualTime * 5 + hazard.id;
        view.meteor.rotation.z = visualTime * 3.8;
        view.halo.scale.setScalar(0.88 + Math.sin(visualTime * 15) * 0.08);
        view.shock.material.opacity = 0;
      } else {
        view.telegraph.visible = false;
        view.meteor.visible = false;
        const impactProgress = clamp(afterImpact / 0.72, 0, 1);
        view.shock.scale.setScalar((0.6 + impactProgress * 4.1) * radiusScale);
        view.shock.material.opacity = (1 - impactProgress) * 0.8;
      }
    }
  }

  function update(snapshot, { dt, time, mode }){
    const speed = Math.hypot(snapshot.vx, snapshot.vz);
    player.position.set(snapshot.x, 0.1, snapshot.z);
    player.rotation.y = Math.atan2(snapshot.facingX, snapshot.facingZ);
    poseSurvivor(player, { time, speed, dash: snapshot.dashDuration > 0 ? 1 : 0, invulnerable: snapshot.invulnerable });
    target.position.set(snapshot.targetX, 0.055, snapshot.targetZ);
    target.visible = mode === 'play';
    target.rotation.z = time * 0.55;
    const targetPulse = 1 + Math.sin(time * 5) * 0.08;
    target.scale.setScalar(targetPulse);
    dashAura.position.set(snapshot.x, 0.07, snapshot.z);
    dashAura.material.opacity = snapshot.dashDuration > 0 ? 0.72 : 0;
    dashAura.scale.setScalar(snapshot.dashDuration > 0 ? 1 + (0.24 - snapshot.dashDuration) * 6 : 1);
    const shieldActive = mode === 'play' && snapshot.invulnerable > 0;
    hitShield.visible = shieldActive;
    hitShield.position.set(snapshot.x, 1.18, snapshot.z);
    hitShield.rotation.y = time * 1.8;
    if(shieldActive){
      const shieldPulse = 1 + Math.sin(time * 12) * 0.045;
      hitShield.scale.set(0.96 * shieldPulse, 1.28 * shieldPulse, 0.96 * shieldPulse);
      hitShield.material.opacity = 0.28 + Math.sin(time * 15) * 0.07;
    } else hitShield.material.opacity = 0;

    companions[0].position.y = 1.0 + Math.sin(time * 1.8 + 0.2) * 0.025;
    companions[1].position.y = 0.95 + Math.sin(time * 1.8 + 2.4) * 0.025;
    poseSurvivor(companions[0], { time, companionPhase: 0.2 });
    poseSurvivor(companions[1], { time, companionPhase: 2.4 });
    if(mode === 'play') updateHazards(snapshot, time);
    else for(const view of hazardViews) view.root.visible = false;
    if(mode === 'finish'){
      player.userData.parts.leftArm.rotation.x = -2.45;
      player.userData.parts.rightArm.rotation.x = -2.45;
      player.userData.parts.leftArm.rotation.z = -0.3;
      player.userData.parts.rightArm.rotation.z = 0.3;
    } else if(mode === 'fail' || (mode === 'results' && snapshot.status === 'lost')){
      player.userData.parts.torso.rotation.x = 0.48;
      player.userData.parts.leftArm.rotation.x = -0.8;
      player.userData.parts.rightArm.rotation.x = -0.8;
      player.position.y = -0.08;
    }

    emberAccumulator += dt;
    const emberRate = lowfx ? 0.045 : 0.022;
    while(emberAccumulator >= emberRate){
      emberAccumulator -= emberRate;
      const angle = random() * Math.PI * 2;
      const radius = 7 + random() * 5;
      embers.emit(Math.cos(angle) * radius, random() * 1.2, Math.sin(angle) * radius,
        -0.25 + random() * 0.5, 0.8 + random() * 2.1, -0.25 + random() * 0.5, {
          life: 1.4 + random() * 2.4,
          size: 0.8 + random() * 1.6,
          grow: 0.2,
          alpha: 0.36 + random() * 0.4,
          col: [1, 0.29 + random() * 0.22, 0.08],
          grav: -0.12,
        });
    }
    embers.tick(dt);
    impacts.tick(dt);

    if(mode === 'title'){
      cameraPosition.set(11.8 + Math.sin(time * 0.17) * 0.8, 9.2, 14.8);
      cameraTarget.set(-2.6, 1.05, -0.5);
    } else if(mode === 'instructions' || mode === 'countdown'){
      cameraPosition.set(0, 11.8, 14.9);
      cameraTarget.set(0, 0.75, 0);
    } else if(mode === 'finish' || mode === 'fail' || mode === 'results'){
      cameraPosition.set(snapshot.x * 0.18 + 4.9, 6.4, snapshot.z + 9.2);
      cameraTarget.set(snapshot.x, 1.25, snapshot.z);
    } else {
      cameraPosition.set(snapshot.x * 0.17, 11.6, 14.4 + snapshot.z * 0.06);
      cameraTarget.set(snapshot.x * 0.28, 0.72, snapshot.z * 0.2);
    }
    camera.position.lerp(cameraPosition, 1 - Math.exp(-dt * 5.5));
    look.lerp(cameraTarget, 1 - Math.exp(-dt * 7));
    if(shake > 0){
      camera.position.x += (random() - 0.5) * shake * 0.5;
      camera.position.y += (random() - 0.5) * shake * 0.32;
      shake *= Math.exp(-dt * 8);
    }
    camera.lookAt(look);
  }

  camera.position.set(11.8, 9.2, 14.8);
  look.set(-0.7, 1.05, -0.5);
  camera.lookAt(look);

  return Object.freeze({
    update,
    triggerEvents,
    player,
    companions: Object.freeze(companions),
    world,
    get diagnostics(){
      return Object.freeze({
        hazardPool: hazardViews.length,
        visibleHazards: hazardViews.filter(view => view.root.visible).length,
        companions: companions.length,
        boundaryVisible: world.boundary.visible,
        shieldActive: hitShield.visible,
        lowfx,
      });
    },
  });
}
