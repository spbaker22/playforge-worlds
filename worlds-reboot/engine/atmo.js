/* Playforge engine — parameterized atmosphere: gradient sky w/ sun (or moon)
   disc + corona, optional stars, fog, key/fill/hemi rig, lens flare, billboard
   clouds, silhouette haze ranges, PMREM environment. Generalized from the
   Sundown Mesa benchmark env.js. */
import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { canvasTex } from './util.js';

export function makeSkyMat({ sunDir, zenith, violet, horizon, sunHot, stars = 0, sunDisc = 1, coronaPow = 90 }){
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      sunDir: { value: sunDir.clone() },
      cZen: { value: new THREE.Color(zenith) },
      cVio: { value: new THREE.Color(violet) },
      cHor: { value: new THREE.Color(horizon) },
      cSun: { value: new THREE.Color(sunHot) },
      uStars: { value: stars },
      uDisc: { value: sunDisc },
      uCorona: { value: coronaPow }
    },
    vertexShader: `
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        vec4 p = modelViewMatrix * vec4(position,1.0);
        gl_Position = (projectionMatrix * p).xyww; /* pin to far plane */
      }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 sunDir, cZen, cVio, cHor, cSun;
      uniform float uStars, uDisc, uCorona;
      float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      void main(){
        float h = clamp(vDir.y, -0.08, 1.0);
        float sunAmt = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        vec3 col = mix(cHor, cVio, smoothstep(0.0, 0.28, h));
        col = mix(col, cZen, smoothstep(0.22, 0.75, h));
        float sunSide = pow(sunAmt, 3.0) * (1.0 - smoothstep(0.0, 0.4, h));
        col = mix(col, cSun * 0.9 + cHor * 0.3, sunSide * 0.75);
        float disc = smoothstep(0.9994, 0.99985, sunAmt) * uDisc;
        float corona = pow(sunAmt, uCorona) * 0.85 + pow(sunAmt, 14.0) * 0.2;
        col += cSun * (disc * 2.4 + corona * uDisc);
        /* star field above the haze, fading toward the horizon */
        if(uStars > 0.001){
          vec2 sp = vDir.xz / max(vDir.y + 0.28, 0.05);
          vec2 cell = floor(sp * 90.0);
          float star = step(0.9975, hash21(cell));
          float tw = 0.55 + 0.45 * sin(hash21(cell + 7.0) * 6.283 + vDir.x * 40.0);
          col += vec3(0.92, 0.95, 1.0) * star * tw * uStars * smoothstep(0.06, 0.4, h) * (1.0 - sunSide);
        }
        float band = 1.0 - smoothstep(0.0, 0.10, abs(vDir.y - 0.012));
        col = mix(col, cHor * 1.06, band * 0.5);
        gl_FragColor = vec4(col, 1.0);
      }`
  });
}

