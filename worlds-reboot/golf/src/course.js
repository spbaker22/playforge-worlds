/* Stackyard Golf — the dusk garden and its six holes. */
import * as THREE from 'three';
import { canvasTex, mulberry, mergeGeos, clamp } from '../../engine/util.js';
import { heightLocal } from './sim.js';
export { heightLocal, gradLocal } from './sim.js';

export const PAL = {
  zenith: 0x1E2650, violet: 0x6E4E96, horizon: 0xFF9E78, sunHot: 0xFFE2C4,
  fog: 0xC98A96,
  lawnLit: 0x8FAC66, lawnLow: 0x5A7A52, soil: 0x8A7E74, hollow: 0x5E5578,
  stone: 0x9A93A8, stoneDark: 0x6E687E, turf: 0x5E8C54, turfDark: 0x4A7248,
  hedge: 0x35543E, wood: 0x6E5240, lantern: 0xFFB870, bulb: 0xFFE6B8
};

/* ---------------- hole definitions (local frame: tee at 0,0, +z downrange) ---------------- */
export const HOLES = [
  { name: 'FIRST LIGHT', par: 2, base: 0.0, yaw: 1.62, org: [-47.5, 33.1],
    rects: [[-4, -3.5, 4, 17.5]],
    cup: [0.6, 13.8], tilt: [0.013, -0.005], mounds: [], steps: [], hedges: [], gate: null },
  { name: 'THE HEDGE', par: 3, base: 0.8, yaw: 0.42, org: [-69.1, -8.6],
    rects: [[-4, -3.5, 4, 19], [-4, 11, 17, 19]],
    cup: [13.6, 15], tilt: [-0.006, 0.008],
    mounds: [{ x: -1.5, z: 6, a: 0.45, s: 2.6 }],
    steps: [], hedges: [{ x: 1.6, z: 7.6, w: 4.6, d: 2.0 }], gate: null },
  { name: 'TWIN MOUNDS', par: 3, base: 1.6, yaw: -0.72, org: [-31.7, -56.2],
    rects: [[-4.5, -3.5, 4.5, 23]],
    cup: [0, 19.6], tilt: [0, 0.004],
    mounds: [{ x: -2.3, z: 12, a: 0.85, s: 2.2 }, { x: 2.5, z: 14.5, a: 0.85, s: 2.3 }],
    steps: [], hedges: [], gate: null },
  { name: 'THE TERRACE', par: 4, base: 1.0, yaw: -1.68, org: [24.5, -60.5],
    rects: [[-5, -3.5, 5, 31]],
    cup: [-1.2, 27], tilt: [0.004, 0],
    mounds: [], steps: [{ z0: 15.5, w: 3.4, h: 1.5 }], hedges: [], gate: null },
  { name: 'MOON GATE', par: 3, base: 0.6, yaw: -2.62, org: [63.4, -11.5],
    rects: [[-4.5, -3.5, 4.5, 23]],
    cup: [-0.4, 19.8], tilt: [-0.009, 0.003],
    mounds: [{ x: 0, z: 16.5, a: 0.35, s: 3.0 }],
    steps: [], hedges: [], gate: { z: 10.5, gap: 3.4 } },
  { name: 'FOUNTAIN TURN', par: 4, base: 0.2, yaw: 2.72, org: [41.8, 46.1],
    rects: [[-5, -3.5, 5, 21], [-5, 13, 22, 22.5]],
    cup: [18.4, 17.8], tilt: [0.005, 0.006],
    mounds: [{ x: -2, z: 16, a: 0.5, s: 2.8 }],
    steps: [], hedges: [{ x: 2.4, z: 9.0, w: 3.6, d: 1.8 }], gate: null }
];

/* wall segments per hole (local 2D), built from rect outlines + features */
function rectSegs(r){
  const [x1, z1, x2, z2] = r;
  return [[x1, z1, x2, z1], [x2, z1, x2, z2], [x2, z2, x1, z2], [x1, z2, x1, z1]];
}
/* union outline for the L-shaped holes was hand-checked; overlapping interior
   segments are fine for physics (ball is pushed out along the segment normal
   only when approaching from outside the union interior is impossible here
   because interior segments sit inside the hedge/wall visuals). We instead
   define explicit outlines: */
