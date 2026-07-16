/* Playforge engine — shared utilities (from the Sundown Mesa benchmark). */
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const $ = id => document.getElementById(id);
export const clamp = THREE.MathUtils.clamp;
export const lerp = THREE.MathUtils.lerp;
export const smoothstep = THREE.MathUtils.smoothstep;
export const ease = x => x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x);
export const ORD = ['1ST', '2ND', '3RD', '4TH'];

export function mulberry(seed){
  return function(){ seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export function fmt(ms){
  const s = ms / 1000, m = Math.floor(s / 60);
  const r = (s - m * 60).toFixed(2);
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/* smooth-normal hero geometry: the non-negotiable for extruded silhouettes */
export function smooth(g){
  let m = mergeVertices(g, 1e-3);
  m.computeVertexNormals();
  return m;
}

export function canvasTex(w, h, draw){
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/* standard URL params every world honors */
export function readParams(){
  const Q = new URLSearchParams(location.search);
  return {
    Q,
    AUTO: Q.has('auto'),
    FAST: Q.has('fast') || (Q.has('auto') && !Q.has('cine')),
    WARP: Math.min(parseInt(Q.get('warp') || '1', 10) || 1, 10),
    FREEZE: Q.has('freeze') ? parseFloat(Q.get('freeze')) : null,
    LOWFX: Q.has('lowfx')
  };
}

/* merge a list of BufferGeometries (positions+index, optional uv) into one */
export function mergeGeos(geos){
  let posA = [], uvA = [], idxA = [], base = 0, hasUV = true;
  for(const q of geos){
    posA = posA.concat([...q.attributes.position.array]);
    if(q.attributes.uv) uvA = uvA.concat([...q.attributes.uv.array]); else hasUV = false;
    idxA = idxA.concat([...q.index.array].map(v => v + base));
    base += q.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
  if(hasUV && uvA.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(uvA, 2));
  g.setIndex(idxA);
  g.computeVertexNormals();
  return g;
}