function flareTex(draw, size = 128){
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function discTex(inner, outer, size = 128){
  return flareTex((g, s) => {
    const r = g.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
    r.addColorStop(0, inner); r.addColorStop(1, outer);
    g.fillStyle = r; g.fillRect(0, 0, s, s);
  }, size);
}
function ringTex(col){
  return flareTex((g, s) => {
    g.strokeStyle = col; g.lineWidth = s * 0.05;
    const r = g.createRadialGradient(s/2, s/2, s*0.30, s/2, s/2, s*0.46);
    r.addColorStop(0, 'rgba(0,0,0,0)'); r.addColorStop(0.75, col); r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r; g.beginPath(); g.arc(s/2, s/2, s*0.46, 0, 7); g.fill();
  });
}
function cloudTex(warmRGBA, coolRGBA){
  return flareTex((g, s) => {
    g.clearRect(0,0,s,s);
    for(let i=0;i<26;i++){
      const x = s*0.5 + (Math.random()-0.5)*s*0.72;
      const y = s*0.55 + (Math.random()-0.5)*s*0.3;
      const rr = s*(0.06+Math.random()*0.13);
      const r = g.createRadialGradient(x,y,0,x,y,rr);
      const warm = Math.random()<0.5;
      r.addColorStop(0, warm?warmRGBA:coolRGBA);
      r.addColorStop(1, 'rgba(255,214,180,0)');
      g.fillStyle=r; g.beginPath(); g.arc(x,y,rr,0,7); g.fill();
    }
  }, 256);
}

/* cfg: full palette + rig control. See callers for concrete palettes. */
export function buildAtmosphere(scene, renderer, cfg){
  const {
    sunDir,
    sky,                                  /* {zenith,violet,horizon,sunHot,stars?,sunDisc?,coronaPow?} */
    fog = { color: 0xE09A6A, density: 0.00115 },
    key = { color: 0xFFD9A0, intensity: 3.4, shadowBox: 95, mapSize: 2048 },
    fill = { color: 0x7E8CD0, intensity: 0.62 },
    hemi = { sky: 0x9AA8E4, ground: 0x8A5A3E, intensity: 0.8 },
    flare = null,                         /* {glow:'rgba..', warm:'rgba..', ring:'rgba..', dot:'rgba..'} or null */
    clouds = null,                        /* {count, tintA, tintB, warm:'rgba..', cool:'rgba..', rMin, rSpan, yMin, ySpan, op} */
    ranges = [],                          /* [{radius, height, color, seedMul, blend}] */
    horizonBlend = 0.35
  } = cfg;

  const skyMat = makeSkyMat({ sunDir, ...sky });
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(4000, 40, 24), skyMat);
  skyMesh.frustumCulled = false;
  scene.add(skyMesh);

  scene.fog = new THREE.FogExp2(fog.color, fog.density);

  const sun = new THREE.DirectionalLight(key.color, key.intensity);
  sun.position.copy(sunDir).multiplyScalar(900);
  sun.castShadow = true;
  sun.shadow.mapSize.set(key.mapSize, key.mapSize);
  const sc = sun.shadow.camera;
  sc.near = 200; sc.far = 1600;
  const B = key.shadowBox;
  sc.left = -B; sc.right = B; sc.top = B; sc.bottom = -B;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.9;
  scene.add(sun); scene.add(sun.target);

  const fillL = new THREE.DirectionalLight(fill.color, fill.intensity);
  fillL.position.copy(sunDir.clone().multiplyScalar(-1).setY(0.5).normalize().multiplyScalar(600));
  scene.add(fillL);
  const hemiL = new THREE.HemisphereLight(hemi.sky, hemi.ground, hemi.intensity);
  scene.add(hemiL);

  if(flare){
    const fl = new Lensflare();
    const cGlow = discTex(flare.glow, flare.glowOut || 'rgba(255,170,90,0)');
    const cWarm = discTex(flare.warm, flare.warmOut || 'rgba(255,140,70,0)');
    const cRing = ringTex(flare.ring);
    const cDot  = discTex(flare.dot, flare.dotOut || 'rgba(255,180,110,0)', 64);
    fl.addElement(new LensflareElement(cGlow, flare.size || 520, 0));
    fl.addElement(new LensflareElement(cWarm, 190, 0.02));
    fl.addElement(new LensflareElement(cDot, 60, 0.35));
    fl.addElement(new LensflareElement(cRing, 140, 0.55));
    fl.addElement(new LensflareElement(cDot, 90, 0.8));
    fl.addElement(new LensflareElement(cRing, 240, 1.05));
    const holder = new THREE.Mesh(new THREE.SphereGeometry(1,4,4), new THREE.MeshBasicMaterial({visible:false}));
    holder.position.copy(sunDir).multiplyScalar(3200);
    holder.add(fl);
    scene.add(holder);
  }

  const cloudArr = [];
  if(clouds){
    const ct = cloudTex(clouds.warm || 'rgba(255,214,180,0.16)', clouds.cool || 'rgba(248,226,240,0.15)');
    for(let i=0;i<(clouds.count ?? 9);i++){
      const m = new THREE.SpriteMaterial({ map: ct, transparent: true, depthWrite: false, fog: false,
        opacity: (clouds.op ?? 0.5) + Math.random()*0.3, color: i%2 ? (clouds.tintA ?? 0xFFD9C0) : (clouds.tintB ?? 0xF2D8EE) });
      const s = new THREE.Sprite(m);
      const a = Math.random()*Math.PI*2;
      const r = (clouds.rMin ?? 2300) + Math.random()*(clouds.rSpan ?? 900);
      const y = (clouds.yMin ?? 160) + Math.random()*(clouds.ySpan ?? 520);
      s.position.set(Math.cos(a)*r, y, Math.sin(a)*r);
      const w = 700 + Math.random()*900;
      s.scale.set(w, w*0.34, 1);
      s.userData.v = 2 + Math.random()*3;
      scene.add(s); cloudArr.push(s);
    }
  }

  const horizonCol = new THREE.Color(sky.horizon);
  function range(radius, height, color, seedMul, blend){
    const N = 90, pos = [], idx = [], col = [];
    const cTop = new THREE.Color(color).lerp(horizonCol, blend ?? horizonBlend);
    const cBot = new THREE.Color(color);
    for(let i=0;i<=N;i++){
      const a = i/N*Math.PI*2;
      const h = height*(0.45+0.55*Math.abs(Math.sin(a*seedMul)+0.6*Math.sin(a*seedMul*2.7+2.2)));
      const x = Math.cos(a)*radius, z = Math.sin(a)*radius;
      pos.push(x,-30,z, x,h,z);
      col.push(cBot.r,cBot.g,cBot.b, cTop.r,cTop.g,cTop.b);
      if(i<N){ const k=i*2; idx.push(k,k+1,k+2, k+1,k+3,k+2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col,3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors:true, fog:false, side:THREE.DoubleSide }));
    scene.add(m);
    return m;
  }
  for(const r of ranges) range(r.radius, r.height, r.color, r.seedMul, r.blend);

  /* PMREM environment from the sky shader so PBR picks up the palette */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(80, 32, 18), makeSkyMat({ sunDir, ...sky })));
  const envRT = pmrem.fromScene(envScene, 0.06);
  scene.environment = envRT.texture;
  pmrem.dispose();

  return { sky: skyMesh, sun, clouds: cloudArr,
    tick(dt, camX, camZ){
      for(const c of cloudArr){ c.position.x += c.userData.v*dt; }
      skyMesh.position.set(camX, 0, camZ);
    },
    /* keep the tight ortho shadow box on the player every frame */
    followShadow(x, y, z){
      sun.position.set(x + sunDir.x*520, y + sunDir.y*520, z + sunDir.z*520);
      sun.target.position.set(x, y, z);
    }
  };
}
