/* LOW TIDE — procedural night-harbor stage. */
import * as THREE from 'three';

const TAU = Math.PI * 2;
const ink = 0x07151c;
const navy = 0x0b2630;
const steel = 0x29434a;
const cream = 0xf1ddbb;
const amber = 0xe3a861;
const red = 0xc85f4b;
const green = 0x6aa392;

function rng(seed){
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function mesh(geometry, material, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, cast = false, receive = false } = {}){
  const result = new THREE.Mesh(geometry, material);
  result.position.set(x, y, z);
  result.rotation.set(rx, ry, rz);
  result.castShadow = cast;
  result.receiveShadow = receive;
  return result;
}

function box(w, h, d, material, options){ return mesh(new THREE.BoxGeometry(w, h, d), material, options); }
function cylinder(radius, height, material, options, radial = 12){ return mesh(new THREE.CylinderGeometry(radius, radius, height, radial), material, options); }

function makeCanvasTexture(draw, size = 128){
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeGlowSprite(color = '#e9b06c', scale = 3){
  const texture = makeCanvasTexture((ctx, size) => {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.16, `${color}bb`);
    gradient.addColorStop(0.48, `${color}32`);
    gradient.addColorStop(1, `${color}00`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  });
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  sprite.scale.setScalar(scale);
  return sprite;
}

function makeMoonSprite(){
  const texture = makeCanvasTexture((ctx, size) => {
    const center = size / 2;
    const gradient = ctx.createRadialGradient(center * 0.82, center * 0.72, size * 0.05, center, center, size * 0.45);
    gradient.addColorStop(0, '#eee9d4');
    gradient.addColorStop(0.72, '#d8d4bd');
    gradient.addColorStop(0.94, '#c6c5b5');
    gradient.addColorStop(1, 'rgba(198,197,181,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath(); ctx.arc(center, center, size * 0.45, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = '#4d5754';
    for(const [x, y, r] of [[.37,.33,.07],[.61,.29,.04],[.58,.57,.08],[.32,.63,.04],[.69,.68,.035]]){
      ctx.beginPath(); ctx.arc(size * x, size * y, size * r, 0, TAU); ctx.fill();
    }
  }, 256);
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false }));
  moon.scale.set(9.8, 9.8, 1);
  return moon;
}

function makePerson(scale = 1, coatColor = 0x17282d){
  const group = new THREE.Group();
  const coat = new THREE.MeshStandardMaterial({ color: coatColor, roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: 0x9e7159, roughness: 0.85 });
  const body = mesh(new THREE.CapsuleGeometry(0.23 * scale, 0.72 * scale, 4, 8), coat, { y: 1.18 * scale, cast: true });
  const head = mesh(new THREE.SphereGeometry(0.22 * scale, 10, 8), skin, { y: 1.92 * scale, cast: true });
  const cap = mesh(new THREE.SphereGeometry(0.235 * scale, 10, 6, 0, TAU, 0, Math.PI * 0.48), coat, { y: 2.05 * scale, cast: true });
  const leftArm = cylinder(0.075 * scale, 0.66 * scale, coat, { x: -0.28 * scale, y: 1.35 * scale, rz: -0.55, cast: true }, 8);
  const rightArm = cylinder(0.075 * scale, 0.66 * scale, coat, { x: 0.28 * scale, y: 1.35 * scale, rz: 0.55, cast: true }, 8);
  group.add(body, head, cap, leftArm, rightArm);
  group.userData.arms = [leftArm, rightArm];
  return group;
}

