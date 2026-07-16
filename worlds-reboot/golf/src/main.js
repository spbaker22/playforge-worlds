/* STACKYARD GOLF — dusk garden putting. Playforge cinematic reboot. */
import * as THREE from 'three';
import '../../engine/base.css';
import { createPipeline } from '../../engine/post.js';
import { buildAtmosphere } from '../../engine/atmo.js';
import { Particles } from '../../engine/fx.js';
import * as SFX from '../../engine/sfx.js';
import { SpringCam, orbit } from '../../engine/cam.js';
import { setScreenActive, auditInactiveScreenHits, auditInactiveScreenState } from '../../engine/screen.js';
import { createFixedStepRunner } from '../../engine/fixed-step.js';
import { createStateTrace } from '../../engine/trace.js';
import { $, clamp, lerp, ease, ORD, readParams } from '../../engine/util.js';
import { PAL, HOLES, holeWalls, heightLocal, buildCourse, tickCourse } from './course.js';
import { createGolfAimController } from './aim.js';
import { createGolfFlow } from './flow.js';
import {
  AIM_GUIDE_LIFT,
  AIM_GUIDE_SEGMENTS,
  AIM_GUIDE_WIDTH,
  shotPowerFromSpeed,
  shotSpeedFromPower,
  terrainHeightAtWorld,
  writeTerrainGuidePositions,
} from './putting.js';
import { createGolfRivalRound, createGolfRivalRoundKey } from './rivals.js';
import { copyBallState, stepGolfBall } from './sim.js';
import {
  golfFormatLabel,
  golfRoundHoles,
  mountPreviewGameChrome,
  readPreviewOptions,
} from '../../preview/options.js';

const P = readParams();
let AUTO = P.AUTO, WARP = P.WARP, FREEZE = P.FREEZE;
const PREVIEW_MODE = P.Q.get('preview') === '1';
const PREVIEW_OPTIONS = readPreviewOptions();
const FAST = P.FAST;
const LOWFX = P.LOWFX || (PREVIEW_MODE && PREVIEW_OPTIONS.quality === 'performance');
const LEGACY_START_HOLE = Math.min(Math.max(parseInt(P.Q.get('hole') || '1', 10) || 1, 1), 6) - 1;
const ROUND_HOLES = Object.freeze(PREVIEW_MODE
  ? golfRoundHoles(PREVIEW_OPTIONS)
  : Array.from({ length: 6 - LEGACY_START_HOLE }, (_, index) => LEGACY_START_HOLE + index));
const START_HOLE = ROUND_HOLES[0];
const RIVAL_MODE = PREVIEW_MODE ? PREVIEW_OPTIONS.golf.rivals : 'standard';
const RIVAL_ROUND_KEY = createGolfRivalRoundKey({
  preview: PREVIEW_MODE,
  format: PREVIEW_MODE ? PREVIEW_OPTIONS.golf.format : `legacy-${LEGACY_START_HOLE + 1}`,
  practiceHole: PREVIEW_MODE ? PREVIEW_OPTIONS.golf.practiceHole : LEGACY_START_HOLE + 1,
  cupAssist: PREVIEW_MODE ? PREVIEW_OPTIONS.golf.cupAssist : 'standard',
  rivals: RIVAL_MODE,
  holes: ROUND_HOLES,
});
const CUP_RULES = Object.freeze(PREVIEW_MODE && PREVIEW_OPTIONS.golf.cupAssist === 'family'
  ? { cupCaptureRadius: 0.54, cupCaptureMaxSpeed: 6.0, cupLipRadius: 0.68 }
  : { cupCaptureRadius: 0.40, cupCaptureMaxSpeed: 4.6, cupLipRadius: 0.58 });
SFX.setMuted(PREVIEW_MODE && PREVIEW_OPTIONS.sound === 'off');

/* ---------------- pipeline + atmosphere ---------------- */
const pipe = createPipeline({
  canvas: $('gl'), lowfx: LOWFX, exposure: 1.13,
  bloom: { strength: 0.42, radius: 0.6, threshold: 0.82 },
  vignette: 0.36, clear: 0x141227
});
const { renderer, scene, camera, composer, grade } = pipe;

const sunDir = new THREE.Vector3(-0.42, 0.225, -0.89).normalize();
const atmo = buildAtmosphere(scene, renderer, {
  sunDir,
  sky: { zenith: PAL.zenith, violet: PAL.violet, horizon: PAL.horizon, sunHot: PAL.sunHot, stars: 0.55, coronaPow: 120 },
  fog: { color: 0xC48490, density: 0.0013 },
  key: { color: 0xFFC698, intensity: 3.3, shadowBox: 60, mapSize: LOWFX ? 1024 : 2048 },
  fill: { color: 0x8E9AD8, intensity: 0.8 },
  hemi: { sky: 0x8E86D8, ground: 0x587048, intensity: 1.15 },
  flare: { glow: 'rgba(255,226,196,1)', warm: 'rgba(255,170,120,0.5)', ring: 'rgba(255,150,120,0.25)', dot: 'rgba(255,210,170,0.45)', size: 430 },
  clouds: { count: 8, tintA: 0xF2C8D8, tintB: 0xC8B8E8, warm: 'rgba(255,200,190,0.15)', cool: 'rgba(230,214,255,0.14)', yMin: 190, ySpan: 420, op: 0.42 },
  ranges: [
    { radius: 1050, height: 150, color: 0x50446A, seedMul: 4 },
    { radius: 720, height: 90, color: 0x3A5448, seedMul: 6 }
  ]
});

const course = buildCourse(scene, true);
const F = course.F;
const WALLS = HOLES.map((h, i) => holeWalls(i));

/* roving lantern light near the current hole */
const lantern = new THREE.PointLight(0xFFB870, LOWFX ? 14 : 26, 32, 2);
scene.add(lantern);
const lanternTarget = new THREE.Vector3();

/* ---------------- ball + aim visuals ---------------- */
const BALL_R = 0.34;
const ball = new THREE.Group();
{
  const core = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 22, 18),
    new THREE.MeshPhysicalMaterial({ color: 0xFFF8EC, metalness: 0.05, roughness: 0.24, clearcoat: 0.8, clearcoatRoughness: 0.2, envMapIntensity: 1.2 }));
  core.castShadow = true;
  ball.add(core);
  ball.userData.core = core;
}
scene.add(ball);
const glowDisc = new THREE.Mesh(new THREE.CircleGeometry(0.9, 26).rotateX(-Math.PI/2),
  new THREE.MeshBasicMaterial({ color: 0xFFD98A, transparent: true, opacity: 0.0, depthWrite: false }));
