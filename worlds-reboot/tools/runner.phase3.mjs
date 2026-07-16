/* Gridlock Run Phase 3 hard gate — pure determinism + fresh iPad touch paths. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { KnownDevices } from 'puppeteer';
import { createFixedStepRunner } from '../engine/fixed-step.js';
import { createRunnerCourseModel } from '../runner/src/course.js';
import { createRunnerSim } from '../runner/src/sim.js';
import { createIdentityHandleScope } from './active-handle-scope.mjs';
import { resolveChromeExecutable } from './chrome-path.mjs';
import { assertContainedPhaseTarget } from './phase-target-bootstrap.mjs';

if(process.platform === 'win32'){
  throw new Error('Gridlock Run browser verification requires POSIX process-group isolation; win32 is unsupported');
}
assertContainedPhaseTarget('Runner browser worker');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
assert.deepEqual(process.argv.slice(2), [], 'Runner browser worker accepts no direct arguments');
const CANDIDATE_MODE = process.env.RUNNER_PHASE3_CANDIDATE_MODE === '1';
const CANDIDATE_REPORT_PATH = process.env.PLAYFORGE_CANDIDATE_REPORT_PATH
  ? resolve(process.env.PLAYFORGE_CANDIDATE_REPORT_PATH) : null;
if(CANDIDATE_MODE){
  assert.ok(CANDIDATE_REPORT_PATH, 'Runner candidate mode requires PLAYFORGE_CANDIDATE_REPORT_PATH');
  const ownedTemp = resolve(process.env.TMPDIR || tmpdir());
  const offset = relative(ownedTemp, CANDIDATE_REPORT_PATH);
  assert.ok(offset && !offset.startsWith('..') && !isAbsolute(offset), 'Runner candidate report must be inside outer temp');
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const closeEnough = (a, b, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;
const trackedPages = new Set();
const trackedCdpSessions = new Set();
const ignoredStdioHandles = new Set([process.stdin, process.stdout, process.stderr]);
// Let the ESM loader's transient FileHandleCloseReq retire before defining the
// ownership boundary. Persistent caller handles survive this turn and retain
// their exact object identity in composed-audit mode.
await new Promise(resolve => setImmediate(resolve));
const handleScope = createIdentityHandleScope({ ignoredHandles: ignoredStdioHandles });
const allowCallerHandleBaseline = process.env.RUNNER_PHASE3_ALLOW_CALLER_HANDLES === '1';
const configuredPositiveInteger = (name, fallback) => {
  const raw = process.env[name];
  if(raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if(!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
};
const VITE_BUILD_TIMEOUT_MS = configuredPositiveInteger('RUNNER_PHASE3_VITE_TIMEOUT_MS', 120_000);
const ARTIFACT_HTTP_TIMEOUT_MS = configuredPositiveInteger('RUNNER_PHASE3_ARTIFACT_HTTP_TIMEOUT_MS', 10_000);
const CDP_TIMEOUT_MS = configuredPositiveInteger('RUNNER_PHASE3_CDP_TIMEOUT_MS', 5_000);
const ARTIFACT_TEMP_PREFIX = process.env.RUNNER_PHASE3_TEMP_PREFIX || 'playforge-runner-phase3-';
if(!/^playforge-runner-phase3-[A-Za-z0-9_-]*$/.test(ARTIFACT_TEMP_PREFIX)){
  throw new RangeError('RUNNER_PHASE3_TEMP_PREFIX must be a safe playforge-runner-phase3-…- prefix');
}

function timebox(promise, milliseconds, label){
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function safeCall(callback, fallback = null){
  try { return callback(); }
  catch { return fallback; }
}

function internalEndpoint(handle, method){
  const operation = handle?._handle?.[method];
  if(typeof operation !== 'function') return null;
  const endpoint = {};
  const result = safeCall(() => operation.call(handle._handle, endpoint), -1);
  if(result !== 0 && result !== undefined) return null;
  if(endpoint.address === undefined && endpoint.port === undefined && endpoint.path === undefined) return null;
  return endpoint;
}

function publicEndpoint(handle, side){
  const address = handle?.[`${side}Address`];
  const port = handle?.[`${side}Port`];
  const family = handle?.[`${side}Family`];
  if(address !== undefined || port !== undefined || family !== undefined) return { address, port, family };
  if(side === 'local' && typeof handle?.address === 'function'){
    const value = safeCall(() => handle.address());
    if(value && typeof value === 'object') return value;
    if(typeof value === 'string') return { path: value };
  }
  return null;
}

function describeHandle(handle){
  const publicHasRef = typeof handle?.hasRef === 'function' ? safeCall(() => handle.hasRef()) : null;
  const handleHasRef = typeof handle?._handle?.hasRef === 'function'
    ? safeCall(() => handle._handle.hasRef())
    : null;
  return {
    type: handle?.constructor?.name || typeof handle,
    publicFd: Number.isInteger(handle?.fd) ? handle.fd : null,
    handleFd: Number.isInteger(handle?._handle?.fd) ? handle._handle.fd : null,
    pid: Number.isInteger(handle?.pid) ? handle.pid : null,
    publicLocal: publicEndpoint(handle, 'local'),
    publicRemote: publicEndpoint(handle, 'remote'),
    handleLocal: internalEndpoint(handle, 'getsockname'),
    handleRemote: internalEndpoint(handle, 'getpeername'),
    hasRef: publicHasRef ?? handleHasRef,
    publicHasRef,
    handleHasRef,
    destroyed: typeof handle?.destroyed === 'boolean' ? handle.destroyed : null,
    listening: typeof handle?.listening === 'boolean' ? handle.listening : null,
  };
}

function activeHandleDiagnostics(){
  const ownership = handleScope.classify();
  return {
    resources: typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [],
    // A composed audit may already own resources (for example Golf's browser
    // pipe) before Runner is imported. Report those separately and fail only
    // resources created during this Runner gate. The standalone hard gate has
    // no non-stdio baseline, so its zero-leak contract remains absolute.
    baselineHandles: ownership.baselineHandles.map(describeHandle),
    baselineRequests: ownership.baselineRequests.map(describeHandle),
    handles: ownership.handles.map(describeHandle),
    requests: ownership.requests.map(describeHandle),
  };
}

async function assertNoActiveHarnessHandles(milliseconds = 2_000){
  const deadline = Date.now() + milliseconds;
  let diagnostics;
  do {
    diagnostics = activeHandleDiagnostics();
    if(diagnostics.handles.length === 0 && diagnostics.requests.length === 0) return diagnostics;
    await sleep(25);
  } while(Date.now() < deadline);
  throw new Error(`Runner harness leaked active handles after cleanup: ${JSON.stringify(diagnostics)}`);
}

async function detachCdpSession(session){
  if(!session) return;
  try {
    await timebox(session.detach(), CDP_TIMEOUT_MS, 'CDP detach');
  } finally {
    trackedCdpSessions.delete(session);
  }
}

function cdpSend(session, method, parameters){
  return timebox(session.send(method, parameters), CDP_TIMEOUT_MS, `CDP ${method}`);
}

/* ---------------- pure fixed-step cadence / stall determinism ---------------- */
function runPureCadence(cadence, { initialStall = 0 } = {}){
  const course = createRunnerCourseModel();
  const simulation = createRunnerSim({ course });
  let completedSteps = 0;
  let runner;
  runner = createFixedStepRunner({
    step: 1 / 120,
    maxFrame: 0.1,
    maxSteps: 120,
    onStep(dt){
      simulation.step(dt);
      completedSteps += 1;
      if(completedSteps === 240) runner.setSimulating(false);
    },
  });
  let suppliedWall = 0;
  if(initialStall){
    runner.advance(initialStall);
    suppliedWall += initialStall;
  }
  let frame = 0;
  while(completedSteps < 240 && frame < 5000){
    const delta = cadence[frame % cadence.length];
    runner.advance(delta);
    suppliedWall += delta;
    frame += 1;
  }
  assert.equal(completedSteps, 240, 'pure runner fixture must execute exactly 240 fixed steps');
  return { snapshot: simulation.snapshot(), clock: runner.state, suppliedWall, frames: frame };
}