const OUTLINES = [
  [[-4,-3.5],[4,-3.5],[4,17.5],[-4,17.5]],
  [[-4,-3.5],[4,-3.5],[4,11],[17,11],[17,19],[-4,19]],
  [[-4.5,-3.5],[4.5,-3.5],[4.5,23],[-4.5,23]],
  [[-5,-3.5],[5,-3.5],[5,31],[-5,31]],
  [[-4.5,-3.5],[4.5,-3.5],[4.5,23],[-4.5,23]],
  [[-5,-3.5],[5,-3.5],[5,13],[22,13],[22,22.5],[-5,22.5]]
];
export function holeWalls(i){
  const o = OUTLINES[i], segs = [];
  for(let k = 0; k < o.length; k++){
    const a = o[k], b = o[(k + 1) % o.length];
    segs.push([a[0], a[1], b[0], b[1]]);
  }
  const h = HOLES[i];
  for(const hd of h.hedges){
    segs.push(...rectSegs([hd.x - hd.w/2, hd.z - hd.d/2, hd.x + hd.w/2, hd.z + hd.d/2]));
  }
  if(h.gate){
    const g = h.gate, W = holeHalfWidth(i);
    segs.push([-W, g.z, -g.gap/2, g.z]);
    segs.push([g.gap/2, g.z, W, g.z]);
  }
  return segs;
}
function holeHalfWidth(i){ return Math.abs(OUTLINES[i][0][0]); }

/* world<->local */
export function frames(){
  return HOLES.map(h => {
    const cos = Math.cos(h.yaw), sin = Math.sin(h.yaw);
    return {
      toLocal(wx, wz, out = null){
        const dx = wx - h.org[0], dz = wz - h.org[1];
        const lx = dx * cos - dz * sin, lz = dx * sin + dz * cos;
        if(out){ out[0] = lx; out[1] = lz; return out; }
        return [lx, lz];
      },
      toWorld(lx, lz){
        return [h.org[0] + lx * cos + lz * sin, h.org[1] + (-lx * sin + lz * cos)];
      },
      yaw: h.yaw, base: h.base
    };
  });
}