scene.add(glowDisc);

const aimGrp = new THREE.Group(); scene.add(aimGrp);
const shaftPositions = new Float32Array((AIM_GUIDE_SEGMENTS + 1) * 2 * 3);
const shaftIndices = new Uint16Array(AIM_GUIDE_SEGMENTS * 6);
for(let segment = 0; segment < AIM_GUIDE_SEGMENTS; segment += 1){
  const vertex = segment * 2, offset = segment * 6;
  shaftIndices.set([vertex, vertex + 2, vertex + 1, vertex + 1, vertex + 2, vertex + 3], offset);
}
const shaftGeo = new THREE.BufferGeometry();
shaftGeo.setAttribute('position', new THREE.BufferAttribute(shaftPositions, 3).setUsage(THREE.DynamicDrawUsage));
shaftGeo.setIndex(new THREE.BufferAttribute(shaftIndices, 1));
const shaft = new THREE.Mesh(shaftGeo,
  new THREE.MeshBasicMaterial({ color: 0xFFE2B0, transparent: true, opacity: 0.8, depthTest: true, depthWrite: false, side: THREE.DoubleSide }));
shaft.frustumCulled = false;
const tipGeo = new THREE.BufferGeometry();
const tipPositions = new Float32Array(9);
tipGeo.setAttribute('position', new THREE.BufferAttribute(tipPositions, 3).setUsage(THREE.DynamicDrawUsage));
tipGeo.setIndex([0, 1, 2]);
const tipM = new THREE.Mesh(tipGeo,
  new THREE.MeshBasicMaterial({ color: 0xFF9A50, transparent: true, opacity: 0.95, depthTest: true, depthWrite: false, side: THREE.DoubleSide }));
tipM.frustumCulled = false;
aimGrp.add(shaft); aimGrp.add(tipM);
const powRing = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.80, 40).rotateX(-Math.PI/2),
  new THREE.MeshBasicMaterial({ color: 0xFFC96B, transparent: true, opacity: 0, depthTest: true, depthWrite: false, side: THREE.DoubleSide }));
scene.add(powRing);
aimGrp.visible = false;

/* particles */
const fireflies = new Particles(scene, LOWFX ? 120 : 300, true);
const sparkTrail = new Particles(scene, 140, false);
const fountainJet = new Particles(scene, 160, true);

/* ---------------- state ---------------- */
const st = {
  hole: START_HOLE, strokes: 0, total: 0,
  x: 0, z: 0, y: 0, vx: 0, vz: 0, v: 0,
  card: HOLES.map(() => 0), rollT: 0, sunkT: 0, aimT: 0, thru: 0,
  lie: null, lastShotOrigin: null,
};
const game = {
  timescale: 1,
  introT: 0,
  cameraReady: false,
  lastResetReason: 'boot',
  lastLieReason: 'boot',
};
let previewPaused = false;
const RIVALS = [
  { name: 'MOSS', total: 0 },
  { name: 'DREA', total: 0 },
  { name: 'JUNO', total: 0 }
];
const rivalRound = createGolfRivalRound({ roundKey: RIVAL_ROUND_KEY, mode: RIVAL_MODE });
let myRank = 1;
const spring = new SpringCam(camera, { k: 8.5, lookK: 11, ffPos: 0.10, ffLook: 0.05, baseFov: 52 });
const trace = createStateTrace({ limit: 320 });
let flow = null;
let aimController = null;
let sim = null;

const tmpV = new THREE.Vector3();
const rollCameraPosition = new THREE.Vector3();
const rollCameraLook = new THREE.Vector3();
const rollVelocity = new THREE.Vector3();
const rollAxis = new THREE.Vector3();
const teeVector = new THREE.Vector3();
const aimCameraScratch = new THREE.Vector3();
const guideLocalScratch = [0, 0];
let simPrevious = copyBallState(st);
let simCurrent = copyBallState(st);
const presentation = { x: 0, y: 0, z: 0, alpha: 0, previous: simPrevious, current: simCurrent };
let presentedX = 0, presentedZ = 0;

function adoptPhysicsState(next){
  st.x = next.x; st.y = next.y; st.z = next.z;
  st.vx = next.vx; st.vz = next.vz; st.v = next.v; st.rollT = next.rollT;
}
function syncBallPresentation(){
  simPrevious = copyBallState(st);
  simCurrent = copyBallState(st);
  presentation.previous = simPrevious;
  presentation.current = simCurrent;
  presentation.x = st.x; presentation.y = st.y; presentation.z = st.z; presentation.alpha = 0;
  presentedX = st.x; presentedZ = st.z;
  ball.position.set(st.x, st.y, st.z);
}
function presentInterpolatedBall(alpha){
  const a = clamp(alpha, 0, 1);
  const x = lerp(simPrevious.x, simCurrent.x, a);
  const y = lerp(simPrevious.y, simCurrent.y, a);
  const z = lerp(simPrevious.z, simCurrent.z, a);
  const dx = x - presentedX, dz = z - presentedZ;
  const travel = Math.hypot(dx, dz);
  if(travel > 1e-6){
    rollAxis.set(dz, 0, -dx).normalize();
    ball.userData.core.rotateOnWorldAxis(rollAxis, -travel / BALL_R);
  }
  presentedX = x; presentedZ = z;
  presentation.x = x; presentation.y = y; presentation.z = z; presentation.alpha = a;
  ball.position.set(x, y, z);
}

function curHole(){ return HOLES[st.hole]; }
function curFrame(){ return F[st.hole]; }
function ballLocal(){ return curFrame().toLocal(st.x, st.z); }
function groundY(lx, lz){ return curHole().base + heightLocal(curHole(), lx, lz); }
function cupW(){ return course.cupWorld[st.hole]; }
function teeW(out = teeVector){
  const [x, z] = curFrame().toWorld(0, 1.0);
  return out.set(x, groundY(0, 1.0), z);
}
function parSoFar(){
  let p = 0;
  for(let i = 0; i < st.thru; i++) p += HOLES[ROUND_HOLES[i]].par;
  return p;
}
function toParStr(n){ return n === 0 ? 'E' : (n > 0 ? '+' + n : String(n)); }
function roundIndex(){ return ROUND_HOLES.indexOf(st.hole); }
function isFinalRoundHole(){ return roundIndex() === ROUND_HOLES.length - 1; }
function nextRoundHole(){ return ROUND_HOLES[roundIndex() + 1] ?? null; }