function makeHull({ length = 9, width = 3.8, color = 0x243d43, trim = 0xd3b276 } = {}){
  const group = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.12 });
  const trimMat = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.55, metalness: 0.16 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x0b171b, roughness: 0.86 });
  const body = mesh(new THREE.CapsuleGeometry(width * 0.5, length - width, 5, 12), hullMat, { rx: Math.PI / 2, y: 0.05, cast: true, receive: true });
  body.scale.set(1, 1, 0.5);
  const gunwaleL = box(0.14, 0.18, length * 0.78, trimMat, { x: -width * 0.46, y: 0.58, z: 0.24, cast: true });
  const gunwaleR = box(0.14, 0.18, length * 0.78, trimMat, { x: width * 0.46, y: 0.58, z: 0.24, cast: true });
  const deck = box(width * 0.78, 0.16, length * 0.54, darkMat, { y: 0.54, z: 0.55, receive: true });
  group.add(body, gunwaleL, gunwaleR, deck);
  return group;
}

function makeRivalBoat({ name, color, lightColor, side, z }){
  const boat = new THREE.Group();
  boat.add(makeHull({ length: 6.8, width: 2.7, color, trim: 0xb8a77f }));
  const cabinMat = new THREE.MeshStandardMaterial({ color: 0x304951, roughness: 0.66 });
  const windowMat = new THREE.MeshBasicMaterial({ color: 0xdca55e });
  boat.add(box(1.8, 1.3, 1.7, cabinMat, { y: 1.16, z: 1.15, cast: true }));
  boat.add(box(1.48, 0.47, 0.08, windowMat, { y: 1.38, z: 0.26 }));
  const person = makePerson(0.72, name === 'MARA' ? 0x6d4a3e : 0x314b58);
  person.position.set(side * 0.42, 0.55, -1.25);
  boat.add(person);
  const nav = mesh(new THREE.SphereGeometry(0.10, 8, 6), new THREE.MeshBasicMaterial({ color: lightColor }), { x: side * 1.12, y: 1.0, z: -1.8 });
  const glow = makeGlowSprite(lightColor === red ? '#d96a55' : '#6eb39e', 2.2);
  glow.position.copy(nav.position);
  boat.add(nav, glow);
  boat.position.set(side * (name === 'MARA' ? 13 : 16), 0.05, z);
  boat.rotation.y = side * 0.16;
  boat.userData.baseY = boat.position.y;
  boat.userData.person = person;
  boat.userData.name = name;
  return boat;
}

function makeFishShadow(){
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color: 0x071c23, transparent: true, opacity: 0.72, depthWrite: false });
  const body = mesh(new THREE.SphereGeometry(0.62, 12, 8), material);
  body.scale.set(1.55, 0.28, 0.64);
  const tail = mesh(new THREE.ConeGeometry(0.45, 0.82, 3), material, { x: -1.05, ry: -Math.PI / 2 });
  group.add(body, tail);
  group.position.y = -0.32;
  group.visible = false;
  return group;
}

function makeBuoy(x, z, color){
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.68 });
  const metal = new THREE.MeshStandardMaterial({ color: steel, roughness: 0.56, metalness: 0.34 });
  group.add(mesh(new THREE.SphereGeometry(0.42, 10, 8), bodyMat, { y: 0.13, cast: true }));
  group.add(cylinder(0.05, 1.15, metal, { y: 0.75 }, 8));
  const lamp = mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color }), { y: 1.36 });
  const glow = makeGlowSprite(color === red ? '#c85f4b' : '#6aa392', 1.4);
  glow.position.y = 1.36;
  group.add(lamp, glow);
  group.position.set(x, 0, z);
  group.userData.base = { x, z };
  return group;
}

function addStars(scene, count){
  const random = rng(1127);
  const positions = new Float32Array(count * 3);
  for(let i = 0; i < count; i += 1){
    const angle = random() * TAU;
    const radius = 75 + random() * 80;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = 18 + random() * 54;
    positions[i * 3 + 2] = -35 - random() * 95;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const stars = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xa8b9b6, size: 0.2, sizeAttenuation: true, transparent: true, opacity: 0.7, depthWrite: false }));
  scene.add(stars);
}