/* ---------------- textures ---------------- */
function turfTex(){
  const t = canvasTex(512, 512, (g, w, hh) => {
    g.fillStyle = '#6E9A60'; g.fillRect(0, 0, w, hh);
    /* mowing stripes */
    for(let i = 0; i < 8; i++){
      g.fillStyle = i % 2 ? 'rgba(255,240,210,0.05)' : 'rgba(20,40,26,0.08)';
      g.fillRect(0, i * hh/8, w, hh/8);
    }
    for(let i = 0; i < 2400; i++){
      const v = Math.random();
      g.fillStyle = v < 0.5 ? 'rgba(46,80,44,0.35)' : 'rgba(150,190,110,0.22)';
      g.fillRect(Math.random()*w, Math.random()*hh, 1.6, 2.4);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function stoneTex(){
  const t = canvasTex(256, 256, (g, w, hh) => {
    g.fillStyle = '#8E8798'; g.fillRect(0, 0, w, hh);
    for(let i = 0; i < 300; i++){
      const v = 120 + Math.random()*50|0;
      g.fillStyle = `rgba(${v},${v-6},${v+10},0.5)`;
      g.fillRect(Math.random()*w, Math.random()*hh, 3, 3);
    }
    g.strokeStyle = 'rgba(40,34,52,0.55)'; g.lineWidth = 2;
    for(let y = 0; y < hh; y += 34){
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      for(let x = (y/34)%2 ? 22 : 0; x < w; x += 44){
        g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 34); g.stroke();
      }
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function bannerTex(text, sub){
  return canvasTex(1024, 192, (g, w, hh) => {
    g.fillStyle = '#201430'; g.fillRect(0, 0, w, hh);
    g.fillStyle = '#FF5C29'; g.fillRect(0, 0, w, 10); g.fillRect(0, hh-10, w, 10);
    g.font = '800 88px -apple-system, Helvetica, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#FFF4E4'; g.fillText(text, w/2, hh/2 - (sub ? 14 : 0));
    if(sub){ g.font = '600 30px -apple-system, Helvetica, Arial'; g.fillStyle = '#FFD98A'; g.fillText(sub, w/2, hh/2 + 56); }
  });
}
function blossomTex(){
  return canvasTex(64, 64, (g, w, hh) => {
    g.clearRect(0, 0, w, hh);
    const cols = ['#E8A8C8', '#F2D8E0', '#C8A8E8'];
    for(let i = 0; i < 9; i++){
      g.fillStyle = cols[i % 3];
      const x = w*0.5 + (Math.random()-0.5)*w*0.7, y = hh*0.5 + (Math.random()-0.5)*hh*0.7;
      g.beginPath(); g.arc(x, y, 4 + Math.random()*5, 0, 7); g.fill();
    }
  });
}

/* ---------------- build ---------------- */
export function buildCourse(scene, dressing = true){
  const rnd = mulberry(20260713);
  const group = new THREE.Group(); scene.add(group);
  const F = frames();
  const turf = turfTex(), stone = stoneTex();
  const lanternPts = [];   /* world positions of lantern heads for the roving light */
  const cupWorld = [];

  /* terrain: rolling lawn, flattened aprons at pads + fountain, path tinting */
  {
    const SIZE = 1400, SEG = 150;
    const g = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG); g.rotateX(-Math.PI/2);
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    const cLit = new THREE.Color(PAL.lawnLit), cLow = new THREE.Color(PAL.lawnLow),
          cSoil = new THREE.Color(PAL.soil), cHol = new THREE.Color(PAL.hollow);
    /* garden paths: fountain -> each tee (color only) */
    const paths = HOLES.map(h => [[0, 0], h.org]);
    const c = new THREE.Color();
    for(let i = 0; i < p.count; i++){
      const x = p.getX(i), z = p.getZ(i);
      let hgt = 2.6 * Math.sin(x * 0.011 + 1.2) * Math.cos(z * 0.009 + 0.5)
              + 1.2 * Math.sin(x * 0.031 + 3.1) * Math.sin(z * 0.027 + 1.1);
      const dc = Math.hypot(x, z);
      hgt += THREE.MathUtils.smoothstep(dc, 180, 620) * (10 + 26 * Math.sin(x*0.004 + 2) * Math.sin(z*0.0035 + 4) * 0.5 + 14);
      /* flatten near pads */
      let flat = 0, flatY = 0;
      HOLES.forEach((h, hi) => {
        const [lx, lz] = F[hi].toLocal(x, z);
        let dR = 1e9;
        for(const r of h.rects){
          const dx = Math.max(r[0] - lx, 0, lx - r[2]);
          const dz = Math.max(r[1] - lz, 0, lz - r[3]);
          dR = Math.min(dR, Math.hypot(dx, dz));
        }
        const w = 1 - THREE.MathUtils.smoothstep(dR, 2, 10);
        if(w > flat){ flat = w; flatY = h.base - 0.07; }
      });
      const wf = 1 - THREE.MathUtils.smoothstep(dc, 6, 18);
      if(wf > flat){ flat = wf; flatY = -0.3; }
      const y = THREE.MathUtils.lerp(hgt, flatY, flat);
      p.setY(i, y);
      /* color */
      c.copy(cLow).lerp(cLit, clamp(0.5 + y * 0.05 + Math.sin(x * 0.05 + z * 0.045) * 0.10, 0, 1));
      let dPath = 1e9;
      for(const [a, b] of paths){
        const abx = b[0]-a[0], abz = b[1]-a[1];
        const t = clamp(((x-a[0])*abx + (z-a[1])*abz) / (abx*abx + abz*abz), 0, 1);
        dPath = Math.min(dPath, Math.hypot(x - (a[0]+abx*t), z - (a[1]+abz*t)));
      }
      if(dPath < 2.1) c.lerp(cSoil, 0.55 * (1 - dPath/2.1));
      if(y < -0.8) c.lerp(cHol, 0.4);
      if(y > 9) c.lerp(cHol, clamp((y - 9)/30, 0, 0.5));
      col[i*3] = c.r; col[i*3+1] = c.g; col[i*3+2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const terr = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    terr.receiveShadow = true;
    group.add(terr);
  }

  /* hole pads: turf top + stone walls + cup + flag */
  const flags = [];
  HOLES.forEach((h, hi) => {
    const fr = F[hi];
    const hold = new THREE.Group();
    hold.position.set(h.org[0], h.base, h.org[1]);
    hold.rotation.y = h.yaw;

    /* turf: one grid per rect, heights from heightLocal */
    for(const r of h.rects){
      const w = r[2] - r[0], d = r[3] - r[1];
      const gg = new THREE.PlaneGeometry(w, d, Math.ceil(w*2), Math.ceil(d*2));
      gg.rotateX(-Math.PI/2);
      gg.translate(r[0] + w/2, 0, r[1] + d/2);
      const pp = gg.attributes.position;
      for(let i = 0; i < pp.count; i++){
        pp.setY(i, heightLocal(h, pp.getX(i), pp.getZ(i)));
      }
      gg.computeVertexNormals();
      const uv = gg.attributes.uv;
      for(let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w/6, uv.getY(i) * d/6);
      const m = new THREE.Mesh(gg, new THREE.MeshStandardMaterial({
        map: turf, color: 0xE0ECC8, roughness: 0.85, metalness: 0 }));
      m.receiveShadow = true;
      hold.add(m);
    }

    /* stone border walls */
    const segs = holeWalls(hi);
    const wallM = new THREE.MeshStandardMaterial({ map: stone, roughness: 0.8, metalness: 0.05 });
    for(const [x1, z1, x2, z2] of segs){
      const len = Math.hypot(x2 - x1, z2 - z1);
      if(len < 0.01) continue;
      const midx = (x1 + x2)/2, midz = (z1 + z2)/2;
      const yb = heightLocal(h, midx, midz);
      const wt = stone.clone(); wt.needsUpdate = true; wt.repeat.set(Math.max(1, len / 2.6), 1);
      const wallMat = new THREE.MeshStandardMaterial({ map: wt, roughness: 0.8, metalness: 0.05 });
      const wall = new THREE.Mesh(new THREE.BoxGeometry(len + 0.5, 0.72, 0.5), wallMat);
      wall.position.set(midx, yb + 0.22, midz);
      wall.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      wall.castShadow = true; wall.receiveShadow = true;
      hold.add(wall);
    }
    /* corner posts + lantern on the cup-side corner */
    const o = OUTLINES[hi];
    o.forEach((pt, k) => {
      const yb = heightLocal(h, pt[0], pt[1]);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 1.05, 8),
        new THREE.MeshStandardMaterial({ map: stone, roughness: 0.75 }));
      post.position.set(pt[0], yb + 0.4, pt[1]);
      post.castShadow = true;
      hold.add(post);
      if(k === 2){ /* lantern post at a far corner */
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 3.1, 6),
          new THREE.MeshStandardMaterial({ color: 0x2A2434, roughness: 0.6, metalness: 0.5 }));
        pole.position.set(pt[0], yb + 2.0, pt[1]);
        hold.add(pole);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.30, 10, 8),
          new THREE.MeshBasicMaterial({ color: PAL.bulb }));
        head.position.set(pt[0], yb + 3.55, pt[1]);
        hold.add(head);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.44, 0.3, 8),
          new THREE.MeshStandardMaterial({ color: 0x2A2434, roughness: 0.6 }));
        cap.position.set(pt[0], yb + 3.86, pt[1]);
        hold.add(cap);
        const wpos = fr.toWorld(pt[0], pt[1]);
        lanternPts.push(new THREE.Vector3(wpos[0], h.base + heightLocal(h, pt[0], pt[1]) + 3.5, wpos[1]));
      }
    });

    /* hedges */
    for(const hd of h.hedges){
      const yb = heightLocal(h, hd.x, hd.z);
      const hg = new THREE.Mesh(new THREE.BoxGeometry(hd.w, 1.15, hd.d),
        new THREE.MeshStandardMaterial({ color: PAL.hedge, roughness: 0.92 }));
      hg.position.set(hd.x, yb + 0.5, hd.z);
      hg.castShadow = true;
      hold.add(hg);
      /* rounded top pass */
      const topg = new THREE.Mesh(new THREE.CylinderGeometry(hd.d/2, hd.d/2, hd.w, 10).rotateZ(Math.PI/2),
        new THREE.MeshStandardMaterial({ color: PAL.hedge, roughness: 0.92 }));
      topg.position.set(hd.x, yb + 1.05, hd.z);
      topg.castShadow = true;
      hold.add(topg);
    }

    /* moon gate */
    if(h.gate){
      const yb = heightLocal(h, 0, h.gate.z);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(h.gate.gap/2 + 0.35, 0.32, 10, 40),
        new THREE.MeshStandardMaterial({ map: stone, roughness: 0.75 }));
      ring.position.set(0, yb + h.gate.gap/2 + 0.15, h.gate.z);
      ring.castShadow = true;
      hold.add(ring);
      const W = holeHalfWidth(hi);
      for(const s of [-1, 1]){
        const len = W - h.gate.gap/2;
        const stub = new THREE.Mesh(new THREE.BoxGeometry(len, 0.72, 0.5), wallM);
        stub.position.set(s * (h.gate.gap/2 + len/2), yb + 0.24, h.gate.z);
        stub.castShadow = true;
        hold.add(stub);
      }
    }

    /* cup: dark disc + glowing rim + flag */
    {
      const cy = heightLocal(h, h.cup[0], h.cup[1]);
      const hole = new THREE.Mesh(new THREE.CircleGeometry(0.52, 24).rotateX(-Math.PI/2),
        new THREE.MeshBasicMaterial({ color: 0x0A0810 }));
      hole.position.set(h.cup[0], cy + 0.02, h.cup[1]);
      hold.add(hole);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.045, 8, 28).rotateX(-Math.PI/2),
        new THREE.MeshBasicMaterial({ color: 0xFFD98A }));
      rim.position.set(h.cup[0], cy + 0.035, h.cup[1]);
      hold.add(rim);
      flags.push({ rim, hi });
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.7, 6),
        new THREE.MeshStandardMaterial({ color: 0xF2ECD8, roughness: 0.4, metalness: 0.3 }));
      pole.position.set(h.cup[0], cy + 1.35, h.cup[1]);
      pole.castShadow = true;
      hold.add(pole);
      const flagT = canvasTex(128, 80, (g) => {
        g.fillStyle = '#FF5C29'; g.fillRect(0, 0, 128, 80);
        g.fillStyle = '#FFF4E4'; g.font = '800 52px -apple-system, Helvetica';
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(hi + 1), 64, 44);
      });
      const clothM = new THREE.MeshStandardMaterial({ map: flagT, roughness: 0.8 });
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.65, 8, 3), clothM);
      cloth.position.set(h.cup[0] + 0.55, cy + 2.32, h.cup[1]);
      hold.add(cloth);
      const clothB = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.65, 8, 3), clothM);
      clothB.position.copy(cloth.position); clothB.rotation.y = Math.PI;
      hold.add(clothB);
      flags[flags.length - 1].cloth = cloth;
      flags[flags.length - 1].clothB = clothB;
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xFFE6B8 }));
      tip.position.set(h.cup[0], cy + 2.74, h.cup[1]);
      hold.add(tip);
      const cw = fr.toWorld(h.cup[0], h.cup[1]);
      cupWorld.push(new THREE.Vector3(cw[0], h.base + cy, cw[1]));
    }

    /* tee marker: two small glowing studs */
    for(const s of [-0.8, 0.8]){
      const stud = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.14, 8),
        new THREE.MeshBasicMaterial({ color: 0x9FE8C8 }));
      stud.position.set(s, heightLocal(h, s, 0) + 0.08, 0);
      hold.add(stud);
    }

    group.add(hold);
  });

  if(dressing){
  /* fountain at the garden heart */
  {
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 6.6, 1.0, 24),
      new THREE.MeshStandardMaterial({ map: stone, roughness: 0.7 }));
    basin.position.set(0, 0.2, 0); basin.castShadow = true; basin.receiveShadow = true;
    group.add(basin);
    const water = new THREE.Mesh(new THREE.CircleGeometry(5.6, 24).rotateX(-Math.PI/2),
      new THREE.MeshStandardMaterial({ color: 0x2E4E6E, roughness: 0.08, metalness: 0.4, envMapIntensity: 1.5 }));
    water.position.set(0, 0.62, 0);
    group.add(water);
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 2.2, 12),
      new THREE.MeshStandardMaterial({ map: stone, roughness: 0.7 }));
    column.position.set(0, 1.4, 0); column.castShadow = true;
    group.add(column);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.2, 0.5, 14),
      new THREE.MeshStandardMaterial({ map: stone, roughness: 0.7 }));
    bowl.position.set(0, 2.6, 0); bowl.castShadow = true;
    group.add(bowl);
  }

  /* cypress sentinels */
  {
    const geo = mergeGeos([
      new THREE.ConeGeometry(1.35, 6.4, 8).translate(0, 3.7, 0),
      new THREE.CylinderGeometry(0.16, 0.22, 1.0, 6).translate(0, 0.5, 0)
    ]);
    const COUNT = 64;
    const inst = new THREE.InstancedMesh(geo,
      new THREE.MeshStandardMaterial({ color: 0x3E5E44, roughness: 0.92 }), COUNT);
    const d = new THREE.Object3D(); let n = 0, guard = 0;
    while(n < COUNT && guard++ < 900){
      const a = rnd() * Math.PI * 2, r = 30 + rnd() * 150;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      let ok = Math.hypot(x, z) > 24;
      for(let hi = 0; hi < HOLES.length && ok; hi++){
        const [lx, lz] = F[hi].toLocal(x, z);
        for(const rr of HOLES[hi].rects){
          if(lx > rr[0] - 14 && lx < rr[2] + 14 && lz > rr[1] - 14 && lz < rr[3] + 14){ ok = false; break; }
        }
      }
      if(!ok) continue;
      d.position.set(x, 0, z);
      d.rotation.y = rnd() * Math.PI * 2;
      const s = 0.55 + rnd() * 0.6; d.scale.set(s, s * (0.9 + rnd() * 0.4), s);
      d.updateMatrix(); inst.setMatrixAt(n++, d.matrix);
    }
    inst.count = n; inst.castShadow = true;
    group.add(inst);
  }


  /* round canopy trees (no long shadow slabs — castShadow off) */
  {
    const geo = mergeGeos([
      new THREE.SphereGeometry(2.4, 9, 7).translate(0, 4.3, 0),
      new THREE.SphereGeometry(1.7, 8, 6).translate(1.3, 3.3, 0.5),
      new THREE.CylinderGeometry(0.3, 0.42, 2.6, 6).translate(0, 1.2, 0)
    ]);
    const COUNT = 34;
    const inst = new THREE.InstancedMesh(geo,
      new THREE.MeshStandardMaterial({ color: 0x466E4C, roughness: 0.9 }), COUNT);
    const d = new THREE.Object3D(); let n = 0, guard = 0;
    while(n < COUNT && guard++ < 600){
      const a = rnd() * Math.PI * 2, r = 36 + rnd() * 130;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      let ok = Math.hypot(x, z) > 26;
      for(let hi = 0; hi < HOLES.length && ok; hi++){
        const [lx, lz] = F[hi].toLocal(x, z);
        for(const rr of HOLES[hi].rects){
          if(lx > rr[0] - 7 && lx < rr[2] + 7 && lz > rr[1] - 7 && lz < rr[3] + 7){ ok = false; break; }
        }
      }
      if(!ok) continue;
      d.position.set(x, 0, z);
      d.rotation.y = rnd() * Math.PI * 2;
      const s = 0.7 + rnd() * 0.8; d.scale.set(s, s, s);
      d.updateMatrix(); inst.setMatrixAt(n++, d.matrix);
    }
    inst.count = n;
    group.add(inst);
  }

  /* blossom drifts near pads */
  {
    const q = new THREE.PlaneGeometry(1.6, 1.0); q.translate(0, 0.4, 0);
    const g2 = q.clone().rotateY(Math.PI/2);
    const geo = mergeGeos([q, g2]);
    const COUNT = 130;
    const inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
      map: blossomTex(), alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.9 }), COUNT);
    const d = new THREE.Object3D(); let n = 0, guard = 0;
    while(n < COUNT && guard++ < 1300){
      const hi = (rnd() * HOLES.length) | 0;
      const h = HOLES[hi];
      const r = h.rects[(rnd() * h.rects.length) | 0];
      const side = rnd() < 0.5;
      const lx = side ? r[0] - 0.9 - rnd() * 1.6 : r[2] + 0.9 + rnd() * 1.6;
      const lz = r[1] + 1.2 + rnd() * (r[3] - r[1] - 2.4);
      const [x, z] = F[hi].toWorld(lx, lz);
      d.position.set(x, h.base - 0.12, z);
      d.rotation.y = rnd() * Math.PI;
      const s = 0.35 + rnd() * 0.4; d.scale.set(s, s, s);
      d.updateMatrix(); inst.setMatrixAt(n++, d.matrix);
    }
    inst.count = n;
    group.add(inst);
  }

  /* string lights: perimeter posts + sagging bulb runs */
  {
    const posts = [];
    const R = 40;
    for(let i = 0; i < 11; i++){
      const a = i / 11 * Math.PI * 2 + 0.3;
      posts.push(new THREE.Vector3(Math.cos(a) * (R + 13 * Math.sin(i * 2.3)), 0, Math.sin(a) * (R + 13 * Math.cos(i * 1.7))));
    }
    const poleG = new THREE.CylinderGeometry(0.1, 0.14, 4.4, 6);
    const poleM = new THREE.MeshStandardMaterial({ color: 0x2A2434, roughness: 0.6, metalness: 0.5 });
    const polesI = new THREE.InstancedMesh(poleG, poleM, posts.length);
    const d = new THREE.Object3D();
    posts.forEach((p, i) => {
      d.position.set(p.x, 2.2, p.z); d.rotation.set(0, 0, 0);
      d.updateMatrix(); polesI.setMatrixAt(i, d.matrix);
    });
    polesI.castShadow = true;
    group.add(polesI);
    /* bulbs along catenaries */
    const per = 15;
    const bulbG = new THREE.SphereGeometry(0.10, 6, 5);
    const bulbM = new THREE.MeshBasicMaterial({ color: PAL.bulb });
    const bulbs = new THREE.InstancedMesh(bulbG, bulbM, posts.length * per);
    let bi = 0;
    for(let i = 0; i < posts.length; i++){
      const a = posts[i], b = posts[(i + 1) % posts.length];
      for(let k = 1; k <= per; k++){
        const t = k / (per + 1);
        const x = THREE.MathUtils.lerp(a.x, b.x, t);
        const z = THREE.MathUtils.lerp(a.z, b.z, t);
        const y = 4.35 - Math.sin(t * Math.PI) * 1.1;
        d.position.set(x, y, z); d.updateMatrix();
        bulbs.setMatrixAt(bi++, d.matrix);
      }
    }
    group.add(bulbs);
  }

  /* banner arch over hole 1 tee */
  {
    const fr = F[0];
    const [ax, az] = fr.toWorld(0, -6);
    const hold = new THREE.Group();
    hold.position.set(ax, HOLES[0].base, az);
    hold.rotation.y = HOLES[0].yaw;
    const pylM = new THREE.MeshStandardMaterial({ color: 0x241C2E, roughness: 0.55, metalness: 0.4 });
    for(const s of [-1, 1]){
      const py = new THREE.Mesh(new THREE.BoxGeometry(0.8, 7.6, 0.8), pylM);
      py.position.set(s * 7.5, 3.8, 0);
      hold.add(py);
    }
    const banM = new THREE.MeshStandardMaterial({ map: bannerTex('STACKYARD GOLF', 'PLAYFORGE GARDEN CLUB'), roughness: 0.7 });
    for(const dir of [0, Math.PI]){
      const ban = new THREE.Mesh(new THREE.PlaneGeometry(13.2, 2.2), banM);
      ban.position.set(0, 6.2, dir ? 0.03 : -0.03);
      ban.rotation.y = dir;
      hold.add(ban);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(16, 1.0, 0.8), pylM);
    beam.position.set(0, 7.5, 0);
    hold.add(beam);
    group.add(hold);
  }

  /* floating paper lanterns in the distance */
  {
    const geo = new THREE.SphereGeometry(1.4, 10, 8);
    for(let i = 0; i < 7; i++){
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: i % 2 ? 0xFFB870 : 0xFF9A88, transparent: true, opacity: 0.9 }));
      const a = rnd() * Math.PI * 2, r = 160 + rnd() * 260;
      m.position.set(Math.cos(a) * r, 18 + rnd() * 50, Math.sin(a) * r);
      m.userData = { v: 0.5 + rnd() * 0.8, ph: rnd() * 6 };
      paperLanterns.push(m);
      group.add(m);
    }
  }
  } /* dressing */

  return { group, flags, lanternPts, cupWorld, F };
}

const paperLanterns = [];
export function tickCourse(dt, t, flags){
  for(const l of paperLanterns){
    l.position.y += l.userData.v * dt;
    l.position.x += Math.sin(t * 0.4 + l.userData.ph) * dt * 0.8;
    if(l.position.y > 120) l.position.y = 12;
  }
  for(const f of flags){
    for(const cl of [f.cloth, f.clothB]){
      if(!cl) continue;
      const pp = cl.geometry.attributes.position;
      for(let i = 0; i < pp.count; i++){
        const x = pp.getX(i);
        pp.setZ(i, Math.sin(x * 4.2 + t * 5.2) * 0.05 * (Math.abs(x) + 0.55));
      }
      pp.needsUpdate = true;
    }
    f.rim.material.color.setHSL(0.11, 0.75, 0.62 + 0.13 * Math.sin(t * 2.4));
  }
}