/* ---------------- placement / flow ---------------- */
function captureLie(reason){
  st.lie = {
    hole: st.hole + 1,
    strokes: st.strokes,
    x: st.x,
    y: st.y,
    z: st.z,
    reason,
  };
  game.lastLieReason = reason;
  trace.record('lie', { ...st.lie });
}
function placeBall(reason){
  const t = teeW();
  st.x = t.x; st.z = t.z; st.y = t.y + BALL_R;
  st.vx = st.vz = st.v = 0;
  st.rollT = 0;
  ball.scale.set(1, 1, 1);
  ball.visible = true;
  game.lastResetReason = reason;
  syncBallPresentation();
  captureLie(reason);
}
function setHole(i, reason){
  st.hole = i; st.strokes = 0;
  st.lastShotOrigin = null;
  placeBall(reason);
  $('hole').textContent = i + 1;
  $('bigN').textContent = '0';
  $('stateTag').textContent = `${curHole().name} · DRAG TARGET TO PUTT`;
  $('stateTag').style.opacity = 1;
  const lp = course.lanternPts[i] || cupW().clone().add(new THREE.Vector3(0, 3, 0));
  lanternTarget.copy(lp);
  aimDir = aimDirToCup();
}
function aimDirToCup(){
  const c = cupW();
  return Math.atan2(c.x - st.x, c.z - st.z);
}

/* ---------------- authoritative screens ---------------- */
const screenIds = ['title', 'card', 'results'];
function activateOnly(id, { focus = false } = {}){
  for(const screenId of screenIds) setScreenActive(screenId, screenId === id, { focus: screenId === id ? focus : false });
}

/* ---------------- locked direct-target controls ---------------- */
let aimDir = 0, power = 0;
const aimLock = {
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  look: new THREE.Vector3(),
  fov: 50,
};

function prepareAimCamera(){
  const viewDir = aimDirToCup();
  aimCamPos(aimLock.position);
  aimLock.look.set(
    st.x + Math.sin(viewDir) * 6.5,
    st.y + 0.4,
    st.z + Math.cos(viewDir) * 6.5,
  );
  camera.position.copy(aimLock.position);
  camera.lookAt(aimLock.look);
  camera.fov = aimLock.fov;
  camera.updateProjectionMatrix();
  aimLock.quaternion.copy(camera.quaternion);
  spring.snap(aimLock.position, aimLock.look);
  spring.fov = aimLock.fov;
}

function applyAimCameraLock(){
  camera.position.copy(aimLock.position);
  camera.quaternion.copy(aimLock.quaternion);
  camera.fov = aimLock.fov;
  camera.updateProjectionMatrix();
}

function resetAimForLie(reason){
  aimDir = aimDirToCup();
  power = 0;
  st.aimT = 0;
  aimGrp.visible = true;
  powRing.material.opacity = 0;
  glowDisc.material.opacity = 0;
  aimController?.reset({ direction: aimDir, reason });
  trace.record('aim-reset', { reason, hole: st.hole + 1, strokes: st.strokes });
}

$('mute').addEventListener('click', e => {
  e.stopPropagation();
  const m = SFX.toggleMuted();
  $('mute').textContent = m ? '𝄽' : '♪';
});
$('tapGo').addEventListener('click', e => { e.stopPropagation(); startIntro(); });
$('btnNext').addEventListener('click', e => {
  e.stopPropagation();
  if(flow?.is('card')) nextHole('next-button');
});
$('btnAgain').addEventListener('click', e => {
  e.stopPropagation();
  if(flow?.is('results')) resetRound('play-again-button');
});

function strokeBall(worldAngle, p01){
  if(!flow?.is('aim') && !flow?.is('aiming')) return false;
  const p = clamp(p01, 0, 1);
  const shotOrigin = { hole: st.hole + 1, strokesBefore: st.strokes, x: st.x, y: st.y, z: st.z };
  const nextStroke = st.strokes + 1;
  const v0 = shotSpeedFromPower(p);
  const moved = flow.transition('roll', { reason: 'shot-release', detail: { stroke: nextStroke, power: p } });
  if(!moved.ok) return false;
  st.lastShotOrigin = shotOrigin;
  st.vx = Math.sin(worldAngle) * v0;
  st.vz = Math.cos(worldAngle) * v0;
  st.strokes = nextStroke; st.rollT = 0;
  st.v = v0;
  syncBallPresentation();
  trace.record('stroke', { hole: st.hole + 1, stroke: st.strokes, angle: worldAngle, power: p, origin: st.lastShotOrigin });
  sim.setSimulating(true);
  $('bigN').textContent = st.strokes;
  SFX.thump(210 + p * 160, 0.1, 0.12 + p * 0.14, -40);
  if(p > 0.55) SFX.sweep({ f0: 500, f1: 2400, dur: 0.32, vol: 0.05 });
  grade.uniforms.uCA.value = 0.5 + p * 0.5;
  aimGrp.visible = false;
  powRing.material.opacity = 0;
  glowDisc.material.opacity = 0;
  power = 0;
  return true;
}

/* ---------------- rivals ---------------- */
function rivalStrokes(h){
  return rivalRound.nextStrokes(HOLES[h].par);
}
function settleRivals(){
  const h = st.hole;
  let note = null;
  RIVALS.forEach(rv => {
    const s = rivalStrokes(h);
    rv.total += s;
    if(s < HOLES[h].par && !note) note = `${rv.name} BIRDIES No.${h + 1}`;
  });
  const prevRank = myRank;
  const better = RIVALS.filter(rv => rv.total < st.total).length;
  myRank = better + 1;
  $('pos').textContent = ORD[myRank - 1];
  if(note) flow.schedule(1.3, () => { toast(note); SFX.notify(); }, { label: 'rival-birdie' });
  if(myRank < prevRank) flow.schedule(2.4, () => { toast(ORD[myRank - 1] + '!'); SFX.notify(); }, { label: 'rank-up' });
}