function addSkyline(scene, quality){
  const random = rng(8042);
  const buildingMat = new THREE.MeshStandardMaterial({ color: 0x0c2027, roughness: 1 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x122b32, roughness: 0.9 });
  const lit = new THREE.MeshBasicMaterial({ color: 0xc88b4c });
  const unlit = new THREE.MeshBasicMaterial({ color: 0x132d33 });
  const count = quality === 'performance' ? 18 : 28;
  for(let i = 0; i < count; i += 1){
    const x = -48 + i * (96 / (count - 1));
    const width = 2.1 + random() * 3.8;
    const height = 3 + random() * 8.5;
    const depth = 3 + random() * 4;
    scene.add(box(width, height, depth, buildingMat, { x, y: height / 2 - 0.3, z: -66 + random() * 5, receive: true }));
    if(i % 4 === 0) scene.add(box(width * 0.82, 0.3, depth * 0.88, roofMat, { x, y: height - 0.08, z: -66 + random() * 5 }));
    if(i % 3 !== 0){
      const rows = Math.max(1, Math.floor(height / 2.2));
      for(let row = 0; row < rows; row += 1){
        for(let col = -1; col <= 1; col += 2){
          scene.add(box(0.18, 0.30, 0.03, random() > 0.38 ? lit : unlit, { x: x + col * width * 0.25, y: 1 + row * 1.65, z: -62.25 }));
        }
      }
    }
  }
}

function addHarborWorks(scene){
  const timber = new THREE.MeshStandardMaterial({ color: 0x342a24, roughness: 0.96 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x263b40, roughness: 0.65, metalness: 0.26 });
  const lampMat = new THREE.MeshBasicMaterial({ color: amber });
  // Right-side working pier creates an asymmetric frame and readable depth.
  scene.add(box(17, 0.8, 36, timber, { x: 32, y: 0.45, z: -21, receive: true }));
  for(let z = -4; z >= -39; z -= 5.6){
    scene.add(cylinder(0.34, 5.5, timber, { x: 24, y: -1.6, z, receive: true }, 10));
    scene.add(cylinder(0.34, 5.5, timber, { x: 40, y: -1.6, z, receive: true }, 10));
  }
  for(let i = 0; i < 4; i += 1){
    const z = -7 - i * 8.5;
    scene.add(cylinder(0.09, 4.3, iron, { x: 24.8, y: 2.3, z }, 8));
    scene.add(box(1.0, 0.12, 0.12, iron, { x: 24.35, y: 4.35, z }));
    const lamp = mesh(new THREE.SphereGeometry(0.12, 8, 6), lampMat, { x: 23.9, y: 4.18, z });
    const glow = makeGlowSprite('#e3a861', 2.8);
    glow.position.copy(lamp.position);
    scene.add(lamp, glow);
  }
  // Container and small crane silhouettes.
  const containerA = new THREE.MeshStandardMaterial({ color: 0x5a4034, roughness: 0.88 });
  const containerB = new THREE.MeshStandardMaterial({ color: 0x31515a, roughness: 0.88 });
  scene.add(box(6, 2.5, 2.4, containerA, { x: 31, y: 2.05, z: -25, cast: true }));
  scene.add(box(5.4, 2.4, 2.4, containerB, { x: 34.2, y: 2.0, z: -20, cast: true }));
  scene.add(cylinder(0.18, 12, iron, { x: 36, y: 6.4, z: -35 }, 10));
  const boom = box(0.28, 0.28, 15, iron, { x: 30.5, y: 11.7, z: -35, ry: Math.PI / 2, rz: -0.16 });
  scene.add(boom);
}

export function waterHeight(x, z, time){
  return Math.sin(x * 0.18 + time * 0.82) * 0.075 + Math.sin(z * 0.24 - time * 0.58) * 0.055;
}

