/* Gridlock Run Phase 4 hard visual gate.
   Package composition runs post.browser + Phase 3 before this file. This gate
   owns fresh source artifacts, promoted parity, production scene budgets,
   deterministic replay/resource stability, and the two-resolution shot set. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, get as httpGet } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createIdentityHandleScope } from './active-handle-scope.mjs';
import { resolveChromeExecutable } from './chrome-path.mjs';
import {
  releaseCapturedGatedNode,
  scopedGatedTitle,
  spawnCapturedGatedNode,
} from './phase-isolated-node.mjs';
import { assertContainedPhaseTarget } from './phase-target-bootstrap.mjs';

if(process.platform === 'win32'){
  throw new Error('Gridlock Run Phase 4 worker requires POSIX process-group isolation; win32 is unsupported');
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WAIT_FIXTURE = fileURLToPath(new URL('./phase-wait.fixture.mjs', import.meta.url));
const INTERNAL_WORKER = process.env.RUNNER_PHASE4_INTERNAL_WORKER === '1';
if(!INTERNAL_WORKER) throw new Error('runner.phase4.mjs is worker-only; use tools/shipcheck-phase4.mjs');
assertContainedPhaseTarget('Gridlock Run Phase 4 worker');
const MODE = process.env.RUNNER_PHASE4_MODE;
if(MODE !== 'release' && MODE !== 'dev') throw new Error('RUNNER_PHASE4_MODE must be release or dev');
const RELEASE = MODE === 'release';
const RUN_MARKER = process.env.RUNNER_PHASE4_RUN_MARKER || '';
const cliMarker = process.argv.find(argument => argument.startsWith('--phase4-worker-marker='))?.split('=')[1] || '';
assert.ok(RUN_MARKER && cliMarker === RUN_MARKER, 'worker marker must match parent-owned marker');
const TEMP_DIR = resolve(process.env.RUNNER_PHASE4_TEMP_DIR || '');
const OUTPUT_ROOT = resolve(process.env.RUNNER_PHASE4_OUTPUT_DIR || '');
const REPORT_PATH = resolve(process.env.RUNNER_PHASE4_REPORT_PATH || '');
const FIXTURE = process.env.RUNNER_PHASE4_FIXTURE || '';
const ALLOWED_FIXTURES = new Set(['', 'post-boot-sync-hang', 'page-evaluate-hang', 'close-failure']);
assert.equal(ALLOWED_FIXTURES.has(FIXTURE), true, `unknown Phase 4 fixture ${FIXTURE}`);
const rawInjectTimeout = process.env.RUNNER_PHASE4_INJECT_TIMEOUT_MS;
const INJECT_TIMEOUT_MS = rawInjectTimeout === undefined ? 750 : Number(rawInjectTimeout);
assert.ok(Number.isSafeInteger(INJECT_TIMEOUT_MS) && INJECT_TIMEOUT_MS > 0,
  'RUNNER_PHASE4_INJECT_TIMEOUT_MS must be a positive integer');
function assertOwnedPath(path, label){
  const offset = relative(TEMP_DIR, path);
  assert.ok(offset && !offset.startsWith('..') && !isAbsolute(offset), `${label} must be inside parent temp`);
}
assertOwnedPath(OUTPUT_ROOT, 'output root');
assertOwnedPath(REPORT_PATH, 'report path');
const BUILD_TIMEOUT_MS = 120_000;
const OP_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const SHOT_VIEWPORTS = Object.freeze([
  Object.freeze({ key: '1366x1024', width: 1366, height: 1024 }),
  Object.freeze({ key: '1024x768', width: 1024, height: 768 }),
]);
const SHOT_NAMES = Object.freeze([
  'opening', 'hero-s14', 'gameplay-s60', 'slide-s90-92', 'genuine-recovery', 'finish',
]);
const EXPECTED_DISTRICTS = Object.freeze([
  'DISPATCH ROOF', 'RAIN SPAN', 'SWITCHYARD', 'MAGLEV UNDERCROFT', 'RELAY CAUSEWAY',
]);
const FROZEN_SOURCE_HASHES = Object.freeze({
  'runner/src/course.js': 'b1fd096f0e0461cbf170b3225c3b49eb8991f006641d0fd19122431594535e2c',
  'runner/src/sim.js': 'e439c8de6f5a105d03e4b235771553c05ed0b3097c165e5c98f627dfdbedba95',
  'runner/src/flow.js': '809f563a6a2b47f5d8f4867697f68bbc56f126af0f02f06ffaae5d97c8e74b72',
  'runner/src/action.js': 'd920c38bf295d6aeb937ad4855ec6fc7e03b82edb0d8262ff59a5a07f84294a8',
  'engine/atmo.js': '54ca50e7fc05dcd24998be5af0e2e3ae78311a32a906dc3374564b4334b80f8c',
  'engine/base.css': 'd03673b51844990dc61833203757022d3e5357dec9fa8f45d1a117b4d4174cd0',
  'engine/cam.js': '7fa8381a21a46443548e2a7480f626dc5759775e830e546f628ca36703125541',
  'engine/fixed-step.js': 'a12fb23e0b611f05c9c875571550a0024e0ecf3a7a1d34124ab1f396cd2905c9',
  'engine/fx.js': '4f4815c816f9ee420772e3beb630442dceb54f79932d5a85d477200cee90867a',
  'engine/gesture.js': 'b4956aebd2c8d69b645ceb61ef261181c795b49444fe35e16ddb8398c941a68c',
  'engine/mode.js': 'e994c1863729f150866b9d5b82dcad7e47fc90581136044fb5e26cae5124a03d',
  'engine/post.js': 'f6726bd3fcca0f785fdf48e3eec92ee8bc34cd1ac08cbcd54389d43e63ffb103',
  'engine/screen.js': 'c232854e05965e9b0350587bd9284c260a59a01e41b0a637bed0be2fa3615d72',
  'engine/sfx.js': 'd0ee84ec0560d9837875736193202bd98ec33bf0cb33efa9f72154f607232ab6',
  'engine/touch.js': '839f24c00965a0ad06169888021f61dbc05fed8033fecb7432b22555836c7b15',
  'engine/trace.js': '619aa9bc0545b80d4171e3d64328e9856e6d038047919206cde179ebcda2144e',
  'engine/util.js': 'ef46e485804086509b55b34fa02767b14fd04c5b61b144b34e3766e9d0a0a285',
});
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function timebox(promise, milliseconds, label){
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function verifyFrozenSources(){
  const observed = {};
  for(const [path, expected] of Object.entries(FROZEN_SOURCE_HASHES)){
    const actual = sha256(await readFile(join(ROOT, path)));
    assert.equal(actual, expected, `frozen source changed: ${path}`);
    observed[path] = actual;
  }
  return observed;
}

async function writeReport(report){
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  const staging = `${REPORT_PATH}.writing-${process.pid}`;
  await writeFile(staging, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  await rename(staging, REPORT_PATH);
}

async function freshBuild(world, outputRoot){
  const outDir = join(outputRoot, world);
  const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const result = spawnSync(process.execPath, [
    vite, 'build', world, '--config', `${world}/vite.config.js`, '--outDir', outDir, '--emptyOutDir',
  ], {
    cwd: ROOT, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  if(result.error || result.status !== 0){
    throw new Error(`fresh ${world} build failed\n${result.error?.message || ''}\n${result.stdout}\n${result.stderr}`);
  }
  const artifact = await readFile(join(outDir, 'index.html'));
  return { world, outDir, artifact, hash: sha256(artifact), rawBytes: artifact.length, gzipBytes: gzipSync(artifact).length };
}

function readHttp(url, label){
  return new Promise((resolve, reject) => {
    let settled = false;
    let totalDeadline = null;
    const finish = callback => value => {
      if(settled) return;
      settled = true;
      clearTimeout(totalDeadline);
      callback(value);
    };
    const succeed = finish(resolve);
    const fail = finish(reject);
    const request = httpGet(url, { agent: false, headers: { connection: 'close', 'cache-control': 'no-cache' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', fail);
      response.once('end', () => {
        if((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300){
          fail(new Error(`${label} returned HTTP ${response.statusCode}`));
          return;
        }
        succeed(Buffer.concat(chunks));
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error(`${label} timed out`)));
    request.once('error', fail);
    totalDeadline = setTimeout(() => request.destroy(new Error(`${label} exceeded total HTTP deadline`)), OP_TIMEOUT_MS);
  });
}

async function baselineOldParity(){
  if(!RELEASE) return { skipped: true, reason: 'development gate intentionally excludes old promoted-baseline parity' };
  const local = process.env.PLAYFORGE_LOCALHOST_ORIGIN || 'http://127.0.0.1:8091';
  const lan = process.env.PLAYFORGE_LAN_ORIGIN || 'http://192.168.1.137:8091';
  const worlds = [
    {
      name: 'runner',
      dist: join(ROOT, 'runner', 'dist', 'index.html'),
      standalone: join(ROOT, 'runner', 'gridlock-run-v1.html'),
      path: '/runner/gridlock-run-v1.html',
    },
    {
      name: 'golf',
      dist: join(ROOT, 'golf', 'dist', 'index.html'),
      standalone: join(ROOT, 'golf', 'stackyard-golf-v1.html'),
      path: '/golf/stackyard-golf-v1.html',
    },
  ];
  const report = {};
  for(const world of worlds){
    const localhostUrl = new URL(world.path, local);
    const lanUrl = new URL(world.path, lan);
    localhostUrl.searchParams.set('phase4Baseline', RUN_MARKER);
    lanUrl.searchParams.set('phase4Baseline', RUN_MARKER);
    const hashes = {
      dist: sha256(await readFile(world.dist)),
      standalone: sha256(await readFile(world.standalone)),
      localhost: sha256(await readHttp(localhostUrl.href, `${world.name} baseline localhost`)),
      lan: sha256(await readHttp(lanUrl.href, `${world.name} baseline LAN`)),
    };
    for(const surface of ['standalone', 'localhost', 'lan']){
      assert.equal(hashes[surface], hashes.dist,
        `${world.name} old baseline ${surface} does not match old dist`);
    }
    report[world.name] = hashes;
  }
  return { skipped: false, ...report };
}

async function startArtifactServer(artifact){
  const sockets = new Set();
  const server = createServer((request, response) => {
    if(request.url === '/' || request.url?.startsWith('/?') || request.url === '/index.html'){
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(artifact);
      return;
    }
    if(request.url === '/favicon.ico'){
      response.writeHead(204); response.end(); return;
    }
    response.writeHead(404); response.end();
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await timebox(new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }), OP_TIMEOUT_MS, 'start Phase 4 artifact server');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close(){
      server.closeAllConnections?.();
      for(const socket of sockets) socket.destroy();
      await timebox(new Promise(resolve => server.close(() => resolve())), 5_000, 'close Phase 4 artifact server');
    },
  };
}

const trackedPages = new Set();
const GUARDED_PAGE_METHODS = Object.freeze([
  'setViewport', 'goto', 'waitForFunction', 'evaluate', 'screenshot', 'setContent', 'close',
]);
function guardPage(page){
  for(const method of GUARDED_PAGE_METHODS){
    const original = page[method].bind(page);
    page[method] = (...args) => timebox(
      Promise.resolve().then(() => original(...args)),
      method === 'close' ? CLEANUP_TIMEOUT_MS : OP_TIMEOUT_MS,
      `Phase 4 page.${method}`,
    );
  }
  trackedPages.add(page);
  return page;
}

async function newGuardedPage(browser, label = 'new Phase 4 page'){
  const page = await timebox(browser.newPage(), OP_TIMEOUT_MS, label);
  return guardPage(page);
}

async function closeTrackedPage(page){
  try { await page.close(); }
  finally { trackedPages.delete(page); }
}

async function openPage(browser, origin, { lowfx = false, fast = true, viewport = SHOT_VIEWPORTS[0] } = {}){
  const page = await newGuardedPage(browser);
  page.setDefaultTimeout(OP_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(OP_TIMEOUT_MS);
  await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if(message.type() === 'error') errors.push(message.text()); });
  const query = new URLSearchParams();
  if(lowfx) query.set('lowfx', '1');
  if(fast) query.set('fast', '1');
  await page.goto(`${origin}/?${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gp?.visual?.phase === 4);
  await settleFrames(page, 4);
  return { page, errors };
}

function assertVisualContract(visual, { lowfx = false, title = false } = {}){
  assert.equal(visual.phase, 4);
  assert.equal(visual.couriers.length, 4);
  assert.equal(visual.courierContract.topLevelRoots, true);
  assert.equal(visual.courierContract.independentRigs, true);
  assert.equal(visual.courierContract.sharedGeometry, true);
  assert.equal(visual.courierContract.distinctProfiles, true);
  assert.equal(visual.courierContract.distinctSilhouettes, true);
  assert.equal(visual.courierContract.distinctCadences, true);
  for(const courier of visual.couriers){
    assert.equal(courier.namedBilateralJoints, true, `${courier.profileId}: bilateral joint contract`);
    assert.equal(courier.deterministicPose, true, `${courier.profileId}: deterministic pose contract`);
    assert.equal(courier.asymmetricParcel, true, `${courier.profileId}: asymmetric parcel contract`);
    assert.equal(courier.tetherFromParcelEye, true, `${courier.profileId}: parcel-eye tether contract`);
    assert.equal(courier.layeredAthleticShell, true, `${courier.profileId}: layered athletic shell contract`);
  }
  assert.ok(visual.camera.fov >= 46 && visual.camera.fov <= 48.05, `camera FOV escaped 46–48° (${visual.camera.fov})`);
  assert.equal(visual.camera.chaseFov, 47);
  assert.equal(visual.camera.titleAzimuthDegrees, 47);
  if(title) assert.equal(visual.camera.framing.allFourInFrame, true, 'title must frame all four couriers');
  assert.equal(visual.slideClearance.clears, true);
  assert.equal(visual.slideClearance.samples, 65);
  assert.equal(visual.slideClearance.profiles, 4);
  assert.equal(visual.slideClearance.finite, true);
  assert.equal(visual.slideClearance.neverBelowDeck, true);
  assert.equal(visual.slideClearance.neverAboveTarget, true);
  assert.ok(visual.slideClearance.topAboveDeck < visual.slideClearance.gateBoundaryHeight - 0.03);
  assert.equal(visual.actionPoses.samples, 288);
  assert.equal(visual.actionPoses.profiles, 4);
  assert.equal(visual.actionPoses.states.length, 8);
  assert.equal(visual.actionPoses.finite, true);
  assert.equal(visual.actionPoses.neverBelowDeck, true);
  assert.deepEqual(visual.districts.districts.map(district => district.name), EXPECTED_DISTRICTS);
  assert.equal(visual.districts.allDecorationsClearCueCorridor, true);
  assert.equal(visual.districts.unsafeDecorations.length, 0);
  assert.equal(visual.districts.landmark.id, 'aster-relay');
  assert.ok(visual.districts.instancedMeshes >= 10);
  const geometryAudit = visual.districts.geometryAudit;
  assert.equal(geometryAudit.ok, true);
  assert.equal(geometryAudit.source, 'actual-world-bounds');
  assert.equal(geometryAudit.basis, 'rendered-world-bounds');
  assert.ok(geometryAudit.registryExpected > 20);
  assert.equal(geometryAudit.checkedMeshes, geometryAudit.registryExpected);
  assert.ok(geometryAudit.inspectedInstances > 20);
  assert.equal(geometryAudit.probeCount, geometryAudit.checkedBounds * 9);
  for(const key of ['detached', 'missingRenderables', 'countMismatches', 'unexpectedRenderables', 'nonFinite', 'violations']){
    assert.deepEqual(geometryAudit[key], [], `baseline district audit has ${key}`);
  }
  assert.equal(visual.districts.moverAllocation.transientAllocations, 0);
  assert.equal(visual.districts.moverAllocation.stablePoseOutputs, true);

  const budget = lowfx
    ? { calls: 145, transparent: 16, triangles: 90_000 }
    : { calls: 180, transparent: 24, triangles: 160_000 };
  assert.ok(visual.frame.calls <= budget.calls, `${lowfx ? 'lowfx' : 'normal'} calls ${visual.frame.calls}/${budget.calls}`);
  assert.ok(visual.frame.triangles <= budget.triangles, `${lowfx ? 'lowfx' : 'normal'} triangles ${visual.frame.triangles}/${budget.triangles}`);
  assert.ok(visual.resources.transparentRenderables <= budget.transparent,
    `${lowfx ? 'lowfx' : 'normal'} transparent renderables ${visual.resources.transparentRenderables}/${budget.transparent}`);
  assert.ok(visual.resources.geometries <= 72);
  assert.ok(visual.resources.materials <= 36);
  assert.ok(visual.resources.shadowCasters <= 16);
  assert.ok(visual.resources.textures <= 8);
  assert.ok(visual.resources.largestTextureEdge <= 1024);
  assert.equal(visual.resources.finiteTransforms, true);
}

function assertHotPaths(hotPaths){
  assert.ok(hotPaths.title.stageCalls > 0, 'title staging hot path was not exercised');
  assert.equal(hotPaths.title.lineupStable, true);
  assert.equal(hotPaths.title.poseOutputsStable, true);
  assert.equal(hotPaths.couriers.identitiesStable, true);
  assert.equal(hotPaths.couriers.rows.length, 4);
  for(const row of hotPaths.couriers.rows){
    assert.equal(row.scratchStable, true, `${row.profileId}: tether scratch identity changed`);
    assert.equal(row.attributeStable, true, `${row.profileId}: tether attribute identity changed`);
    assert.equal(row.arrayStable, true, `${row.profileId}: tether array identity changed`);
    assert.equal(row.resetJointNamesStable, true, `${row.profileId}: joint reset list identity changed`);
  }
  assert.ok(hotPaths.districts.calls > 0, 'district tick hot path was not exercised');
  assert.ok(hotPaths.districts.moverWrites >= hotPaths.districts.calls * hotPaths.districts.moverCount);
  assert.equal(hotPaths.districts.transientAllocations, 0);
  assert.equal(hotPaths.districts.stablePoseOutputs, true);
  assert.equal(hotPaths.districts.usesPoseAtInto, true);
}

async function districtSafetyMutationGate(page){
  const reports = await page.evaluate(() => {
    const rows = [];
    const record = (name, mutate, restore) => {
      const mutated = mutate();
      const restored = restore();
      rows.push({ name, mutated, restored });
    };
    record('move-relay', () => __gp.debugMoveAsterRelayIntoCorridor(58), () => {
      __gp.restoreAsterRelay(); return __gp.renderedCorridor;
    });
    record('scale-relay', () => __gp.debugScaleAsterRelay(12), () => {
      __gp.restoreScaledAsterRelay(); return __gp.renderedCorridor;
    });
    record('move-instance', () => __gp.debugMoveDistrictInstanceIntoCorridor(92), () => {
      __gp.restoreDistrictInstance(); return __gp.renderedCorridor;
    });
    record('detach-relay', () => __gp.debugDetachDistrictDecoration(), () => {
      __gp.restoreDistrictDecoration(); return __gp.renderedCorridor;
    });
    record('remove-relay-mast', () => __gp.debugRemoveRelayPart(), () => {
      __gp.restoreRelayPart(); return __gp.renderedCorridor;
    });
    record('detach-instanced-mesh', () => __gp.debugDetachDistrictInstanceMesh(), () => {
      __gp.restoreDistrictInstanceMesh(); return __gp.renderedCorridor;
    });
    record('decrement-instance-count', () => __gp.debugDecrementDistrictInstanceCount(), () => {
      __gp.restoreDistrictInstanceCount(); return __gp.renderedCorridor;
    });
    return { baseline: __gp.renderedCorridor, rows, final: __gp.restoreDistrictSafetyMutations() };
  });
  assert.equal(reports.baseline.ok, true);
  for(const row of reports.rows){
    assert.equal(row.mutated.ok, false, `${row.name}: mutation escaped actual geometry audit`);
    assert.equal(row.restored.ok, true, `${row.name}: direct restoration did not recover baseline`);
  }
  assert.ok(reports.rows.find(row => row.name === 'move-relay').mutated.violations.length > 0);
  assert.ok(reports.rows.find(row => row.name === 'scale-relay').mutated.violations.length > 0);
  assert.ok(reports.rows.find(row => row.name === 'move-instance').mutated.violations.length > 0);
  assert.ok(reports.rows.find(row => row.name === 'detach-relay').mutated.detached.length > 0);
  assert.ok(reports.rows.find(row => row.name === 'remove-relay-mast').mutated.detached
    .some(entry => entry.name === 'aster-relay:tapered-mast'));
  assert.ok(reports.rows.find(row => row.name === 'detach-instanced-mesh').mutated.detached
    .some(entry => entry.name.includes('parcel-lockers')));
  assert.ok(reports.rows.find(row => row.name === 'decrement-instance-count').mutated.countMismatches.length > 0);
  assert.equal(reports.final.ok, true);
  return reports.rows.map(row => ({
    name: row.name,
    violations: row.mutated.violations.length,
    detached: row.mutated.detached.length,
    countMismatches: row.mutated.countMismatches.length,
  }));
}

async function settleFrames(page, count = 4){
  await page.evaluate(frameCount => new Promise(resolve => {
    let remaining = frameCount;
    const next = () => { if((remaining -= 1) <= 0) resolve(); else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }), count);
}

async function captureBoth(page, name){
  assert.equal(RELEASE, true, 'screenshots are release-only');
  assert.ok(SHOT_NAMES.includes(name), `unknown Phase 4 shot ${name}`);
  const paths = [];
  for(const viewport of SHOT_VIEWPORTS){
    const directory = join(OUTPUT_ROOT, 'phase4-shots', viewport.key);
    await mkdir(directory, { recursive: true });
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: true });
    await settleFrames(page);
    const path = join(directory, `${name}.png`);
    await page.screenshot({ path, type: 'png' });
    paths.push(path);
  }
  return paths;
}

async function positionSnapshot(page, s, { speed = 12.4, lowfx = false } = {}){
  await page.evaluate(({ courseS, courseSpeed }) => {
    __gp.slowmo(0);
    __gp.debugSetCourseS(courseS, { speed: courseSpeed, lane: 0 });
  }, { courseS: s, courseSpeed: speed });
  await settleFrames(page, 6);
  const visual = await page.evaluate(() => __gp.visual);
  assertVisualContract(visual, { lowfx });
  return visual;
}

async function budgetSweep(browser, origin, lowfx){
  const { page, errors } = await openPage(browser, origin, { lowfx, fast: true, viewport: lowfx ? SHOT_VIEWPORTS[1] : SHOT_VIEWPORTS[0] });
  try {
    const title = await page.evaluate(() => __gp.visual);
    assertVisualContract(title, { lowfx, title: true });
    const hotPaths = await page.evaluate(() => __gp.hotPaths);
    assertHotPaths(hotPaths);
    const corridorMutations = lowfx ? [] : await districtSafetyMutationGate(page);
    await page.evaluate(() => __gp.start());
    await page.waitForFunction(() => __gp.mode === 'tutorial');
    const samples = [];
    for(const s of [5, 55, 75, 145]) samples.push(await positionSnapshot(page, s, { lowfx }));
    assert.deepEqual(errors, [], `${lowfx ? 'lowfx' : 'normal'} page errors`);
    return {
      title: { calls: title.frame.calls, triangles: title.frame.triangles },
      samples: samples.map(sample => ({ s: sample.courseS, calls: sample.frame.calls, triangles: sample.frame.triangles })),
      resources: title.resources,
      hotPaths,
      corridorMutations,
    };
  } finally {
    await closeTrackedPage(page);
  }
}

function deterministicTerminal(snapshot){
  return {
    headline: snapshot.resultsPresentation.headline,
    standings: snapshot.terminalSnapshot.standings.map(entry => ({
      id: entry.id, rank: entry.rank, finishTime: entry.finishTime,
    })),
  };
}

async function shotAndReplayGate(browser, origin){
  // Real cinematic durations keep both requested resolutions inside the
  // genuine finish/recovery modes without adding a production flow override.
  const { page, errors } = await openPage(browser, origin, { lowfx: false, fast: false, viewport: SHOT_VIEWPORTS[0] });
  const report = { shots: [], replayResources: [], terminals: [] };
  try {
    const opening = await page.evaluate(() => __gp.visual);
    assertVisualContract(opening, { title: true });
    report.shots.push(...await captureBoth(page, 'opening'));

    await page.evaluate(() => __gp.start());
    await page.waitForFunction(() => __gp.mode === 'tutorial');
    // Let the real countdown and tutorial toast finish before composing the
    // hero/gameplay frames. The screenshots should assess the production
    // scene, not a transient onboarding overlay.
    await page.waitForFunction(() => {
      const toast = document.getElementById('toast');
      return toast && Number.parseFloat(getComputedStyle(toast).opacity) === 0;
    });
    await positionSnapshot(page, 14, { speed: 10.5 });
    report.shots.push(...await captureBoth(page, 'hero-s14'));

    await positionSnapshot(page, 60, { speed: 12.4 });
    report.shots.push(...await captureBoth(page, 'gameplay-s60'));

    await page.evaluate(() => {
      __gp.slowmo(0);
      __gp.debugSetCourseS(91, { speed: 12.2, lane: 0 });
      __gp.action('down');
      __gp.slowmo(1);
    });
    await page.waitForFunction(() => __gp.slide === true);
    await page.evaluate(() => __gp.slowmo(0));
    const slideVisual = await page.evaluate(() => __gp.visual);
    assert.equal(slideVisual.slideClearance.clears, true);
    report.shots.push(...await captureBoth(page, 'slide-s90-92'));

    await page.evaluate(() => {
      const hazard = __dbg.course.hazardById('final-gap-01');
      const pad = __dbg.course.safePadById(hazard.safePadId);
      __gp.setAuto(false);
      __gp.debugSetCourseS(hazard.s0 - 0.4, { speed: 14, shields: 3, lane: 0, lastSafePad: pad.resumeS });
      __gp.slowmo(1);
    });
    await page.waitForFunction(() => __gp.mode === 'recover' && __gp.simulation.status === 'recovering', { polling: 4 });
    await page.evaluate(() => __gp.slowmo(0));
    assert.ok(await page.evaluate(() => __gp.recoveryCount >= 1 && __gp.lastRecoveryReason === 'final-gap-01'),
      'recovery shot must be a genuine final-gap recovery');
    const recoveryStory = await page.evaluate(() => __gp.visual.recoveryStory);
    assert.equal(recoveryStory.active, true);
    assert.equal(recoveryStory.heroTetherVisible, true);
    assert.equal(recoveryStory.anchorVisible, true);
    assert.equal(recoveryStory.trailVisible, true);
    assert.ok(recoveryStory.trailPoints >= 2);
    assert.ok(recoveryStory.safeS < recoveryStory.fromS);
    assert.ok(recoveryStory.anchorS > recoveryStory.safeS && recoveryStory.anchorS < recoveryStory.fromS);
    assert.ok(recoveryStory.tetherTargetDelta <= 1e-5,
      `recovery tether missed actual anchor by ${recoveryStory.tetherTargetDelta}`);
    report.recoveryStory = recoveryStory;
    report.shots.push(...await captureBoth(page, 'genuine-recovery'));

    await page.evaluate(() => __gp.slowmo(1));
    await page.waitForFunction(() => __gp.mode === 'tutorial' || __gp.mode === 'race');
    // Release imagery reaches the terminal through the real course/autopilot,
    // never a direct finish-position mutation.
    await page.evaluate(() => { __gp.setAuto(true); __gp.setWarp(10); __gp.slowmo(1); });
    await page.waitForFunction(() => __gp.mode === 'finish', { polling: 2 });
    const terminalHud = await page.evaluate(() => ({ tag: __gp.statusTag.text, distance: __gp.dist }));
    assert.deepEqual(terminalHud, { tag: 'TRAINING CLEAR', distance: 150 }, 'finish HUD retained stale checkpoint state');
    const finishPoses = await page.evaluate(() => __gp.visual.terminalPoses);
    assert.equal(finishPoses.length, 4);
    assert.equal(finishPoses.find(row => row.profileId === 'player')?.pose, 'fail');
    assert.equal(finishPoses.filter(row => row.pose === 'win').length, 1);
    report.shots.push(...await captureBoth(page, 'finish'));
    await page.waitForFunction(() => __gp.mode === 'results');

    const terminalPresentation = await page.evaluate(() => ({
      visual: __gp.visual,
      snapshot: __gp.terminalSnapshot,
      results: __gp.resultsPresentation,
    }));
    const warm = terminalPresentation.visual;
    const ordered = [...terminalPresentation.snapshot.standings].sort((a, b) => a.rank - b.rank);
    assert.deepEqual(ordered.map(entry => entry.rank), [1, 2, 3, 4]);
    assert.deepEqual([...ordered.map(entry => entry.id)].sort(), ['jet', 'nyx', 'player', 'volt']);
    assert.equal(ordered[0].id, 'jet');
    const playerStanding = ordered.find(entry => entry.id === 'player');
    assert.equal(terminalPresentation.results.headline,
      ['1ST', '2ND', '3RD', '4TH'][playerStanding.rank - 1]);
    assert.match(terminalPresentation.results.rowsText, /YOU/);
    assert.match(terminalPresentation.results.rowsText, /JET/);
    report.terminal = {
      hud: terminalHud,
      poses: finishPoses,
      headline: terminalPresentation.results.headline,
      standings: ordered.map(({ id, rank, finishTime }) => ({ id, rank, finishTime })),
    };
    const referenceResources = { resources: warm.resources, memory: {
      geometries: warm.frame.geometries,
      textures: warm.frame.textures,
    } };
    let reference = null;
    for(let replay = 1; replay <= 3; replay += 1){
      const again = await page.evaluate(() => __gp.again());
      assert.equal(again?.ok ?? again, true, `replay ${replay} did not start`);
      await page.evaluate(() => { __gp.setAuto(true); __gp.setWarp(10); __gp.slowmo(1); });
      await page.waitForFunction(() => __gp.mode === 'results');
      const snapshot = await page.evaluate(() => ({
        terminalSnapshot: __gp.terminalSnapshot,
        resultsPresentation: __gp.resultsPresentation,
        visual: __gp.visual,
      }));
      const terminal = deterministicTerminal(snapshot);
      if(!reference) reference = terminal;
      else assert.deepEqual(terminal, reference, `replay ${replay} changed deterministic standings/times`);
      const resources = { resources: snapshot.visual.resources, memory: {
        geometries: snapshot.visual.frame.geometries,
        textures: snapshot.visual.frame.textures,
      } };
      assert.deepEqual(resources, referenceResources, `replay ${replay} grew render resources`);
      report.terminals.push(terminal);
      report.replayResources.push(resources);
    }
    assert.deepEqual(errors, [], 'shot/replay page errors');
    return report;
  } finally {
    await closeTrackedPage(page);
  }
}

async function buildFrameBoard(browser){
  assert.equal(RELEASE, true, 'frame board is release-only');
  const images = await Promise.all(SHOT_NAMES.map(async name => ({
    name,
    data: (await readFile(join(OUTPUT_ROOT, 'phase4-shots', '1366x1024', `${name}.png`))).toString('base64'),
  })));
  const page = await newGuardedPage(browser, 'new Phase 4 frame-board page');
  try {
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    const panels = images.map((image, index) => `
      <figure><img src="data:image/png;base64,${image.data}"><figcaption><b>0${index + 1}</b>${image.name.replaceAll('-', ' ').toUpperCase()}</figcaption></figure>`).join('');
    await page.setContent(`<!doctype html><style>
      *{box-sizing:border-box}html,body{margin:0;background:#070a14;color:#eef6ff;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial}
      body{width:1440px;height:900px;padding:24px}header{height:52px;display:flex;align-items:flex-start;justify-content:space-between;border-top:1px solid #2ee6ff;padding-top:10px;letter-spacing:.25em;font-size:12px}header b{font-size:20px;letter-spacing:.04em}header span{color:#70dff2}
      main{display:grid;grid-template-columns:repeat(3,1fr);gap:15px}figure{margin:0;background:#0d1222;border:1px solid #26324d;overflow:hidden}img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}figcaption{height:30px;padding:8px 10px;color:#9facbf;font-size:9px;letter-spacing:.2em}figcaption b{color:#ff4bc7;margin-right:9px}
      footer{display:flex;justify-content:space-between;margin-top:13px;color:#68758b;font-size:9px;letter-spacing:.22em}footer b{color:#74f4d1}
    </style><header><b>GRIDLOCK RUN // PHASE 4</b><span>150M PRODUCTION VISUAL PASS · IPAD FRAME BOARD</span></header><main>${panels}</main><footer><span>DISPATCH ROOF → ASTER RELAY</span><b>ARTICULATED COURIERS · COURSE-FED DISTRICTS · VERIFIED RECOVERY</b></footer>`);
    const boardPath = join(OUTPUT_ROOT, 'gridlock-run-v1-frames.png');
    await page.screenshot({ path: boardPath, type: 'png' });
    return boardPath;
  } finally {
    await closeTrackedPage(page);
  }
}

let artifactServer = null;
let browser = null;
let report = null;
let primaryError = null;
const cleanupErrors = [];
const handleScope = createIdentityHandleScope({
  ignoredHandles: [process.stdin, process.stdout, process.stderr].filter(Boolean),
});

try {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  // Source integrity is checked before Vite, HTTP, Chromium, or any browser
  // page is allowed to start.
  const frozenSources = await verifyFrozenSources();
  const [runnerBuild, golfBuild] = await Promise.all([
    freshBuild('runner', join(OUTPUT_ROOT, 'builds')),
    freshBuild('golf', join(OUTPUT_ROOT, 'builds')),
  ]);
  assert.ok(runnerBuild.rawBytes <= 1.25 * 1024 * 1024, `Runner bundle ${runnerBuild.rawBytes} exceeds 1.25MB`);
  assert.ok(runnerBuild.gzipBytes <= 350 * 1024, `Runner gzip ${runnerBuild.gzipBytes} exceeds 350KB`);
  const baselineOld = await baselineOldParity();
  artifactServer = await startArtifactServer(runnerBuild.artifact);
  browser = await timebox(puppeteer.launch({
    headless: 'new', executablePath: resolveChromeExecutable(), timeout: OP_TIMEOUT_MS, protocolTimeout: 120_000,
    userDataDir: join(TEMP_DIR, 'chrome-profile'),
    args: [
      '--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      `--playforge-run-marker=${RUN_MARKER}`,
    ],
  }), OP_TIMEOUT_MS, 'launch Phase 4 browser');

  if(FIXTURE === 'post-boot-sync-hang'){
    console.error(`runner-phase4-post-boot-sync-hang:${RUN_MARKER}`);
    while(true){}
  }
  if(FIXTURE === 'page-evaluate-hang'){
    const fixturePage = await newGuardedPage(browser, 'new fixture page');
    console.error(`runner-phase4-page-evaluate-hang:${RUN_MARKER}`);
    await timebox(fixturePage.evaluate(() => new Promise(() => {})), INJECT_TIMEOUT_MS, 'injected never-resolving evaluate');
  }
  if(FIXTURE === 'close-failure'){
    const markerOwned = spawnCapturedGatedNode({
      title: scopedGatedTitle(`${RUN_MARKER}:close-fallback`),
      args: [WAIT_FIXTURE, `${RUN_MARKER}:close-fallback-target`],
      stdio: 'ignore',
    });
    await releaseCapturedGatedNode(markerOwned);
    const markerChild = markerOwned.child;
    markerChild.unref();
    console.error(`runner-phase4-close-failure:${RUN_MARKER}`);
    throw new Error('injected browser close failure');
  }

  const normal = await budgetSweep(browser, artifactServer.origin, false);
  const lowfx = await budgetSweep(browser, artifactServer.origin, true);
  const shotsAndReplays = RELEASE
    ? await shotAndReplayGate(browser, artifactServer.origin)
    : { shots: [], replayResources: [], terminals: [], recoveryStory: null, terminal: null };
  const frameBoard = RELEASE ? await buildFrameBoard(browser) : null;
  report = {
    mode: MODE,
    releaseEligible: false,
    marker: RUN_MARKER,
    frozenSources,
    candidateFresh: { runner: runnerBuild.hash, golf: golfBuild.hash },
    bundle: { rawBytes: runnerBuild.rawBytes, gzipBytes: runnerBuild.gzipBytes },
    baselineOld, normal, lowfx,
    shots: shotsAndReplays.shots,
    replayResources: shotsAndReplays.replayResources,
    recoveryStory: shotsAndReplays.recoveryStory,
    terminal: shotsAndReplays.terminal,
    frameBoard,
    skips: {
      parity: RELEASE ? { skipped: false } : baselineOld,
      screenshots: RELEASE ? { skipped: false } : { skipped: true, reason: 'development gate never writes or promotes screenshots' },
      frameBoard: RELEASE ? { skipped: false } : { skipped: true, reason: 'development gate never writes or promotes a frame board' },
      replay: RELEASE ? { skipped: false } : { skipped: true, reason: 'three-run release replay gate excluded from fast development audit' },
      promotion: { skipped: true, reason: 'worker cannot promote; parent may promote only after validation and cleanup' },
    },
    artifacts: { outputRoot: OUTPUT_ROOT, report: REPORT_PATH },
  };
} catch(error){
  primaryError = error;
} finally {
  for(const page of [...trackedPages]){
    try { await closeTrackedPage(page); }
    catch(error){ cleanupErrors.push(error); }
  }
  if(browser){
    const browserProcess = browser.process?.();
    try {
      if(FIXTURE === 'close-failure'){
        await timebox(new Promise(() => {}), INJECT_TIMEOUT_MS, 'injected browser close hang');
      } else {
        await timebox(browser.close(), CLEANUP_TIMEOUT_MS, 'close Phase 4 browser');
      }
    } catch(error){
      cleanupErrors.push(error);
      try { browserProcess?.kill('SIGKILL'); }
      catch(killError){ if(killError?.code !== 'ESRCH') cleanupErrors.push(killError); }
      try { await timebox(Promise.resolve().then(() => browser.disconnect()), CLEANUP_TIMEOUT_MS, 'disconnect Phase 4 browser'); }
      catch(disconnectError){ cleanupErrors.push(disconnectError); }
    }
  }
  if(artifactServer){
    try { await artifactServer.close(); }
    catch(error){ cleanupErrors.push(error); }
  }
  await sleep(50);
  const residue = handleScope.classify();
  if(residue.handles.length || residue.requests.length){
    cleanupErrors.push(new Error(`worker leaked ${residue.handles.length} handles and ${residue.requests.length} requests`));
  }
}

if(primaryError || cleanupErrors.length){
  throw new AggregateError(
    [primaryError, ...cleanupErrors].filter(Boolean),
    `Phase 4 worker failed (${[primaryError, ...cleanupErrors].filter(Boolean).map(error => error.message).join('; ')})`,
  );
}
await writeReport(report);
console.log(`runner.phase4 worker complete (${MODE})`);