function pureDeterminismGate(){
  const sixty = runPureCadence([1 / 60]);
  const mixed = runPureCadence([1 / 144, 1 / 90, 1 / 30, 1 / 75, 1 / 120]);
  const stalled = runPureCadence([1 / 60], { initialStall: 0.5 });
  const numericKeys = ['s', 'speed', 'lane', 'lanePosition', 'targetLane', 'yRel', 'vy', 'coyoteRemaining', 'slideRemaining', 'simulationTime'];
  for(const key of numericKeys){
    if(!Number.isFinite(sixty.snapshot[key])) continue;
    assert.ok(closeEnough(sixty.snapshot[key], mixed.snapshot[key], 1e-10), `mixed cadence changed ${key}`);
    assert.ok(closeEnough(sixty.snapshot[key], stalled.snapshot[key], 1e-10), `stall cadence changed ${key}`);
  }
  assert.ok(stalled.clock.droppedTime >= 0.399, '0.5s wall stall must be truthfully recorded as dropped time');
  assert.ok(closeEnough(sixty.clock.simulationTime, 2, 1e-10), 'pure fixture simulation time');

  const course = createRunnerCourseModel();
  const anchorReport = course.debugAnchors();
  assert.equal(anchorReport.aligned, true);
  assert.equal(anchorReport.maxDelta, 0);
  assert.ok(anchorReport.anchors.length >= 40, 'course must expose all hazard/checkpoint/safe-pad anchors');
  const missingAnchorReport = course.debugAnchors({}, 1e-6);
  assert.equal(missingAnchorReport.aligned, false, 'supplied-but-missing observations must never fall back to canonical anchors');
  assert.equal(missingAnchorReport.missingCount, anchorReport.anchors.length * 2,
    'both geometry and collider observations must be required when an observation set is supplied');
  return { sixty, mixed, stalled, anchors: anchorReport.anchors.length };
}

/* ---------------- fresh standalone artifact + private no-cache server ---------------- */
function configuredArtifactEndpoints(){
  const localhostOrigin = process.env.PLAYFORGE_LOCALHOST_ORIGIN || 'http://127.0.0.1:8091';
  const lanOrigin = process.env.PLAYFORGE_LAN_ORIGIN || 'http://192.168.1.137:8091';
  const promotedUrl = (origin, pathname) => new URL(pathname, origin).href;
  return {
    runnerLocalhost: process.env.RUNNER_PHASE3_LOCALHOST_URL
      || process.env.PLAYFORGE_RUNNER_LOCALHOST_URL
      || promotedUrl(localhostOrigin, '/runner/gridlock-run-v1.html'),
    runnerLan: process.env.RUNNER_PHASE3_LAN_URL
      || process.env.PLAYFORGE_RUNNER_LAN_URL
      || promotedUrl(lanOrigin, '/runner/gridlock-run-v1.html'),
    golfLocalhost: process.env.RUNNER_PHASE3_GOLF_LOCALHOST_URL
      || process.env.PLAYFORGE_GOLF_LOCALHOST_URL
      || promotedUrl(localhostOrigin, '/golf/stackyard-golf-v1.html'),
    golfLan: process.env.RUNNER_PHASE3_GOLF_LAN_URL
      || process.env.PLAYFORGE_GOLF_LAN_URL
      || promotedUrl(lanOrigin, '/golf/stackyard-golf-v1.html'),
  };
}

function sha256(bytes){
  return createHash('sha256').update(bytes).digest('hex');
}

function readHttpArtifact(url, label){
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch(error){ reject(new Error(`${label} has an invalid URL: ${url}`, { cause: error })); return; }
    const get = parsed.protocol === 'https:' ? httpsGet : parsed.protocol === 'http:' ? httpGet : null;
    if(!get){ reject(new Error(`${label} must use http or https: ${url}`)); return; }
    let settled = false;
    const finish = (error, value) => {
      if(settled) return;
      settled = true;
      if(error) reject(error);
      else resolve(value);
    };
    const request = get(parsed, {
      agent: false,
      headers: { 'cache-control': 'no-cache', connection: 'close' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('aborted', () => finish(new Error(`${label} response aborted: ${url}`)));
      response.once('error', error => finish(new Error(`${label} response failed: ${url}`, { cause: error })));
      response.once('end', () => {
        const status = response.statusCode ?? 0;
        if(status < 200 || status >= 300){
          finish(new Error(`${label} returned HTTP ${status}: ${url}`));
          return;
        }
        finish(null, Buffer.concat(chunks));
      });
    });
    request.setTimeout(ARTIFACT_HTTP_TIMEOUT_MS, () => {
      request.destroy(new Error(`${label} exceeded ${ARTIFACT_HTTP_TIMEOUT_MS}ms: ${url}`));
    });
    request.once('error', error => finish(new Error(`${label} request failed: ${url}`, { cause: error })));
  });
}

async function artifactParityGate(freshRunnerArtifact, freshRunnerHash){
  const endpoints = configuredArtifactEndpoints();
  const runner = {
    fresh: freshRunnerHash,
    dist: sha256(await readFile(join(ROOT, 'runner', 'dist', 'index.html'))),
    standalone: sha256(await readFile(join(ROOT, 'runner', 'gridlock-run-v1.html'))),
    localhost: sha256(await readHttpArtifact(endpoints.runnerLocalhost, 'Runner localhost artifact')),
    lan: sha256(await readHttpArtifact(endpoints.runnerLan, 'Runner LAN artifact')),
  };
  // Byte equality is the release contract; hashing fresh bytes here prevents a
  // stale promoted artifact from validating newer source behavior.
  assert.equal(sha256(freshRunnerArtifact), freshRunnerHash, 'fresh Runner artifact hash changed in memory');
  for(const surface of ['dist', 'standalone', 'localhost', 'lan']){
    assert.equal(runner[surface], freshRunnerHash,
      `stale Runner ${surface} bytes: expected fresh ${freshRunnerHash}, received ${runner[surface]}`);
  }

  // The current combined touch audit promises Golf promotion parity as well.
  // Keep that promise executable whenever this Runner gate is used.
  const golf = {
    dist: sha256(await readFile(join(ROOT, 'golf', 'dist', 'index.html'))),
    standalone: sha256(await readFile(join(ROOT, 'golf', 'stackyard-golf-v1.html'))),
    localhost: sha256(await readHttpArtifact(endpoints.golfLocalhost, 'Golf localhost artifact')),
    lan: sha256(await readHttpArtifact(endpoints.golfLan, 'Golf LAN artifact')),
  };
  const golfAuthority = golf.dist;
  for(const surface of ['standalone', 'localhost', 'lan']){
    assert.equal(golf[surface], golfAuthority,
      `stale Golf ${surface} bytes: expected dist ${golfAuthority}, received ${golf[surface]}`);
  }
  return { endpoints, runner, golf };
}