/* ---------------- flow ---------------- */
function startIntro(){
  if(!flow?.is('title')) return false;
  SFX.onReady(() => { pad && pad.on(0.05); cricketsOn = true; });
  SFX.unlock();
  return flow.transition('intro', { reason: 'start-button' }).ok;
}
let toastSequence = 0;
function clearToast(sequence = null){
  const el = $('toast');
  if(sequence !== null && sequence !== toastSequence) return;
  el.style.opacity = 0;
}
function toast(msg, duration = 1.8){
  const el = $('toast');
  if(!msg){ clearToast(); return; }
  const sequence = ++toastSequence;
  el.textContent = msg;
  el.style.opacity = 1;
  if(flow?.mode){
    flow.schedule(duration, () => clearToast(sequence), { label: `toast:${sequence}` });
    flow.own(() => clearToast(sequence), { label: `toast-cleanup:${sequence}` });
  }
}
function sink(){
  if(!flow?.is('roll')) return false;
  sim.setSimulating(false);
  return flow.transition('sunk', { reason: 'ball-holed', detail: { stroke: st.strokes } }).ok;
}
function beginSunkPresentation(){
  st.sunkT = 0;
  game.timescale = 0.35;
  st.total += st.strokes;
  st.card[st.hole] = st.strokes;
  st.thru = Math.max(st.thru, roundIndex() + 1);
  const diff = st.strokes - curHole().par;
  const label = st.strokes === 1 ? 'ACE!' : diff <= -2 ? 'EAGLE!' : diff === -1 ? 'BIRDIE!' : diff === 0 ? 'PAR' : diff === 1 ? 'BOGEY' : `+${diff}`;
  flow.schedule(0.35, () => toast(label), { label: 'hole-label' });
  const c = cupW();
  for(let i = 0; i < 42; i++){
    const a = Math.random() * Math.PI * 2, r = Math.random() * 0.4;
    fireflies.emit(c.x + Math.sin(a) * r, c.y + 0.15, c.z + Math.cos(a) * r,
      Math.sin(a) * (1.2 + Math.random() * 2.2), 2.2 + Math.random() * 3.4, Math.cos(a) * (1.2 + Math.random() * 2.2),
      { life: 1.4 + Math.random() * 1.2, size: 0.55, grow: 0.25, alpha: 0.85, col: [1.0, 0.84, 0.42], grav: 1.4 });
  }
  $('vig').style.opacity = 1;
  flow.own(() => { $('vig').style.opacity = 0; }, { label: 'sink-vignette-cleanup' });
  flow.schedule(0.7, () => { $('vig').style.opacity = 0; }, { label: 'sink-vignette' });
  SFX.blip(540, 0.3, 'sine', 0.22, -320);
  const fan = diff < 0 ? [659, 830, 988, 1318] : [523, 659, 784, 1046];
  flow.schedule(0.26, () => SFX.fanfare(fan), { label: 'sink-fanfare' });
  settleRivals();
  updateToPar();
  const cardDelay = AUTO && WARP > 1 ? 0.8 : 2.3;
  flow.schedule(cardDelay, () => flow.transition('card', { reason: 'sink-presentation-complete' }), { label: 'show-hole-card' });
}
function updateToPar(){
  $('topar').textContent = toParStr(st.total - parSoFar());
}
function populateCard(){
  const h = curHole(), diff = st.strokes - h.par;
  $('cardPre').textContent = `HOLE ${st.hole + 1} · ${h.name}`;
  $('resBigC').textContent = st.strokes === 1 ? 'ACE' : diff <= -2 ? 'EAGLE' : diff === -1 ? 'BIRDIE' : diff === 0 ? 'PAR' : diff === 1 ? 'BOGEY' : 'DOUBLE+';
  const rows = [`YOU <b>${st.strokes}</b> ON PAR ${h.par} · TOTAL <b>${toParStr(st.total - parSoFar())}</b>`];
  const sorted = [...RIVALS].sort((a, b) => a.total - b.total);
  rows.push(sorted.map(rv => `${rv.name} ${toParStr(rv.total - parSoFar())}`).join(' · '));
  $('cardRows').innerHTML = rows.join('<br>');
  $('btnNext').textContent = isFinalRoundHole() ? (ROUND_HOLES.length === 1 ? 'VIEW RESULT' : 'FINAL CARD') : 'NEXT HOLE';
}
function nextHole(reason = 'next-hole'){
  if(!flow?.is('card')) return false;
  if(isFinalRoundHole()) return flow.transition('results', { reason: `${reason}:final-card` }).ok;
  const next = nextRoundHole();
  return flow.transition('next-hole', { reason, detail: { hole: next + 1 } }).ok;
}
function populateResults(){
  const toPar = st.total - parSoFar();
  $('resBig').textContent = toParStr(toPar);
  const standings = [{ name: 'YOU', total: st.total, me: true }, ...RIVALS]
    .sort((a, b) => a.total - b.total);
  const rows = [];
  rows.push(`CARD <b>${ROUND_HOLES.map(hole => st.card[hole]).join(' · ')}</b>`);
  standings.forEach((s, i) => {
    rows.push(`${i + 1} ${s.me ? '<b>YOU</b>' : s.name} ${toParStr(s.total - parSoFar())} · ${s.total}`);
  });
  rows.push(standings[0].me ? '<b>GARDEN CHAMPION</b>' : 'READ THE SLOPE — FIREFLIES MARK THE FALL LINE');
  $('resRows').innerHTML = rows.join('<br>');
}
function resetRound(reason = 'play-again'){
  if(!flow?.is('results')) return false;
  return flow.transition('replay', { reason, detail: { hole: START_HOLE + 1 } }).ok;
}
function applyRoundReset(reason){
  st.total = 0; st.thru = 0; st.card = HOLES.map(() => 0);
  RIVALS.forEach(r => r.total = 0);
  rivalRound.reset({ roundKey: RIVAL_ROUND_KEY, mode: RIVAL_MODE });
  trace.record('rival-round-reset', { reason, ...rivalRound.snapshot() });
  myRank = 1; $('pos').textContent = '1ST';
  updateToPar();
  setHole(START_HOLE, reason);
}