export function buildHarbor(scene, { quality = 'balanced' } = {}){
  scene.background = new THREE.Color(ink);
  scene.fog = new THREE.FogExp2(0x0a1a21, 0.012);
  const performance = quality === 'performance';

  const hemi = new THREE.HemisphereLight(0x688a91, 0x081014, 1.55);
  scene.add(hemi);
  const moonLight = new THREE.DirectionalLight(0x9eb8ba, 2.25);
  moonLight.position.set(-22, 32, 18);
  moonLight.castShadow = !performance;
  moonLight.shadow.mapSize.set(performance ? 512 : 1024, performance ? 512 : 1024);
  moonLight.shadow.camera.left = -28; moonLight.shadow.camera.right = 28;
  moonLight.shadow.camera.top = 25; moonLight.shadow.camera.bottom = -20;
  scene.add(moonLight);
  const deckLight = new THREE.PointLight(amber, 42, 26, 2);
  deckLight.position.set(-3.5, 4.8, 7.5);
  scene.add(deckLight);

  addStars(scene, performance ? 180 : 380);
  const moon = makeMoonSprite();
  moon.position.set(-23, 31, -72);
  scene.add(moon);
  const moonGlow = makeGlowSprite('#d9d4bc', 19);
  moonGlow.position.set(-23, 31, -73);
  scene.add(moonGlow);

  const waterGeometry = new THREE.PlaneGeometry(130, 150, performance ? 28 : 52, performance ? 28 : 52);
  waterGeometry.rotateX(-Math.PI / 2);
  const waterMaterial = new THREE.ShaderMaterial({
    transparent: false,
    uniforms: { uTime: { value: 0 }, uMoon: { value: new THREE.Vector3(-23, 31, -72) } },
    vertexShader: `
      uniform float uTime;
      varying float vWave; varying vec3 vWorld;
      void main(){
        vec3 p = position;
        float a = sin(p.x*.18 + uTime*.82)*.075;
        float b = sin(p.z*.24 - uTime*.58)*.055;
        float c = sin((p.x+p.z)*.07 + uTime*.36)*.045;
        p.y += a+b+c; vWave = a+b+c;
        vec4 world = modelMatrix*vec4(p,1.0); vWorld=world.xyz;
        gl_Position=projectionMatrix*viewMatrix*world;
      }`,
    fragmentShader: `
      uniform float uTime; varying float vWave; varying vec3 vWorld;
      void main(){
        float lines = pow(max(0.0, sin(vWorld.z*.55 + vWorld.x*.16 + uTime*.75)), 18.0);
        float moonPath = exp(-abs(vWorld.x+8.0)*.08) * smoothstep(-58.0,-2.0,-vWorld.z);
        vec3 deep=vec3(.009,.050,.064); vec3 crest=vec3(.026,.118,.132);
        vec3 col=mix(deep,crest,clamp(vWave*3.8+.28,0.0,1.0));
        col += vec3(.24,.22,.16)*lines*moonPath*.36;
        gl_FragColor=vec4(col,1.0);
      }`,
  });
  const water = mesh(waterGeometry, waterMaterial, { y: 0, z: -35, receive: true });
  scene.add(water);

  addSkyline(scene, quality);
  addHarborWorks(scene);

  const playerBoat = makeHull({ length: 11.8, width: 5.2, color: 0x2b474d, trim: 0xd0ad72 });
  playerBoat.position.set(0, 0.1, 10.5);
  playerBoat.rotation.y = -0.015;
  scene.add(playerBoat);
  const consoleMat = new THREE.MeshStandardMaterial({ color: 0x20373c, roughness: 0.68 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x31555b, roughness: 0.2, transmission: 0.18, transparent: true, opacity: 0.8 });
  playerBoat.add(box(2.4, 1.35, 1.8, consoleMat, { x: 1.1, y: 1.25, z: 2.0, cast: true }));
  playerBoat.add(box(2.0, 0.52, 0.08, glassMat, { x: 1.1, y: 1.54, z: 1.07 }));
  const player = makePerson(1.08, 0x5a3f36);
  player.position.set(-1.25, 0.64, -1.2);
  player.rotation.y = -0.08;
  playerBoat.add(player);

  const rod = new THREE.Group();
  rod.position.set(-1.2, 2.1, -1.3);
  playerBoat.add(rod);
  const rodMat = new THREE.MeshStandardMaterial({ color: 0x242728, roughness: 0.48, metalness: 0.32 });
  const rodShaft = cylinder(0.045, 5.6, rodMat, { y: 2.65, rz: -0.22, cast: true }, 8);
  rod.add(rodShaft);
  const rodTip = new THREE.Object3D();
  rodTip.position.set(-0.61, 5.35, 0);
  rod.add(rodTip);
  const reel = mesh(new THREE.TorusGeometry(0.25, 0.075, 8, 16), new THREE.MeshStandardMaterial({ color: amber, roughness: 0.38, metalness: 0.5 }), { x: 0.15, y: 0.8, rz: Math.PI / 2, cast: true });
  rod.add(reel);

  const mara = makeRivalBoat({ name: 'MARA', color: 0x4d3b35, lightColor: red, side: -1, z: -18 });
  const elias = makeRivalBoat({ name: 'ELIAS', color: 0x274752, lightColor: green, side: 1, z: -29 });
  scene.add(mara, elias);

  const buoyA = makeBuoy(-7.5, -13, red);
  const buoyB = makeBuoy(9.5, -38, green);
  scene.add(buoyA, buoyB);

  const fishShadow = makeFishShadow();
  scene.add(fishShadow);

  const objects = { playerBoat, rod, rodShaft, rodTip, reel, player, rivals: [mara, elias], buoys: [buoyA, buoyB], fishShadow };
  function update(time, { phase = 'aim', tension = 0, reelHeld = false, bobber = null, fishFight = 0.5 } = {}){
    waterMaterial.uniforms.uTime.value = time;
    playerBoat.position.y = 0.1 + Math.sin(time * 0.82) * 0.052;
    playerBoat.rotation.z = Math.sin(time * 0.47) * 0.008;
    rod.rotation.x = -0.18 - tension * 0.12 + Math.sin(time * 1.8) * 0.01;
    rod.rotation.z = reelHeld ? Math.sin(time * 9) * 0.018 : 0;
    player.userData.arms[0].rotation.z = -0.55 - tension * 0.22;
    player.userData.arms[1].rotation.z = 0.55 + (reelHeld ? Math.sin(time * 8) * 0.12 : 0);
    for(let i = 0; i < objects.rivals.length; i += 1){
      const rival = objects.rivals[i];
      rival.position.y = rival.userData.baseY + Math.sin(time * (0.62 + i * 0.12) + i) * 0.11;
      rival.rotation.z = Math.sin(time * 0.43 + i * 1.4) * 0.018;
      rival.userData.person.userData.arms[1].rotation.z = 0.55 + Math.sin(time * 1.5 + i) * 0.18;
    }
    for(let i = 0; i < objects.buoys.length; i += 1){
      const buoy = objects.buoys[i];
      buoy.position.y = waterHeight(buoy.position.x, buoy.position.z, time);
      buoy.rotation.z = Math.sin(time * 0.75 + i) * 0.055;
    }
    fishShadow.visible = Boolean(bobber && (phase === 'waiting' || phase === 'bite' || phase === 'reeling'));
    if(fishShadow.visible){
      const orbit = phase === 'reeling' ? 0.45 : 1.2;
      fishShadow.position.set(
        bobber.x + Math.sin(time * (1.4 + fishFight)) * orbit,
        -0.28,
        bobber.z + Math.cos(time * (1.1 + fishFight)) * orbit,
      );
      fishShadow.rotation.y = -time * (0.9 + fishFight * 0.45);
      fishShadow.scale.setScalar(0.76 + fishFight * 0.62);
    }
  }

  return Object.freeze({ ...objects, water, waterMaterial, update });
}