async function createFreshArtifactServer(){
  const output = await mkdtemp(join(tmpdir(), ARTIFACT_TEMP_PREFIX));
  const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const build = spawnSync(process.execPath, [
    vite, 'build', 'runner', '--config', 'runner/vite.config.js',
    '--outDir', output, '--emptyOutDir',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: VITE_BUILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if(build.error || build.status !== 0){
    await rm(output, { recursive: true, force: true });
    const timeout = build.error?.code === 'ETIMEDOUT' ? ` after ${VITE_BUILD_TIMEOUT_MS}ms` : '';
    throw new Error(`fresh Runner build failed${timeout}\n${build.error?.message || ''}\n${build.stdout}\n${build.stderr}`);
  }
  let artifact;
  let parity;
  try {
    artifact = await readFile(join(output, 'index.html'));
    const hash = sha256(artifact);
    parity = CANDIDATE_MODE
      ? { skipped: true, reason: 'candidate mode tests fresh Runner behavior without requiring current promoted equality' }
      : await artifactParityGate(artifact, hash);
  } catch(error){
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  const hash = sha256(artifact);
  const sockets = new Set();
  const server = createServer((request, response) => {
    if(request.url === '/' || request.url?.startsWith('/?') || request.url === '/index.html'){
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(artifact);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch(error){
    server.closeAllConnections?.();
    for(const socket of sockets) socket.destroy();
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  server.unref();
  return {
    output,
    hash,
    parity,
    origin: `http://127.0.0.1:${server.address().port}`,
    url({ lowfx = true, fast = true } = {}){
      const query = new URLSearchParams();
      if(lowfx) query.set('lowfx', '1');
      if(fast) query.set('fast', '1');
      return `${this.origin}/?${query}`;
    },
    async close(){
      try {
        const closed = server.listening
          ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
          : Promise.resolve();
        // Destroy keep-alive clients immediately; waiting for server.close's
        // callback before doing this can deadlock teardown.
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        for(const socket of sockets) socket.destroy();
        await timebox(closed, 3_000, 'artifact server close');
      } finally {
        for(const socket of sockets) socket.destroy();
        sockets.clear();
        server.removeAllListeners();
        await rm(output, { recursive: true, force: true });
      }
    },
  };
}

let browser = null;
let artifactServer = null;

function releaseBrowserProcessHandles(child){
  if(!child) return;
  for(const stream of child.stdio || []){
    stream?.destroy?.();
    stream?.unref?.();
  }
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
  child.stdin?.destroy?.();
  child.unref?.();
}

async function closeBrowserDeterministically(instance){
  if(!instance) return;
  const child = instance.process?.() || null;
  let closeError = null;
  try {
    await timebox(instance.close(), 5_000, 'Puppeteer browser close');
  } catch(error){
    closeError = error;
    try {
      await timebox(Promise.resolve(instance.disconnect?.()), 1_000, 'Puppeteer browser disconnect');
    } catch(disconnectError){
      closeError = new AggregateError([error, disconnectError],
        'Puppeteer browser close and disconnect both failed');
    }
  } finally {
    releaseBrowserProcessHandles(child);
  }
  if(closeError) throw closeError;
}

async function teardownRunnerHarness(){
  const errors = [];
  const capture = async (label, operation) => {
    try { await operation(); }
    catch(error){ errors.push(new Error(`${label}: ${error?.message || error}`, { cause: error })); }
  };
  await capture('CDP session teardown', async () => {
    try {
      const outcomes = await timebox(
        Promise.allSettled([...trackedCdpSessions].map(detachCdpSession)),
        CDP_TIMEOUT_MS + 500,
        'CDP detach set',
      );
      const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
      if(failures.length) throw new AggregateError(failures, 'one or more CDP sessions failed to detach');
    } finally {
      trackedCdpSessions.clear();
    }
  });
  await capture('page teardown', async () => {
    try {
      const browserPages = browser
        ? await timebox(browser.pages(), 3_000, 'browser.pages during teardown')
        : [];
      const pages = new Set([...trackedPages, ...browserPages]);
      await timebox(Promise.allSettled([...pages].map(page => page.close({ runBeforeUnload: false }).catch(() => {}))),
        5_000, 'page close');
    } finally {
      trackedPages.clear();
    }
  });
  const browserToClose = browser;
  browser = null;
  await capture('browser teardown', () => closeBrowserDeterministically(browserToClose));
  const serverToClose = artifactServer;
  artifactServer = null;
  await capture('artifact server teardown', () => serverToClose?.close());
  return errors;
}

async function openRunner({ lowfx = true, fast = true } = {}){
  const page = await browser.newPage();
  trackedPages.add(page);
  page.once('close', () => trackedPages.delete(page));
  await page.emulate(KnownDevices['iPad Pro 11 landscape']);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(artifactServer.url({ lowfx, fast }), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => window.__gp, { timeout: 120_000 });
  return { page, errors };
}

async function centerOf(page, selector){
  return page.$eval(selector, element => {
    const rect = element.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  });
}

async function tapElement(page, selector){
  const [x, y] = await centerOf(page, selector);
  await page.touchscreen.tap(x, y);
}

async function startTutorial(page){
  await tapElement(page, '#tapGo');
  await page.waitForFunction(() => __gp.mode === 'tutorial', { timeout: 30_000 });
}

const SWIPE_POINTS = Object.freeze({
  up: [[600, 570], [600, 470]],
  down: [[600, 470], [600, 570]],
  left: [[650, 520], [540, 520]],
  right: [[550, 520], [660, 520]],
});

async function beginTouch(page, point, pointerId = 1){
  const client = await timebox(page.createCDPSession(), CDP_TIMEOUT_MS, 'CDP session setup');
  trackedCdpSessions.add(client);
  try {
    await cdpSend(client, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } catch(error){
    await detachCdpSession(client).catch(() => {});
    throw error;
  }
  let current = point;
  const touch = ([x, y], id = pointerId) => ({ x, y, radiusX: 8, radiusY: 8, force: 0.65, id });
  try {
    await cdpSend(client, 'Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(point)] });
  } catch(error){
    await detachCdpSession(client).catch(() => {});
    throw error;
  }
  return {
    async move(next){
      current = next;
      await cdpSend(client, 'Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(next)] });
      await sleep(30);
    },
    async second(next, secondId = pointerId + 1){
      await cdpSend(client, 'Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [touch(current), touch(next, secondId)],
      });
      await sleep(30);
    },
    async end(){
      try {
        await cdpSend(client, 'Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally {
        await detachCdpSession(client);
      }
    },
    async cancel(){
      try {
        await cdpSend(client, 'Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      } finally {
        await detachCdpSession(client);
      }
    },
  };
}

async function swipe(page, direction, { assertThreshold = false } = {}){
  const [start, end] = SWIPE_POINTS[direction];
  const before = await page.evaluate(key => __gp.actionCounts[key], direction);
  const touch = await beginTouch(page, start, 10 + before);
  await touch.move(end);
  const beforeUp = await page.evaluate(key => ({
    count: __gp.actionCounts[key],
    last: __gp.lastAcceptedAction,
    active: __gp.gesture.gesture.active,
  }), direction);
  if(assertThreshold){
    assert.equal(beforeUp.count, before + 1, `${direction} must trigger at threshold before pointer-up`);
    assert.equal(beforeUp.last.direction, direction);
    assert.equal(beforeUp.last.beforePointerUp, true);
    assert.equal(beforeUp.active, true, `${direction} touch must still be down at threshold`);
  }
  await touch.end();
  await sleep(45);
  const afterUp = await page.evaluate(key => __gp.actionCounts[key], direction);
  if(assertThreshold) assert.equal(afterUp, before + 1, `${direction} must trigger exactly once`);
  return { before, beforeUp, afterUp };
}

async function assertScreenAudit(page, label){
  const audit = await page.evaluate(() => __gp.auditScreens());
  assert.equal(audit.state.ok, true, `${label}: inactive screen state`);
  assert.equal(audit.hits.ok, true, `${label}: inactive screen won hit test`);
  assert.deepEqual(audit.hits.violations, []);
  return audit;
}

function sorted(values){
  return [...values].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));
}

function authoredGeometryContract(){
  const course = createRunnerCourseModel();
  const anchors = course.debugAnchors().anchors;
  return {
    course,
    anchorKeys: sorted(anchors.map(anchor => anchor.key)),
    checkpointKeys: sorted(course.checkpoints.map(checkpoint => `checkpoint:${checkpoint.id}`)),
    safePadKeys: sorted(course.safePads.map(pad => `safe-pad:${pad.id}`)),
    hazardLanes: Object.fromEntries(course.hazards.map(hazard => [hazard.id, sorted(hazard.lanes)])),
  };
}

function assertSemanticGeometry(semantic, authored){
  assert.ok(semantic && typeof semantic === 'object', 'city must expose semantic geometry diagnostics');
  assert.ok(Array.isArray(semantic.anchors), 'semantic geometry must enumerate constructed anchors');
  assert.ok(Array.isArray(semantic.warnings), 'semantic geometry must enumerate lane warning strips');
  assert.ok(Array.isArray(semantic.gates), 'semantic geometry must enumerate start/finish gates');
  assert.ok(Array.isArray(semantic.checkpoints), 'semantic geometry must enumerate checkpoints');
  assert.ok(Array.isArray(semantic.safePads), 'semantic geometry must enumerate safe pads');

  const semanticAnchorKeys = sorted(semantic.anchors.map(anchor => anchor.key ?? anchor.id));
  assert.deepEqual(semanticAnchorKeys, authored.anchorKeys,
    'constructed geometry must cover every canonical hazard/lane boundary, checkpoint, and safe pad');

  for(const [hazardId, expectedLanes] of Object.entries(authored.hazardLanes)){
    const warnings = semantic.warnings.filter(warning => warning.hazardId === hazardId);
    const observedLanes = sorted(new Set(warnings.map(warning => warning.lane)));
    assert.deepEqual(observedLanes, expectedLanes, `${hazardId}: warning strips must exist only in affected lanes`);
    assert.ok(warnings.length >= expectedLanes.length, `${hazardId}: missing lane warning strips`);
    for(const warning of warnings){
      assert.ok(Number.isFinite(warning.width), `${hazardId}: warning width must be observable`);
      assert.ok(warning.width <= authored.course.laneSpacing * 1.1,
        `${hazardId}: warning strip spans beyond its authored lane`);
    }
  }

  const checkpointKeys = sorted(semantic.checkpoints.map(item => item.key ?? `checkpoint:${item.id}`));
  const safePadKeys = sorted(semantic.safePads.map(item => item.key ?? `safe-pad:${item.id}`));
  assert.deepEqual(checkpointKeys, authored.checkpointKeys, 'checkpoint presentation drifted from course model');
  assert.deepEqual(safePadKeys, authored.safePadKeys, 'safe-pad presentation drifted from course model');

  const finish = semantic.gates.find(gate => gate.kind === 'finish' || gate.id === 'finish');
  assert.ok(finish, 'finish gate semantic geometry missing');
  assert.ok(Number.isFinite(finish.approachFacingDot), 'finish gate must expose approach-facing geometry');
  assert.ok(finish.approachFacingDot < -0.95,
    `finish sign faces away from the approaching player (${finish.approachFacingDot})`);
  assert.equal(finish.approachFrontSide, true, 'finish sign approach face must use one-sided readable geometry');
  assert.equal(finish.separateRearFace, true, 'finish sign must not mirror the approach texture on its rear face');
}

async function assertLiveAlignmentNegatives(page, baseline, expectedKeys){
  const hazardId = 'lane-blocker-01';
  const bodyKey = 'hazard:lane-blocker-01:start:lane:0';
  const gapKey = 'hazard:tutorial-gap-01:start:lane:0';
  assert.ok(expectedKeys.includes(bodyKey), 'authored blocker body fixture is missing');
  assert.ok(expectedKeys.includes(gapKey), 'authored gap boundary fixture is missing');

  let shiftedHazard;
  try {
    const moved = await page.evaluate(id => __gp.debugOffsetHazard(id, { x: 1, y: 0, z: 0 }), hazardId);
    assert.equal(moved, true, 'actual lane-blocker group could not be moved');
    shiftedHazard = await page.evaluate(() => __gp.alignment);
    assert.equal(shiftedHazard.ok, false, 'moving the actual lane-blocker group by 1m must fail alignment');
    assert.ok(shiftedHazard.maxDelta >= 0.99,
      'alignment report did not observe the 1m actual hazard-group offset');
  } finally {
    await page.evaluate(id => __gp.restoreOffsetHazard(id), hazardId);
  }
  const afterHazardRestore = await page.evaluate(() => __gp.alignment);
  assert.equal(afterHazardRestore.ok, true, 'restoring the actual hazard group must restore alignment');
  assert.equal(afterHazardRestore.missing ?? 0, 0, 'restored hazard alignment unexpectedly lost an observation');

  let shiftedBody;
  try {
    const moved = await page.evaluate(key => __gp.debugOffsetAnchor(key, { x: 1, y: 0, z: 0 }), bodyKey);
    assert.equal(moved, true, 'actual lane-blocker body child could not be moved');
    shiftedBody = await page.evaluate(() => __gp.alignment);
    assert.equal(shiftedBody.ok, false, 'moving the actual lane-blocker body child by 1m must fail alignment');
    assert.ok(shiftedBody.maxDelta >= 0.99,
      'alignment report did not observe the 1m actual body-mesh offset');
  } finally {
    await page.evaluate(key => __gp.restoreOffsetAnchor(key), bodyKey);
  }
  const afterBodyRestore = await page.evaluate(() => __gp.alignment);
  assert.equal(afterBodyRestore.ok, true, 'restoring the actual body child must restore alignment');

  let missingBody;
  try {
    const detached = await page.evaluate(key => __gp.debugDetachAnchorOwner(key), bodyKey);
    assert.equal(detached, true, 'actual lane-blocker body child could not be detached');
    missingBody = await page.evaluate(() => __gp.alignment);
    assert.equal(missingBody.ok, false, 'removing the actual lane-blocker body child must fail alignment');
    assert.ok((missingBody.missing ?? 0) >= 2,
      'alignment report must count the removed body start/end observations');
  } finally {
    await page.evaluate(key => __gp.restoreDetachedAnchorOwner(key), bodyKey);
  }
  const afterBodyAttach = await page.evaluate(() => __gp.alignment);
  assert.equal(afterBodyAttach.ok, true, 'reattaching the actual body child must restore alignment');

  let shiftedGap;
  try {
    const moved = await page.evaluate(key => __gp.debugOffsetAnchor(key, { x: 1, y: 0, z: 0 }), gapKey);
    assert.equal(moved, true, 'actual deck ribbon could not be moved through its boundary observation');
    shiftedGap = await page.evaluate(() => __gp.alignment);
    assert.equal(shiftedGap.ok, false, 'moving the actual gap deck ribbon by 1m must fail alignment');
    assert.ok(shiftedGap.maxDelta >= 0.99,
      'alignment report did not observe the 1m actual deck-ribbon offset');
  } finally {
    await page.evaluate(key => __gp.restoreOffsetAnchor(key), gapKey);
  }
  const afterGapRestore = await page.evaluate(() => __gp.alignment);
  assert.equal(afterGapRestore.ok, true, 'restoring the actual deck ribbon must restore alignment');

  let missingGap;
  try {
    const detached = await page.evaluate(key => __gp.debugDetachAnchorOwner(key), gapKey);
    assert.equal(detached, true, 'actual deck ribbon could not be detached');
    missingGap = await page.evaluate(() => __gp.alignment);
    assert.equal(missingGap.ok, false, 'removing the actual gap deck ribbon must fail alignment');
    assert.ok((missingGap.missing ?? 0) >= 1, 'alignment report must count missing actual deck observations');
  } finally {
    await page.evaluate(key => __gp.restoreDetachedAnchorOwner(key), gapKey);
  }
  const restored = await page.evaluate(() => __gp.alignment);
  assert.equal(restored.ok, true, 'restoring the actual gap ribbon must restore alignment');
  assert.equal(restored.missing ?? 0, 0);
  assert.equal(restored.rows.length, baseline.rows.length);
  return {
    hazardId,
    bodyKey,
    gapKey,
    shiftedHazardMaxDelta: shiftedHazard.maxDelta,
    shiftedBodyMaxDelta: shiftedBody.maxDelta,
    missingBodyCount: missingBody.missing,
    shiftedGapMaxDelta: shiftedGap.maxDelta,
    missingGapCount: missingGap.missing,
    restored: { maxDelta: restored.maxDelta, tolerance: restored.tolerance },
  };
}

/* ---------------- visual/collider authority + four threshold swipes ---------------- */
async function alignmentAndSwipeGate(){
  const { page, errors } = await openRunner();
  const authored = authoredGeometryContract();
  const titleAudit = await assertScreenAudit(page, 'title');
  const alignment = await page.evaluate(() => __gp.alignment);
  assert.equal(alignment.ok, true, 'visual/collider course anchors must align');
  assert.equal(alignment.missing ?? 0, 0, 'browser is missing constructed anchor observations');
  assert.ok(Number.isFinite(alignment.tolerance) && alignment.tolerance > 0 && alignment.tolerance <= 2e-5,
    `browser alignment tolerance is not honest and bounded (${alignment.tolerance})`);
  assert.ok(Number.isFinite(alignment.maxDelta) && alignment.maxDelta <= alignment.tolerance,
    `observed geometry drift exceeded its declared tolerance (${alignment.maxDelta}/${alignment.tolerance})`);
  assert.deepEqual(sorted(alignment.rows.map(row => row.key ?? row.id)), authored.anchorKeys,
    'browser must expose every authored anchor exactly once');
  assert.ok(alignment.rows.every(row => row.delta <= alignment.tolerance),
    'constructed geometry exceeded the browser alignment tolerance');
  const bodyRows = alignment.rows.filter(row => [
    'hazard:lane-blocker-01:',
    'hazard:combined-lane-gate:',
    'hazard:slide-gate-01:',
  ].some(prefix => row.id.startsWith(prefix))
    && (row.id.includes(':start:') || row.id.includes(':end:')));
  assert.equal(bodyRows.length, 12, 'actual blocker/gate body boundary observations are incomplete');
  assert.ok(bodyRows.every(row => row.ownerName.startsWith('hazard-body:')
    && row.ownerIsMesh === true && row.ownerType === 'Mesh'
    && row.observationSource.startsWith('hazard-body-geometry-')
    && Number.isInteger(row.geometryVertexCount) && row.geometryVertexCount > 0
    && Array.isArray(row.vertexIndices) && row.vertexIndices.length >= 1
    && row.vertexIndices.every(index => Number.isInteger(index) && index >= 0 && index < row.geometryVertexCount)),
  'blocker/gate alignment must be read from actual body-mesh vertices or edges');
  const gapRows = alignment.rows.filter(row => row.id.startsWith('hazard:tutorial-gap-01:')
    && (row.id.includes(':start:') || row.id.includes(':end:')));
  assert.ok(gapRows.length > 0, 'gap deck boundary observations are missing');
  assert.ok(gapRows.every(row => row.observationSource === 'deck-boundary-vertices'
    && row.ownerName.startsWith('deck-ribbon:')),
  'gap alignment must observe the actual deck-ribbon boundary vertices');
  const semantic = await page.evaluate(() => __gp.semanticGeometry);
  assertSemanticGeometry(semantic, authored);
  const negativeAlignment = await assertLiveAlignmentNegatives(page, alignment, authored.anchorKeys);

  await startTutorial(page);
  await page.evaluate(() => __gp.slowmo(0));
  const swipes = {};
  for(const direction of ['up', 'down', 'left', 'right']) swipes[direction] = await swipe(page, direction, { assertThreshold: true });
  const tutorialAudit = await assertScreenAudit(page, 'tutorial');
  assert.deepEqual(errors, []);
  await page.close();
  return { alignment, semantic, negativeAlignment, swipes, titleAudit, tutorialAudit };
}

/* ---------------- cancellation lifecycle gate ---------------- */
async function assertCancelled(page, expected){
  await sleep(40);
  const snapshot = await page.evaluate(() => __gp.gesture);
  assert.equal(snapshot.gesture.active, false, `${expected}: gesture remained active`);
  assert.equal(snapshot.lastCancelReason, expected, `${expected}: wrong cancel reason`);
  return snapshot;
}

async function syntheticPointerStart(page, pointerId){
  await page.evaluate(id => {
    const canvas = document.getElementById('gl');
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch',
      isPrimary: true, clientX: 600, clientY: 520, buttons: 1,
    }));
  }, pointerId);
}

async function cancellationGate(){
  const { page, errors } = await openRunner();
  await startTutorial(page);
  await page.evaluate(() => __gp.slowmo(0));
  const results = {};

  let touch = await beginTouch(page, [600, 520], 41);
  await touch.cancel();
  results.pointercancel = await assertCancelled(page, 'pointercancel');

  await syntheticPointerStart(page, 42);
  await page.evaluate(() => document.getElementById('gl').dispatchEvent(new PointerEvent('lostpointercapture', {
    bubbles: true, pointerId: 42, pointerType: 'touch', isPrimary: true,
  })));
  results.lostpointercapture = await assertCancelled(page, 'lostpointercapture');

  touch = await beginTouch(page, [600, 520], 43);
  await touch.second([630, 520], 44);
  await touch.end();
  results.multitouch = await assertCancelled(page, 'multitouch');

  await syntheticPointerStart(page, 45);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  results.blur = await assertCancelled(page, 'blur');

  await syntheticPointerStart(page, 46);
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  results.orientationchange = await assertCancelled(page, 'orientationchange');

  assert.deepEqual(errors, []);
  await page.close();
  return results;
}

/* ---------------- genuine-swipe full 150m tutorial, no autopilot ---------------- */
function validateRivalParity(parity, label){
  assert.ok(parity && typeof parity === 'object', `${label}: rival parity diagnostic missing`);
  assert.equal(parity.ok, true, `${label}: rival presentation diverged from authoritative simulation`);
  assert.ok(Number.isFinite(parity.maxDelta), `${label}: rival parity delta is not finite`);
  assert.ok(parity.maxDelta <= 1e-5, `${label}: rival mesh delta exceeded tolerance (${parity.maxDelta})`);
  assert.ok(Array.isArray(parity.rows), `${label}: rival parity rows missing`);
  assert.equal(parity.rows.length, 3, `${label}: all authored rivals must be observed`);
  for(const row of parity.rows){
    assert.equal(typeof row.id, 'string', `${label}: rival id missing`);
    assert.ok(Number.isFinite(row.delta) && row.delta <= 1e-5, `${label}/${row.id}: mesh parity failed`);
    assert.ok(Number.isFinite(row.simS), `${label}/${row.id}: authoritative course position missing`);
  }
  assert.equal(parity.hudRank, parity.authoritativeRank, `${label}: HUD rank is not simulation authoritative`);
  return parity;
}

async function sampleRivalParity(page, label){
  return validateRivalParity(await page.evaluate(() => __gp.rivalParity), label);
}

async function waitForVisibleCue(page, id, { emitted = true, minRuntimeSeconds = null } = {}){
  try {
    await page.waitForFunction(requirement => {
      if(__gp.mode !== 'tutorial' && __gp.mode !== 'race') return false;
      const cue = __gp.cue;
      if(cue.id !== requirement.id || !cue.visible) return false;
      if(requirement.emitted && cue.emitted?.hazardId !== requirement.id) return false;
      if(requirement.minRuntimeSeconds !== null
        && (!Number.isFinite(cue.runtimeSecondsToStart)
          || cue.runtimeSecondsToStart < requirement.minRuntimeSeconds)) return false;
      return true;
    }, { timeout: 45_000, polling: 8 }, { id, emitted, minRuntimeSeconds });
  } catch(error){
    const state = await page.evaluate(() => ({
      mode: __gp.mode,
      s: __gp.courseS,
      shields: __gp.shields,
      simulation: __gp.simulation,
      cue: __gp.cue,
      lastHazardCue: __gp.lastHazardCue,
      lastEvent: __gp.lastEvent,
    })).catch(() => null);
    error.message += `; waiting for ${id}; runtime=${JSON.stringify(state)}`;
    throw error;
  }
  const cue = await page.evaluate(() => __gp.cue);
  assert.equal(cue.id, id, `${id}: wrong visible cue`);
  assert.equal(cue.visible, true, `${id}: action cue is not actually visible`);
  assert.ok(cue.opacity >= 0.95, `${id}: cue was sampled before its fade became usable`);
  if(emitted){
    assert.equal(cue.emitted?.type, 'hazard-cue', `${id}: visible cue lacks a simulation event`);
    assert.equal(cue.emitted?.hazardId, id, `${id}: cue event belongs to another hazard`);
  }
  if(minRuntimeSeconds !== null){
    assert.ok(cue.runtimeSecondsToStart >= minRuntimeSeconds,
      `${id}: usable runtime decision window was ${cue.runtimeSecondsToStart}s`);
  }
  return cue;
}

async function swipeAfterVisibleCue(page, id, direction, options = {}){
  const cue = await waitForVisibleCue(page, id, options);
  if(options.emitted !== false){
    await page.waitForFunction(cueId => {
      const current = __gp.cue;
      return current.id === cueId && current.visible && current.actionReady
        && current.emitted?.hazardId === cueId;
    }, { timeout: 30_000, polling: 8 }, id);
  }
  const actionCue = await page.evaluate(() => __gp.cue);
  assert.equal(actionCue.visible, true, `${id}: action-ready command is not visible`);
  assert.equal(actionCue.actionReady, true, `${id}: gesture predates the course-owned action point`);
  const gesture = await swipe(page, direction);
  const accepted = await page.evaluate(() => __gp.lastAcceptedAction);
  assert.equal(accepted?.direction, direction, `${id}: wrong gesture accepted`);
  assert.equal(accepted?.cueId, id, `${id}: action was not made against the visible cue`);
  assert.ok(accepted.atSimulation >= actionCue.shownAtSimulation,
    `${id}: action predates the visible cue presentation`);
  if(options.emitted !== false){
    assert.ok(accepted.atSimulation >= actionCue.emitted.time,
      `${id}: action predates the emitted simulation cue`);
  }
  return { cue, actionCue, accepted, gesture };
}

async function tutorialGate(){
  const { page, errors } = await openRunner();
  await startTutorial(page);
  const rivalSamples = [await sampleRivalParity(page, 'tutorial-start')];
  const actions = {};
  actions.opening = await swipeAfterVisibleCue(page, 'opening-jump', 'up', { emitted: false });
  await page.waitForFunction(() => __gp.yRel <= 0.01 && __gp.locomotion !== 'air', { timeout: 20_000 });
  rivalSamples.push(await sampleRivalParity(page, 'tutorial-after-opening-jump'));
  actions.jump = await swipeAfterVisibleCue(page, 'tutorial-gap-01', 'up');
  actions.lane = await swipeAfterVisibleCue(page, 'lane-blocker-01', 'right');
  rivalSamples.push(await sampleRivalParity(page, 'tutorial-before-lane-lesson'));
  actions.slide = await swipeAfterVisibleCue(page, 'slide-gate-01', 'down');
  rivalSamples.push(await sampleRivalParity(page, 'tutorial-before-slide-lesson'));
  actions.combined = await swipeAfterVisibleCue(page, 'combined-lane-gate', 'left', {
    minRuntimeSeconds: 0.75,
  });
  rivalSamples.push(await sampleRivalParity(page, 'tutorial-combined-test'));
  actions.final = await swipeAfterVisibleCue(page, 'final-gap-01', 'up');
  await page.waitForFunction(() => __gp.mode === 'results', { timeout: 120_000, polling: 50 });
  rivalSamples.push(await sampleRivalParity(page, 'tutorial-results'));
  const result = await page.evaluate(() => ({
    mode: __gp.mode, s: __gp.courseS, shields: __gp.shields,
    damage: __gp.damageCount, results: __gp.resultsCount,
    actions: __gp.actionCounts, fixed: __gp.fixedStep,
    courseLength: __dbg.course.length,
    standings: __gp.standings.map(({ id, rank, s, finishTime }) => ({ id, rank, s, finishTime })),
    terminalStandings: __gp.terminalSnapshot?.standings
      .map(({ id, rank, s, finishTime }) => ({ id, rank, s, finishTime })),
    resultsPresentation: __gp.resultsPresentation,
  }));
  assert.equal(result.mode, 'results');
  assert.ok(result.s >= result.courseLength - 0.1, 'genuine-swipe tutorial must reach the authored finish');
  assert.equal(result.damage, 0, 'scripted tutorial unexpectedly crashed');
  assert.equal(result.results, 1);
  assert.ok(result.actions.up >= 3 && result.actions.down >= 1 && result.actions.left >= 1 && result.actions.right >= 1);
  assert.deepEqual(result.standings, result.terminalStandings,
    'results presentation and live HUD must share one terminal standings authority');
  assert.equal(result.standings[0]?.id, 'jet', 'JET must finish ahead in the deterministic tutorial fixture');
  const player = result.standings.find(entry => entry.id === 'player');
  assert.equal(player?.rank, 2, 'player must be second behind JET in the deterministic fixture');
  assert.equal(result.resultsPresentation.headline, '2ND', 'results headline did not use authoritative player rank');
  const resultLines = result.resultsPresentation.rowsText.split('\n').map(line => line.trim()).filter(Boolean);
  assert.ok(resultLines.some(line => /^1 JET\b/.test(line)), 'results rows do not render JET in first');
  assert.ok(resultLines.some(line => /^2 YOU\b/.test(line)), 'results rows do not render the player in second');
  await assertScreenAudit(page, 'successful-results');
  assert.deepEqual(errors, []);
  await page.close();
  return {
    ...result,
    cueActions: Object.fromEntries(Object.entries(actions).map(([key, value]) => [key, {
      id: value.cue.id,
      shownAtSimulation: value.cue.shownAtSimulation,
      emittedAtSimulation: value.cue.emitted?.time ?? null,
      actedAtSimulation: value.accepted.atSimulation,
      actedAtS: value.accepted.atS,
      actionAtS: value.actionCue.actionAt,
      usableSeconds: value.cue.runtimeSecondsToStart,
      opacity: value.cue.opacity,
    }])),
    rivalMaxDelta: Math.max(...rivalSamples.map(sample => sample.maxDelta)),
  };
}

/* ---------------- local recovery, exhaustion, freeze, and replay ---------------- */
async function missFinalGap(page, shields){
  await page.evaluate(value => {
    const hazard = __dbg.course.hazardById('final-gap-01');
    const safePad = __dbg.course.safePadById(hazard.safePadId);
    __gp.slowmo(0);
    __gp.debugSetCourseS(hazard.s0 - 0.4, {
      speed: 14,
      shields: value,
      lane: 0,
      lastSafePad: safePad.resumeS,
    });
    __gp.slowmo(1);
  }, shields);
  await page.waitForFunction(value => __gp.shields === value - 1 || __gp.mode === 'failed' || __gp.mode === 'results', { timeout: 30_000 }, shields);
}

async function stalledRecoveryGate(page){
  await page.waitForFunction(() => __gp.mode === 'recover' && __gp.simulation.status === 'recovering', {
    timeout: 30_000,
    polling: 4,
  });
  // Run the entire sequence in one page task. Resuming from each rAF via a
  // microtask immediately starts the next 420ms block, preventing unrelated
  // 16ms frames from slipping between the five exact maxFrame samples.
  const fixture = await page.evaluate(async () => {
    const observe = () => {
      const simulation = __gp.simulation;
      return {
        mode: __gp.mode,
        status: simulation.status,
        recoveryElapsed: simulation.recovery?.elapsed ?? null,
        simulationTime: simulation.simulationTime,
        flowModeTime: __gp.flow.modeTime,
        pendingFlowTasks: __gp.flow.pendingTasks,
        gestureEnabled: __gp.gesture.enabled,
        transition: __gp.flow.lastTransition,
      };
    };
    const blockUntilNextFrame = async () => {
      const started = performance.now();
      while(performance.now() - started < 420){ /* deliberate regression fixture */ }
      const blockedFor = performance.now() - started;
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      return blockedFor;
    };
    // Align the fixture to a completed game frame first. Starting a long task
    // just before an already-issued rAF can preserve that frame's old
    // timestamp, making the first 420ms stall look like a normal 16ms frame.
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    const initial = observe();
    const stalls = [];
    for(let index = 0; index < 5; index += 1){
      const blockedFor = await blockUntilNextFrame();
      stalls.push({ blockedFor, ...observe() });
    }
    const sixthBlockedFor = await blockUntilNextFrame();
    return { initial, stalls, sixth: { blockedFor: sixthBlockedFor, ...observe() } };
  });
  const { initial, stalls, sixth } = fixture;
  assert.equal(initial.mode, 'recover');
  assert.equal(initial.status, 'recovering');
  assert.equal(initial.gestureEnabled, false, 'recovery must begin with gestures disabled');

  for(let index = 0; index < stalls.length; index += 1){
    const observation = stalls[index];
    assert.ok(observation.blockedFor >= 400, `stall ${index + 1}: fixture did not block for 420ms`);
    assert.equal(observation.mode, 'recover', `stall ${index + 1}: wall time escaped recover mode`);
    assert.equal(observation.status, 'recovering', `stall ${index + 1}: recovery completed before its sixth fixed sample`);
    assert.equal(observation.gestureEnabled, false, `stall ${index + 1}: gesture enabled before simulation recovery-complete`);
    assert.equal(observation.pendingFlowTasks, 0, `stall ${index + 1}: recover mode owns a forbidden flow timer`);
    assert.ok(observation.recoveryElapsed >= initial.recoveryElapsed,
      `stall ${index + 1}: recovery elapsed moved backwards`);
    assert.ok(observation.recoveryElapsed <= initial.recoveryElapsed + (index + 1) * 0.1 + 1e-6,
      `stall ${index + 1}: maxFrame allowed more than 100ms of simulation recovery`);
  }
  assert.ok(stalls.at(-1).flowModeTime - initial.flowModeTime >= 1,
    'repeated long wall stalls must substantially advance the flow clock fixture');
  assert.ok(sixth.blockedFor >= 400, 'sixth stall fixture did not block for 420ms');
  assert.ok(sixth.mode === 'tutorial' || sixth.mode === 'race',
    `sixth fixed sample did not complete recovery: ${JSON.stringify({ initial, stalls, sixth })}`);
  assert.equal(sixth.status, 'running');
  assert.equal(sixth.transition?.reason, 'recovery-complete',
    'recover mode must leave only through the simulation recovery-complete bridge');
  assert.equal(sixth.gestureEnabled, true);

  const beforeAction = await page.evaluate(() => __gp.lastSimActionEvent);
  const previousActionId = beforeAction?.actionId ?? -1;
  await swipe(page, 'right', { assertThreshold: true });
  await page.waitForFunction(previous => {
    const event = __gp.lastSimActionEvent;
    return event?.type === 'action-accepted'
      && event.action === 'right'
      && (event.actionId ?? 0) !== previous;
  }, { timeout: 10_000, polling: 5 }, previousActionId);
  const firstPostRecoveryAction = await page.evaluate(() => __gp.lastSimActionEvent);
  assert.equal(firstPostRecoveryAction.type, 'action-accepted');
  assert.equal(firstPostRecoveryAction.action, 'right');
  return { initial, stalls, sixth, firstPostRecoveryAction };
}

async function failureReplayGate(){
  const { page, errors } = await openRunner();
  await startTutorial(page);

  await missFinalGap(page, 3);
  const stalledRecovery = await stalledRecoveryGate(page);
  await page.waitForFunction(() => {
    const resumeS = __dbg.course.safePadById('checkpoint-120-pad').resumeS;
    return (__gp.mode === 'tutorial' || __gp.mode === 'race')
      && __gp.shields === 2 && __gp.courseS < resumeS + 4.5;
  }, { timeout: 30_000 });
  const firstRecovery = await page.evaluate(() => ({
    shields: __gp.shields, s: __gp.courseS, safePad: __gp.safePad,
    damage: __gp.damageCount, recoveries: __gp.recoveryCount,
    expectedSafePad: __dbg.course.safePadById('checkpoint-120-pad').resumeS,
  }));
  assert.equal(firstRecovery.shields, 2);
  assert.ok(firstRecovery.s >= firstRecovery.expectedSafePad
    && firstRecovery.s < firstRecovery.expectedSafePad + 4.5,
  'miss must restore the course-owned checkpoint-120 safe pad');
  assert.equal(firstRecovery.safePad, firstRecovery.expectedSafePad);
  assert.equal(firstRecovery.damage, 1);
  assert.equal(firstRecovery.recoveries, 1);
  const firstRecoveryParity = await sampleRivalParity(page, 'first-recovery');

  await missFinalGap(page, 2);
  await page.waitForFunction(() => {
    const resumeS = __dbg.course.safePadById('checkpoint-120-pad').resumeS;
    return (__gp.mode === 'tutorial' || __gp.mode === 'race')
      && __gp.shields === 1 && __gp.courseS < resumeS + 4.5;
  }, { timeout: 30_000 });
  await missFinalGap(page, 1);
  await page.waitForFunction(() => __gp.mode === 'results', { timeout: 30_000 });
  const terminal = await page.evaluate(() => ({
    simulation: __gp.simulation,
    fixed: __gp.fixedStep,
    damage: __gp.damageCount,
    crashes: __gp.crashCount,
    results: __gp.resultsCount,
    shields: __gp.shields,
  }));
  assert.equal(terminal.shields, 0);
  assert.equal(terminal.damage, 3);
  assert.equal(terminal.crashes, 3);
  assert.equal(terminal.results, 1);
  const terminalParity = await sampleRivalParity(page, 'failed-results');
  await sleep(450);
  const frozen = await page.evaluate(() => ({
    simulation: __gp.simulation,
    fixed: __gp.fixedStep,
    damage: __gp.damageCount,
    results: __gp.resultsCount,
  }));
  assert.deepEqual(frozen.simulation, terminal.simulation, 'terminal presentation mutated pure simulation');
  assert.equal(frozen.fixed.simulationTime, terminal.fixed.simulationTime, 'terminal presentation advanced simulation clock');
  assert.equal(frozen.damage, 3, 'terminal loop repeated damage');
  assert.equal(frozen.results, 1, 'terminal loop re-entered results');
  await assertScreenAudit(page, 'failed-results');

  await tapElement(page, '#btnAgain');
  await page.waitForFunction(() => __gp.mode === 'tutorial', { timeout: 30_000 });
  await page.waitForFunction(() => __gp.statusTag.text === 'TRAINING DECK'
    && __gp.statusTag.visible && __gp.cue.id === 'opening-jump' && __gp.cue.visible,
  { timeout: 30_000, polling: 8 });
  const replay = await page.evaluate(() => ({
    mode: __gp.mode, s: __gp.courseS, shields: __gp.shields,
    activeScreens: __gp.activeScreens, reset: __gp.lastResetReason,
    statusTag: __gp.statusTag,
    cue: __gp.cue,
  }));
  assert.equal(replay.mode, 'tutorial');
  assert.ok(replay.s < 12, 'replay must start from the opening safe pad');
  assert.equal(replay.shields, 3);
  assert.deepEqual(replay.activeScreens, []);
  assert.equal(replay.reset, 'run-again-button');
  assert.equal(replay.statusTag.text, 'TRAINING DECK');
  assert.equal(replay.statusTag.visible, true, 'replay training state tag must be visibly rendered');
  assert.equal(replay.cue.id, 'opening-jump');
  assert.equal(replay.cue.visible, true, 'replay opening cue must be visibly rendered');
  const replayParity = await sampleRivalParity(page, 'replay-start');
  await assertScreenAudit(page, 'replay');
  assert.deepEqual(errors, []);
  await page.close();
  return {
    stalledRecovery,
    firstRecovery,
    firstRecoveryParity: { maxDelta: firstRecoveryParity.maxDelta },
    terminal,
    terminalParity: { maxDelta: terminalParity.maxDelta },
    frozen,
    replay,
    replayParity: { maxDelta: replayParity.maxDelta },
  };
}


/* ---------------- normal-quality sustained frame/long-frame budget ---------------- */
async function performanceGate(){
  const { page, errors } = await openRunner({ lowfx: false, fast: true });
  await startTutorial(page);
  // Exercise the full normal-quality renderer and the live 120Hz simulation;
  // a paused presentation would not prove the allocation-free fixed-step path.
  await page.waitForFunction(() => typeof __gp.perfReset === 'function' && __gp.perf, { timeout: 30_000 });
  await sleep(700);
  await page.evaluate(() => __gp.perfReset());
  await page.waitForFunction(() => __gp.perf.frames >= 180, { timeout: 20_000, polling: 100 });
  const perf = await page.evaluate(() => __gp.perf);
  assert.ok(perf.frames >= 180, 'normal-quality performance sample is too short');
  assert.ok(Number.isFinite(perf.average) && perf.average <= 25,
    `normal-quality average frame exceeded 25ms (${perf.average})`);
  assert.ok(Number.isFinite(perf.p95) && perf.p95 <= 35,
    `normal-quality p95 frame exceeded 35ms (${perf.p95})`);
  assert.ok(Number.isFinite(perf.max) && perf.max <= 100,
    `normal-quality long frame exceeded 100ms (${perf.max})`);
  assert.ok(Number.isInteger(perf.over50ms) && perf.over50ms <= Math.max(2, Math.ceil(perf.frames * 0.02)),
    `normal-quality loop produced too many >50ms frames (${perf.over50ms}/${perf.frames})`);
  assert.ok(Number.isInteger(perf.presentationWrites) && perf.presentationWrites >= Math.floor(perf.frames * 0.75),
    `normal-quality loop did not sustain preallocated presentation writes (${perf.presentationWrites}/${perf.frames} frames)`);
  const allocations = perf.allocations;
  assert.ok(allocations && typeof allocations === 'object', 'runtime allocation counters are missing');
  assert.equal(allocations.fixedLegacyAdvanceCalls, 0,
    'normal-quality loop called the allocating legacy fixed-step advance path');
  assert.equal(allocations.fixedStepSnapshotAllocations, 0,
    'normal-quality fixed-step callbacks allocated legacy diagnostic snapshots');
  assert.equal(allocations.fixedFrameSnapshotAllocations, 0,
    'normal-quality fixed-step frames allocated legacy diagnostic snapshots');
  assert.equal(allocations.actionLegacyDrainCalls, 0,
    'normal-quality loop called the allocating legacy action drain');
  assert.equal(allocations.actionLegacyDrainAllocations, 0,
    'normal-quality action loop allocated legacy drain result arrays');
  assert.ok(allocations.fixedAdvanceIntoCalls >= perf.frames,
    'normal-quality loop did not use caller-owned fixed-step frame outputs');
  assert.ok(allocations.actionDrainIntoCalls > 0,
    'normal-quality simulation never exercised caller-owned action draining');
  assert.equal(allocations.fixedFrameOutputStable, true,
    'normal-quality fixed-step output identity changed');
  assert.equal(allocations.actionDrainOutputStable, true,
    'normal-quality action-drain output identity changed');
  assert.deepEqual(errors, []);
  await page.close();
  return perf;
}

let finalReport = null;
let runFailure = null;
let cleanupDiagnostics = null;
try {
  if(!allowCallerHandleBaseline){
    assert.equal(handleScope.baselineHandleCount, 0,
      `standalone Runner hard gate started with caller handles: ${JSON.stringify(activeHandleDiagnostics().baselineHandles)}`);
    assert.equal(handleScope.baselineRequestCount, 0,
      `standalone Runner hard gate started with caller requests: ${JSON.stringify(activeHandleDiagnostics().baselineRequests)}`);
  }
  const pure = pureDeterminismGate();
  artifactServer = await createFreshArtifactServer();
  browser = await puppeteer.launch({
    headless: true,
    executablePath: resolveChromeExecutable(),
    protocolTimeout: 180_000,
    args: [
      '--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader',
      '--disable-breakpad', '--disable-crash-reporter', '--no-crash-upload',
    ],
  });
  if(process.env.RUNNER_PHASE3_FAIL_AFTER_BOOT === '1'){
    const fixture = await openRunner();
    await beginTouch(fixture.page, [600, 520], 991);
    throw new Error('injected Runner teardown failure after page/CDP ownership');
  }
  const input = await alignmentAndSwipeGate();
  const cancellation = await cancellationGate();
  const tutorial = await tutorialGate();
  const failure = await failureReplayGate();
  const performance = await performanceGate();
  finalReport = {
    ok: true,
    mode: CANDIDATE_MODE ? 'candidate' : 'standalone',
    releaseEligible: !CANDIDATE_MODE,
    freshArtifactSha256: artifactServer.hash,
    artifactParity: artifactServer.parity,
    pure: {
      s: pure.sixty.snapshot.s,
      speed: pure.sixty.snapshot.speed,
      mixedFrames: pure.mixed.frames,
      stallDropped: pure.stalled.clock.droppedTime,
      anchors: pure.anchors,
    },
    alignment: {
      anchors: input.alignment.rows.length,
      maxDelta: input.alignment.maxDelta,
      tolerance: input.alignment.tolerance,
      negatives: input.negativeAlignment,
    },
    swipes: Object.fromEntries(Object.entries(input.swipes).map(([key, value]) => [key, value.afterUp])),
    cancellation: Object.fromEntries(Object.entries(cancellation).map(([key, value]) => [key, value.lastCancelReason])),
    tutorial,
    failure,
    performance,
  };
} catch(error){
  runFailure = error;
} finally {
  const teardownErrors = await teardownRunnerHarness();
  if(teardownErrors.length){
    runFailure = runFailure
      ? new AggregateError([runFailure, ...teardownErrors], 'Runner gate and teardown failed')
      : new AggregateError(teardownErrors, 'Runner teardown failed');
  }
  try {
    cleanupDiagnostics = await assertNoActiveHarnessHandles();
  } catch(error){
    runFailure = runFailure
      ? new AggregateError([runFailure, error], 'Runner gate or teardown leaked active handles')
      : error;
  }
}

if(runFailure){
  console.error(JSON.stringify({
    ok: false,
    error: runFailure.message,
    teardownActiveHandles: activeHandleDiagnostics(),
  }, null, 2));
  throw runFailure;
}

finalReport.teardownActiveHandles = cleanupDiagnostics;
if(CANDIDATE_MODE){
  const envelope = {
    version: 1,
    mode: 'candidate',
    releaseEligible: false,
    world: 'runner',
    candidateFresh: { sha256: finalReport.freshArtifactSha256 },
    result: finalReport,
  };
  const pending = `${CANDIDATE_REPORT_PATH}.pending-${process.pid}`;
  await writeFile(pending, `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx' });
  await rename(pending, CANDIDATE_REPORT_PATH);
}
console.log(JSON.stringify(finalReport, null, 2));