const modeHandlers = {
  title: {
    enter(scope){
      activateOnly('title');
      document.body.classList.remove('cine', 'play');
      game.cameraReady = false;
      game.timescale = 1;
      aimController.disable();
      sim.setSimulating(false);
      if(AUTO) scope.schedule(0.3, () => startIntro(), { label: 'auto-start' });
    },
  },
  intro: {
    enter(){
      activateOnly(null);
      document.body.classList.add('cine');
      document.body.classList.remove('play');
      game.cameraReady = false;
      game.introT = FAST ? 99 : 0;
      aimController.disable();
      sim.setSimulating(false);
    },
  },
  'aim-enter': {
    enter(scope, transition){
      activateOnly(null);
      document.body.classList.remove('cine');
      document.body.classList.add('play');
      game.cameraReady = false;
      game.timescale = 1;
      sim.setSimulating(false);
      aimController.disable();
      resetAimForLie(`aim-enter:${transition.reason}`);
      prepareAimCamera();
      scope.schedule(FAST ? 0 : 0.08, () => {
        flow.transition('aim', { reason: 'camera-ready', detail: { lie: st.lie } });
      }, { label: 'camera-ready-gate' });
    },
  },
  aim: {
    enter(scope, transition){
      activateOnly(null);
      sim.setSimulating(false);
      if(transition.from === 'aiming') resetAimForLie(`aim-cancel:${transition.reason}`);
      applyAimCameraLock();
      game.cameraReady = true;
      aimController.enable();
      if(transition.from === 'aim-enter') toast('DRAG THE TARGET TOWARD THE CUP · RELEASE TO PUTT');
    },
    exit(scope, transition){
      if(transition.to !== 'aiming'){
        game.cameraReady = false;
        aimController.disable();
      }
    },
  },
  aiming: {
    enter(){
      activateOnly(null);
      applyAimCameraLock();
      game.cameraReady = true;
      aimController.enable();
    },
    exit(){
      game.cameraReady = false;
      aimController.disable();
    },
  },
  roll: {
    enter(){
      activateOnly(null);
      game.cameraReady = false;
      aimController.disable();
    },
  },
  settling: {
    enter(scope){
      activateOnly(null);
      sim.setSimulating(false);
      syncBallPresentation();
      captureLie('settled');
      scope.schedule(0.08, () => flow.transition('aim-enter', { reason: 'lie-settled' }), { label: 'settle-to-aim' });
    },
  },
  sunk: {
    enter(){
      activateOnly(null);
      document.body.classList.add('cine');
      game.cameraReady = false;
      aimController.disable();
      sim.setSimulating(false);
      syncBallPresentation();
      beginSunkPresentation();
    },
  },
  card: {
    enter(scope){
      activateOnly('card', { focus: true });
      document.body.classList.add('cine');
      game.timescale = 1;
      game.cameraReady = false;
      sim.setSimulating(false);
      populateCard();
      if(AUTO){
        const delay = WARP > 1 ? 1 : 5;
        scope.schedule(delay, () => nextHole('auto-next'), { label: 'auto-next-hole' });
      }
    },
  },
  'next-hole': {
    enter(scope, transition){
      activateOnly(null);
      game.timescale = 1;
      game.cameraReady = false;
      sim.setSimulating(false);
      setHole(transition.detail?.hole ? transition.detail.hole - 1 : nextRoundHole(), transition.reason);
      scope.schedule(0, () => flow.transition('aim-enter', {
        reason: 'next-hole-ready',
        detail: { hole: st.hole + 1 },
      }), { label: 'next-hole-to-aim' });
    },
  },
  results: {
    enter(){
      activateOnly('results', { focus: true });
      document.body.classList.remove('cine', 'play');
      game.cameraReady = false;
      sim.setSimulating(false);
      populateResults();
    },
  },
  replay: {
    enter(scope, transition){
      activateOnly(null);
      game.timescale = 1;
      game.cameraReady = false;
      sim.setSimulating(false);
      applyRoundReset(transition.reason);
      scope.schedule(0, () => flow.transition('aim-enter', {
        reason: 'replay-ready',
        detail: { hole: START_HOLE + 1 },
      }), { label: 'replay-to-aim' });
    },
  },
};

aimController = createGolfAimController({
  canvas: $('gl'),
  camera,
  getBallPosition: () => ball.position,
  canStart: () => flow?.is('aim') && game.cameraReady,
  onBegin(){
    const result = flow.transition('aiming', { reason: 'gesture-start' });
    if(!result.ok) aimController.cancel(`transition:${result.code}`);
  },
  onUpdate(state){
    if(!flow.is('aiming')) return;
    aimDir = state.direction;
    power = state.power;
  },
  onRelease(state){
    if(!flow.is('aiming')) return;
    aimDir = state.direction;
    power = state.power;
    strokeBall(state.direction, state.power);
  },
  onAbort(reason){
    power = 0;
    if(flow?.is('aiming')) flow.transition('aim', { reason: `gesture-cancel:${reason}` });
  },
});

flow = createGolfFlow({ handlers: modeHandlers, trace });
sim = createFixedStepRunner({
  step: 1 / 120,
  maxFrame: 0.1,
  maxSteps: 120,
  onStep: stepSimulation,
});
sim.setSimulating(false);

/* ---------------- physics ---------------- */
function consumeSimulationEvent(event){
  if(event.type === 'wall-impact'){
    SFX.thump(150, 0.12, clamp(event.impulse / 26, 0.05, 0.2));
    spring.addShake(clamp(event.impulse / 40, 0, 0.4));
    return;
  }
  if(event.type === 'lip-out'){
    toast('LIP OUT');
    SFX.uiTick();
    return;
  }
  if(event.type === 'holed'){
    sim.setSimulating(false);
    sink();
    return;
  }
  if(event.type === 'settled'){
    sim.setSimulating(false);
    rustle?.set(0);
    if(st.strokes >= 8){
      st.strokes = 8;
      sink();
      return;
    }
    flow.transition('settling', {
      reason: 'ball-stopped',
      detail: { lie: { x: st.x, y: st.y, z: st.z } },
    });
    grade.uniforms.uCA.value = 0;
  }
}

function stepSimulation(dt){
  const result = stepGolfBall(st, {
    hole: curHole(),
    walls: WALLS[st.hole],
    ballRadius: BALL_R,
    ...CUP_RULES,
  }, dt);
  simPrevious = simCurrent;
  simCurrent = result.state;
  presentation.previous = simPrevious;
  presentation.current = simCurrent;
  adoptPhysicsState(result.state);
  for(const event of result.events){
    consumeSimulationEvent(event);
    if(!flow.is('roll')) break;
  }
}

/* ---------------- autopilot ---------------- */
function autoAim(){
  const h = curHole();
  const [lx, lz] = ballLocal();
  let target = h.cup;
  if(st.hole === 1 && lz < 13.4) target = [0.5, 15];
  if(st.hole === 5 && lz < 11.6) target = [0, 17.4];
  if(st.hole === 4 && lz < h.gate.z - 0.5) target = [0, h.gate.z + 2.5];
  const [twx, twz] = curFrame().toWorld(target[0], target[1]);
  const ang = Math.atan2(twx - st.x, twz - st.z);
  const dist = Math.hypot(twx - st.x, twz - st.z);
  let need = Math.sqrt(2 * 1.5 * dist) * 1.06;
  if(st.hole === 3 && lz < 15) need *= 1.22; /* punch up the terrace */
  const p = clamp(shotPowerFromSpeed(need) + (Math.random() - 0.5) * 0.05, 0.12, 1);
  return { ang: ang + (Math.random() - 0.5) * 0.03, p };
}

/* ---------------- cameras ---------------- */
function aimCamPos(out = aimCameraScratch){
  const c = cupW();
  const d = Math.atan2(c.x - st.x, c.z - st.z);
  const dir = d;
  const back = 7.4;
  return out.set(
    st.x - Math.sin(dir) * back,
    st.y + 3.1,
    st.z - Math.cos(dir) * back);
}
function lerpAngle(a, b, t){
  let d = b - a;
  while(d > Math.PI) d -= Math.PI * 2;
  while(d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
const shot = { a: new THREE.Vector3(), b: new THREE.Vector3() };
function introCam(t){
  const tee = teeW(), c = cupW();
  if(t < 2.4){
    const u = ease(t / 2.4);
    shot.a.set(118, 68, 128); shot.b.set(46, 27, 52);
    camera.position.copy(shot.a).lerp(shot.b, u);
    camera.lookAt(-58, 3, -78);
    camera.fov = 54;
  } else if(t < 4.6){
    const u = ease((t - 2.4) / 2.2);
    const dir = Math.atan2(c.x - tee.x, c.z - tee.z);
    const sx = Math.cos(dir), sz = -Math.sin(dir);
    shot.a.set(tee.x + sx * 0.95 - Math.sin(dir) * 2.9, tee.y + 0.80, tee.z + sz * 0.95 - Math.cos(dir) * 2.9);
    shot.b.set(tee.x + sx * 0.80 - Math.sin(dir) * 2.2, tee.y + 0.56, tee.z + sz * 0.80 - Math.cos(dir) * 2.2);
    camera.position.copy(shot.a).lerp(shot.b, u);
    camera.lookAt(c.x, c.y + 1.15, c.z);
    camera.fov = 32;
  } else {
    const u = ease((t - 4.6) / 1.8);
    const target = aimCamPos();
    const dir = Math.atan2(c.x - tee.x, c.z - tee.z);
    shot.a.set(tee.x + Math.cos(dir) * 5.5, tee.y + 1.1, tee.z - Math.sin(dir) * 5.5);
    camera.position.copy(shot.a).lerp(target, u);
    tmpV.set(lerp(c.x, c.x, u), lerp(c.y + 1.1, c.y + 0.6, u), c.z);
    camera.lookAt(tmpV);
    camera.fov = lerp(34, 52, u);
  }
  camera.updateProjectionMatrix();
}

/* ---------------- HUD + audio loops ---------------- */
let pad = null, crickets = null, rustle = null, cricketsOn = false;
SFX.onReady(() => {
  pad = SFX.pad({ chords: [
    [130.8, 196.0, 246.9], [110.0, 164.8, 261.6], [87.3, 174.6, 220.0], [98.0, 146.8, 196.0]
  ], lp: 700 });
  crickets = SFX.noiseLoop({ type: 'bandpass', freq: 4400, Q: 9 });
  rustle = SFX.noiseLoop({ type: 'lowpass', freq: 700, Q: 0.5 });
});

/* ---------------- loop ---------------- */
rivalRound.reset({ roundKey: RIVAL_ROUND_KEY, mode: RIVAL_MODE });
trace.record('rival-round-reset', { reason: 'initial', ...rivalRound.snapshot() });
setHole(START_HOLE, 'initial-hole');
updateToPar();
$('holeN').textContent = PREVIEW_MODE && PREVIEW_OPTIONS.golf.format !== 'practice' ? ROUND_HOLES.length : HOLES.length;
if(PREVIEW_MODE){
  document.querySelector('#title .sub').textContent = `DUSK GARDEN · ${golfFormatLabel(PREVIEW_OPTIONS).toUpperCase()} · ${PREVIEW_OPTIONS.golf.rivals === 'relaxed' ? 'RELAXED RIVALS' : '3 RIVALS'}`;
  $('resSub').textContent = `STACKYARD GOLF · ${golfFormatLabel(PREVIEW_OPTIONS).toUpperCase()}`;
  mountPreviewGameChrome({
    game: 'golf',
    options: PREVIEW_OPTIONS,
    onOpenChange(open){
      previewPaused = open;
      if(open) aimController.cancel('preview-menu-open');
    },
    onSoundChange(value){
      const muted = value === 'off';
      SFX.setMuted(muted);
    },
  });
}
{ /* title cam init */
  const t = teeW();
  camera.position.set(t.x + 9, t.y + 4, t.z + 9);
  camera.lookAt(t.x, t.y + 1, t.z);
}
flow.transition('title', { reason: 'initial' });
let last = performance.now();
let topCamH = 0, fireT = 0, fountT = 0;

function frame(now){
  requestAnimationFrame(frame);
  const wallDelta = Math.max(0, (now - last) / 1000);
  const wdt = Math.min(wallDelta, 0.25);
  const rdt = Math.min(wallDelta, 0.05); last = now;
  if(previewPaused){
    composer.render();
    return;
  }
  const dt = rdt * game.timescale;
  grade.uniforms.uTime.value = now / 1000;
  const t = now / 1000;
  flow.tick(wdt);
  let simulationAdvanced = false;

  if(flow.is('title')){
    const tee = teeW(), c = cupW();
    const dx = c.x - tee.x, dz = c.z - tee.z;
    const dl = Math.hypot(dx, dz), fx = dx / dl, fz = dz / dl;
    const sw = Math.sin(t * 0.10) * 3.5;
    camera.position.set(
      tee.x + fx * 13.5 - fz * (5 + sw),
      tee.y + 4.0 + Math.sin(t * 0.13) * 0.4,
      tee.z + fz * 13.5 + fx * (5 + sw));
    camera.lookAt(tee.x - fx * 3, tee.y + 1.4, tee.z - fz * 3);
    camera.fov = 44; camera.updateProjectionMatrix();
  }
  else if(flow.is('intro')){
    game.introT = FREEZE !== null ? FREEZE : game.introT + wdt;
    introCam(game.introT);
    if(game.introT >= 6.4) flow.transition('aim-enter', { reason: 'intro-complete' });
  }
  else if(flow.is('aim-enter') || flow.is('aim') || flow.is('aiming')){
    st.aimT += wdt;
    /* aim visuals */
    aimGrp.visible = true;
    const target = aimController.target;
    const targetX = target.x - st.x, targetZ = target.z - st.z;
    const len = Math.max(0.05, Math.hypot(targetX, targetZ));
    const tx = target.x, tz = target.z;
    const frame = curFrame();
    writeTerrainGuidePositions(
      shaftPositions,
      AIM_GUIDE_SEGMENTS,
      st.x,
      st.z,
      tx,
      tz,
      AIM_GUIDE_WIDTH,
      AIM_GUIDE_LIFT,
      frame.toLocal,
      groundY,
      guideLocalScratch,
    );
    shaftGeo.attributes.position.needsUpdate = true;
    const directionX = targetX / len, directionZ = targetZ / len;
    const perpendicularX = directionZ, perpendicularZ = -directionX;
    const arrowHalfWidth = 0.4;
    const arrowBaseX = tx + directionX * 0.05, arrowBaseZ = tz + directionZ * 0.05;
    const arrowTipX = arrowBaseX + directionX * 0.72, arrowTipZ = arrowBaseZ + directionZ * 0.72;
    const arrowLeftX = arrowBaseX - perpendicularX * arrowHalfWidth;
    const arrowLeftZ = arrowBaseZ - perpendicularZ * arrowHalfWidth;
    const arrowRightX = arrowBaseX + perpendicularX * arrowHalfWidth;
    const arrowRightZ = arrowBaseZ + perpendicularZ * arrowHalfWidth;
    tipPositions[0] = arrowLeftX;
    tipPositions[1] = terrainHeightAtWorld(arrowLeftX, arrowLeftZ, frame.toLocal, groundY, guideLocalScratch) + AIM_GUIDE_LIFT;
    tipPositions[2] = arrowLeftZ;
    tipPositions[3] = arrowRightX;
    tipPositions[4] = terrainHeightAtWorld(arrowRightX, arrowRightZ, frame.toLocal, groundY, guideLocalScratch) + AIM_GUIDE_LIFT;
    tipPositions[5] = arrowRightZ;
    tipPositions[6] = arrowTipX;
    tipPositions[7] = terrainHeightAtWorld(arrowTipX, arrowTipZ, frame.toLocal, groundY, guideLocalScratch) + AIM_GUIDE_LIFT;
    tipPositions[8] = arrowTipZ;
    tipGeo.attributes.position.needsUpdate = true;
    const targetGroundY = terrainHeightAtWorld(tx, tz, frame.toLocal, groundY, guideLocalScratch);
    powRing.position.set(tx, targetGroundY + AIM_GUIDE_LIFT, tz);
    powRing.material.opacity = game.cameraReady ? 0.32 + power * 0.58 : 0.12;
    powRing.scale.setScalar(0.82 + power * 0.45);
    glowDisc.position.set(st.x, st.y - BALL_R + 0.06, st.z);
    glowDisc.material.opacity = 0.16 + 0.08 * Math.sin(t * 2.4);
    /* Position, look, FOV, and sway are all frozen for the entire aim session. */
    applyAimCameraLock();
    if(AUTO && flow.is('aim') && game.cameraReady && st.aimT > (WARP > 1 ? 0.25 : 0.8)){
      const a = autoAim();
      strokeBall(a.ang, a.p);
    }
  }
  else if(flow.is('roll')){
    const simFrame = sim.advance(wallDelta, {
      simulate: true,
      timeScale: game.timescale * ((AUTO && WARP > 1) ? WARP : 1),
    });
    simulationAdvanced = true;
    presentInterpolatedBall(simFrame.alpha);
    if(flow.is('roll')){
      rollVelocity.set(st.vx, 0, st.vz);
      const vdir = st.v > 0.5 ? Math.atan2(st.vx, st.vz) : aimDir;
      const back = 5.8 + st.v * 0.10;
      rollCameraPosition.set(
        st.x - Math.sin(vdir) * back,
        st.y + 2.7 + st.v * 0.02,
        st.z - Math.cos(vdir) * back,
      );
      rollCameraLook.set(
        st.x + Math.sin(vdir) * 5.5,
        st.y + 0.2,
        st.z + Math.cos(vdir) * 5.5,
      );
      spring.tick(rdt,
        rollCameraPosition,
        rollCameraLook,
        rollVelocity, { sway: 0.03 + st.v * 0.003, fovTarget: 50 + st.v * 0.6 });
      if(st.v > 7.5 && Math.random() < 0.4){
        sparkTrail.emit(presentation.x, presentation.y + 0.05, presentation.z,
          -st.vx * 0.06 + (Math.random() - .5), 0.6 + Math.random() * 0.8, -st.vz * 0.06 + (Math.random() - .5),
          { life: 0.45, size: 0.38, grow: 0.7, alpha: 0.16, col: [1.0, 0.94, 0.8] });
      }
      rustle?.set(clamp(st.v / 11, 0, 1), 0.05, 500 + st.v * 40);
    }
    grade.uniforms.uCA.value = Math.max(0, grade.uniforms.uCA.value - rdt * 1.4);
  }
  else if(flow.is('settling')){
    grade.uniforms.uCA.value = Math.max(0, grade.uniforms.uCA.value - rdt * 1.4);
  }
  else if(flow.is('sunk')){
    st.sunkT = flow.modeTime;
    const c = cupW();
    /* ball drops into the cup */
    const u = clamp(st.sunkT / 0.4, 0, 1);
    ball.position.set(lerp(ball.position.x, c.x, u * 0.6), lerp(ball.position.y, c.y - 0.3, u), lerp(ball.position.z, c.z, u * 0.6));
    ball.scale.setScalar(1 - u * 0.25);
    if(st.sunkT > 0.5) ball.visible = false;
    orbit(camera, c, st.sunkT, { r: 6.4, h: 2.6, speed: 0.5, lookY: 0.55, rise: 0.25 });
    camera.fov = 44; camera.updateProjectionMatrix();
  }
  else if(flow.is('card')){
    const c = cupW();
    orbit(camera, c, t, { r: 9.5, h: 4.2, speed: 0.10, lookY: 0.2 });
  }
  else if(flow.is('results')){
    const c = cupW();
    orbit(camera, c, t, { r: 11, h: 4.6, speed: 0.11, lookY: 0.2 });
  }

  if(topCamH > 0 && !flow.is('aim-enter') && !flow.is('aim') && !flow.is('aiming')){
    camera.position.set(st.x, st.y + topCamH, st.z);
    camera.lookAt(st.x, st.y, st.z);
    camera.fov = 55; camera.updateProjectionMatrix();
  }

  if(!simulationAdvanced) sim.advance(wallDelta, { simulate: false });

  /* ambient systems */
  fireT -= dt;
  if(fireT <= 0){
    fireT = 0.08;
    const h = curHole();
    const a = Math.random() * Math.PI * 2;
    const r = 5 + Math.random() * 13;
    const [wx, wz] = curFrame().toWorld(
      h.cup[0] + Math.sin(a) * r * 0.7, h.cup[1] + Math.cos(a) * r * 0.5);
    fireflies.emit(wx, curHole().base + 0.5 + Math.random() * 1.7, wz,
      (Math.random() - .5) * 0.8, (Math.random() - .3) * 0.5, (Math.random() - .5) * 0.8,
      { life: 2.6 + Math.random() * 2, size: 0.62, grow: 0.02, alpha: 0.8, col: [1.0, 0.83, 0.4] });
    if(course.lanternPts.length && Math.random() < 0.4){
      const lp = course.lanternPts[(Math.random() * course.lanternPts.length) | 0];
      fireflies.emit(lp.x + (Math.random() - .5) * 3, lp.y - 1.2 + Math.random() * 1.8, lp.z + (Math.random() - .5) * 3,
        (Math.random() - .5) * 0.6, (Math.random() - .3) * 0.4, (Math.random() - .5) * 0.6,
        { life: 3, size: 0.55, grow: 0.02, alpha: 0.7, col: [1.0, 0.85, 0.5] });
    }
  }
  fountT -= dt;
  if(fountT <= 0){
    fountT = 0.05;
    fountainJet.emit((Math.random() - .5) * 0.5, 3.0, (Math.random() - .5) * 0.5,
      (Math.random() - .5) * 1.4, 5.2 + Math.random() * 1.6, (Math.random() - .5) * 1.4,
      { life: 1.05, size: 0.5, grow: 0.3, alpha: 0.5, col: [0.72, 0.88, 1.0], grav: 7.5 });
  }
  fireflies.tick(dt); sparkTrail.tick(dt); fountainJet.tick(dt);
  tickCourse(dt, t, course.flags);
  atmo.tick(dt, camera.position.x, camera.position.z);
  atmo.followShadow(st.x, st.y, st.z);
  lantern.position.lerp(lanternTarget, 1 - Math.exp(-3 * rdt));
  if(crickets && cricketsOn) crickets.set(0.35 + 0.3 * Math.sin(t * 2.7) + 0.15 * Math.sin(t * 7.1), 0.018, 4200 + Math.sin(t * 0.9) * 400);
  pipe.govern(rdt);
  composer.render();
}
requestAnimationFrame(frame);

/* ---------------- test hook ---------------- */
window.__gp = {
  get previewPaused(){ return previewPaused; },
  get previewOptions(){ return structuredClone(PREVIEW_OPTIONS); },
  get previewRuntime(){ return { enabled: PREVIEW_MODE, lowfx: LOWFX, cupRules: { ...CUP_RULES } }; },
  get roundHoles(){ return ROUND_HOLES.map(hole => hole + 1); },
  get rivalCard(){ return RIVALS.map(rival => ({ ...rival })); },
  get rivalRound(){ return rivalRound.snapshot(); },
  get mode(){ return flow.mode; },
  get hole(){ return st.hole + 1; },
  get strokes(){ return st.strokes; },
  get total(){ return st.total; },
  get pos(){ return myRank; },
  get ballV(){ return st.v; },
  get power(){ return power; },
  get aimDir(){ return aimDir; },
  get aimTarget(){ return aimController.state.target; },
  get restTarget(){ return aimController.state.restTarget; },
  get reticleWorld(){ return powRing.position.toArray().map(v => +v.toFixed(5)); },
  get dragging(){ return aimController.active; },
  get gesture(){ return aimController.state; },
  get cameraReady(){ return game.cameraReady; },
  get introT(){ return game.introT; },
  get camPos(){ return camera.position.toArray().map(v => +v.toFixed(2)); },
  get camTransform(){
    return {
      position: camera.position.toArray().map(v => +v.toFixed(5)),
      quaternion: camera.quaternion.toArray().map(v => +v.toFixed(7)),
      fov: +camera.fov.toFixed(5),
    };
  },
  get springState(){
    return {
      position: spring.pos.toArray().map(v => +v.toFixed(5)),
      look: spring.look.toArray().map(v => +v.toFixed(5)),
      fov: +spring.fov.toFixed(5),
    };
  },
  get ballPos(){ return [+st.x.toFixed(2), +st.y.toFixed(2), +st.z.toFixed(2)]; },
  get ballState(){ return copyBallState(st); },
  get presentation(){
    return {
      x: presentation.x, y: presentation.y, z: presentation.z, alpha: presentation.alpha,
      previous: structuredClone(presentation.previous),
      current: structuredClone(presentation.current),
    };
  },
  get lie(){ return st.lie ? structuredClone(st.lie) : null; },
  get lastShotOrigin(){ return st.lastShotOrigin ? structuredClone(st.lastShotOrigin) : null; },
  get activeScreens(){
    return screenIds.filter(id => $(id).dataset.screenActive === 'true');
  },
  get trace(){ return flow.trace.snapshot(); },
  get lastTransition(){ return flow.lastTransition; },
  get lastResetReason(){ return game.lastResetReason; },
  get lastLieReason(){ return game.lastLieReason; },
  get simulation(){ return sim.state; },
  start(){ return startIntro(); },
  setFreeze(v){ FREEZE = v; },
  setAuto(v){ AUTO = !!v; },
  setWarp(v){ WARP = Math.min(v | 0, 10); },
  stroke(p = 0.6, ang = null){
    if(!flow.is('aim')) return false;
    return strokeBall(ang === null ? autoAim().ang : ang, p);
  },
  next(){ return flow.is('card') ? nextHole('test-next') : false; },
  topcam(h){ topCamH = h; },
  again(){ return flow.is('results') ? resetRound('test-play-again') : false; },
  cancelGesture(reason = 'test-cancel'){ return aimController.cancel(reason); },
  auditScreens(){
    return {
      state: auditInactiveScreenState(),
      hits: auditInactiveScreenHits({ step: 12 }),
    };
  },
};
window.__dbg = { camera, scene, THREE };
