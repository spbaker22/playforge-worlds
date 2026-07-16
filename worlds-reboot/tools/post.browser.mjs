/* Shared post-pipeline browser gate: real WebGL sizing, DPR governor, and rotation. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { createIdentityHandleScope } from './active-handle-scope.mjs';
import { resolveChromeExecutable } from './chrome-path.mjs';
import {
  acknowledgeCapturedGatedSentinelIfAlone,
  abortCapturedGatedNode,
  capturedGatedTargetResult,
  releaseCapturedGatedNode,
  scopedGatedTitle,
  spawnCapturedGatedNode,
} from './phase-isolated-node.mjs';
import { finalizeCapturedGatedProcessGroup } from './phase-group-finalizer.mjs';
import { assertContainedPhaseTarget } from './phase-target-bootstrap.mjs';

if(process.platform === 'win32'){
  throw new Error('Post browser verification requires POSIX process-group isolation; win32 is unsupported');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SELF = fileURLToPath(import.meta.url);
const FIXTURE_PATH = '/tools/foundation-fixture.html';
const LANDSCAPE = Object.freeze({
  width: 1194,
  height: 834,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  isLandscape: true,
});
const PORTRAIT = Object.freeze({
  width: 834,
  height: 1194,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  isLandscape: false,
});
const configuredPositiveInteger = (name, fallback) => {
  const raw = process.env[name];
  if(raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if(!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
};
const OP_TIMEOUT_MS = configuredPositiveInteger('POST_BROWSER_OP_TIMEOUT_MS', 30_000);
const INJECT_TIMEOUT_MS = configuredPositiveInteger('POST_BROWSER_INJECT_TIMEOUT_MS', 250);
const OUTER_TIMEOUT_MS = configuredPositiveInteger('POST_BROWSER_OUTER_TIMEOUT_MS', 180_000);
const IS_WORKER = process.env.POST_BROWSER_WORKER === '1';
const RUN_MARKER = process.env.POST_BROWSER_RUN_MARKER
  || `playforge-post-browser-${process.pid}-${Date.now()}`;
const HARNESS_TEMP_DIR = process.env.POST_BROWSER_TEMP_DIR || null;
if(!/^[A-Za-z0-9_-]+$/.test(RUN_MARKER)) throw new RangeError('POST_BROWSER_RUN_MARKER must be alphanumeric, underscore, or hyphen');
const WORKER_ARGUMENT = `--post-browser-worker-marker=${RUN_MARKER}`;
if(IS_WORKER){
  assert.deepEqual(process.argv.slice(2), [WORKER_ARGUMENT],
    'post.browser worker requires its exact supervisor-bound argument');
  assertContainedPhaseTarget('post.browser worker');
} else {
  assert.deepEqual(process.argv.slice(2), [], 'post.browser supervisor accepts no arguments');
}
const trackedPages = new Set();
const trackedServers = new Set();
let browser = null;
let serverSequence = 0;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const closeEnough = (actual, expected, epsilon = 1e-7) => Math.abs(actual - expected) <= epsilon;

function timebox(promise, milliseconds, label){
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function boundedCall(label, operation, milliseconds = OP_TIMEOUT_MS){
  return timebox(Promise.resolve().then(operation), milliseconds, label);
}

function pageEvaluate(page, label, callback, ...args){
  return boundedCall(label, () => page.evaluate(callback, ...args));
}

function pageSetViewport(page, viewport, label){
  return boundedCall(label, () => page.setViewport(viewport));
}

function emptyFaviconPlugin(){
  return {
    name: 'playforge-post-empty-favicon',
    configureServer(server){
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        if(pathname !== '/favicon.ico'){
          next();
          return;
        }
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
      });
    },
  };
}

await new Promise(resolve => setImmediate(resolve));
const handleScope = createIdentityHandleScope({
  ignoredHandles: [process.stdin, process.stdout, process.stderr],
});

function describeResource(resource){
  return {
    type: resource?.constructor?.name || typeof resource,
    fd: Number.isInteger(resource?.fd) ? resource.fd : Number.isInteger(resource?._handle?.fd) ? resource._handle.fd : null,
    pid: Number.isInteger(resource?.pid) ? resource.pid : null,
    hasRef: typeof resource?.hasRef === 'function' ? resource.hasRef()
      : typeof resource?._handle?.hasRef === 'function' ? resource._handle.hasRef() : null,
    destroyed: typeof resource?.destroyed === 'boolean' ? resource.destroyed : null,
    listening: typeof resource?.listening === 'boolean' ? resource.listening : null,
  };
}

async function assertCleanHarness(){
  const deadline = Date.now() + 3_000;
  let ownership;
  do {
    ownership = handleScope.classify();
    if(ownership.handles.length === 0 && ownership.requests.length === 0){
      return { handles: [], requests: [] };
    }
    await sleep(25);
  } while(Date.now() < deadline);
  throw new Error(`post.browser leaked resources: ${JSON.stringify({
    handles: ownership.handles.map(describeResource),
    requests: ownership.requests.map(describeResource),
  })}`);
}

async function startVite(root, { configFile, plugins = [] } = {}){
  const cacheDir = HARNESS_TEMP_DIR
    ? path.join(HARNESS_TEMP_DIR, `vite-${serverSequence += 1}`)
    : undefined;
  const server = await timebox(createServer({
    root,
    configFile,
    cacheDir,
    plugins: [emptyFaviconPlugin(), ...plugins],
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      fs: { allow: [ROOT] },
    },
  }), OP_TIMEOUT_MS, `create Vite server for ${root}`);
  trackedServers.add(server);
  await timebox(server.listen(), OP_TIMEOUT_MS, `start Vite server for ${root}`);
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object', `missing Vite address for ${root}`);
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server){
  if(!server || !trackedServers.has(server)) return;
  let closeError = null;
  try {
    await timebox(server.close(), 5_000, 'Vite close');
  } catch(error){
    closeError = error;
    try { server.httpServer?.closeAllConnections?.(); } catch {}
    try { server.httpServer?.closeIdleConnections?.(); } catch {}
    try { server.httpServer?.close?.(); } catch {}
    try { await timebox(Promise.resolve(server.ws?.close?.()), 1_000, 'Vite websocket force-close'); } catch {}
    try { await timebox(Promise.resolve(server.watcher?.close?.()), 1_000, 'Vite watcher force-close'); } catch {}
  } finally {
    trackedServers.delete(server);
  }
  if(closeError) throw closeError;
}

async function openPage(viewport = LANDSCAPE){
  const page = await boundedCall('new browser page', () => browser.newPage());
  trackedPages.add(page);
  page.setDefaultTimeout(OP_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(OP_TIMEOUT_MS);
  await boundedCall('install WebGL context probe', () => page.evaluateOnNewDocument(() => {
    const state = { events: [] };
    Object.defineProperty(globalThis, '__postWebGLState', {
      configurable: true,
      value: state,
    });
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args){
      if(/^webgl2?$/.test(String(type)) && !this.__playforgeWebGLObserved){
        Object.defineProperty(this, '__playforgeWebGLObserved', { value: true });
        this.addEventListener('webglcontextlost', event => {
          state.events.push({ type: event.type, statusMessage: event.statusMessage || '' });
        });
        this.addEventListener('webglcontextrestored', event => {
          state.events.push({ type: event.type, statusMessage: '' });
        });
      }
      return originalGetContext.call(this, type, ...args);
    };
  }));
  await pageSetViewport(page, viewport, 'set iPad viewport');
  const errors = { page: [], console: [], webglConsole: [] };
  page.on('pageerror', error => errors.page.push(error.message));
  page.on('console', message => {
    const text = message.text();
    if(message.type() === 'error') errors.console.push(text);
    if(/(?:webgl.*(?:error|lost)|context\s+lost)/i.test(text)) errors.webglConsole.push(text);
  });
  return { page, errors };
}

async function closePage(page){
  if(!page || !trackedPages.has(page)) return;
  try {
    if(!page.isClosed()) await boundedCall('page close', () => page.close(), 5_000);
  } finally {
    trackedPages.delete(page);
  }
}

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
    await boundedCall('Puppeteer browser close', () => instance.close(), 5_000);
  } catch(error){
    closeError = error;
    try {
      await boundedCall('Puppeteer browser disconnect', () => instance.disconnect?.(), 1_000);
    } catch(disconnectError){
      closeError = new AggregateError([error, disconnectError],
        'Puppeteer browser close and disconnect both failed');
    }
  } finally {
    releaseBrowserProcessHandles(child);
  }
  if(closeError) throw closeError;
}

async function installPipeline(page, origin, lowfx){
  await boundedCall('load post fixture', () => page.goto(`${origin}${FIXTURE_PATH}`, {
    waitUntil: 'networkidle0',
    timeout: OP_TIMEOUT_MS,
  }), OP_TIMEOUT_MS + 1_000);
  await pageEvaluate(page, 'install real post pipeline', async isLowfx => {
    document.body.innerHTML = '<canvas id="gl" aria-label="post-pipeline fixture"></canvas>';
    const { createPipeline } = await import('/engine/post.js');
    const pipe = createPipeline({ canvas: document.getElementById('gl'), lowfx: isLowfx });
    const counters = {
      rendererPixelRatio: 0,
      rendererSize: 0,
      composerPixelRatio: 0,
      composerSize: 0,
    };
    const originalRendererPixelRatio = pipe.renderer.setPixelRatio.bind(pipe.renderer);
    const originalRendererSize = pipe.renderer.setSize.bind(pipe.renderer);
    const originalComposerPixelRatio = pipe.composer.setPixelRatio.bind(pipe.composer);
    const originalComposerSize = pipe.composer.setSize.bind(pipe.composer);
    pipe.renderer.setPixelRatio = value => {
      counters.rendererPixelRatio += 1;
      return originalRendererPixelRatio(value);
    };
    pipe.renderer.setSize = (...args) => {
      counters.rendererSize += 1;
      return originalRendererSize(...args);
    };
    pipe.composer.setPixelRatio = value => {
      counters.composerPixelRatio += 1;
      return originalComposerPixelRatio(value);
    };
    pipe.composer.setSize = (...args) => {
      counters.composerSize += 1;
      return originalComposerSize(...args);
    };

    function measure(){
      pipe.composer.render(1 / 60);
      const canvas = pipe.renderer.domElement;
      const gl = pipe.renderer.getContext();
      const target1 = pipe.composer.renderTarget1;
      const target2 = pipe.composer.renderTarget2;
      const bloomBright = pipe.bloom.renderTargetBright;
      const bloomHorizontal0 = pipe.bloom.renderTargetsHorizontal[0];
      return {
        inner: [innerWidth, innerHeight],
        devicePixelRatio,
        pr: pipe.PR,
        renderer: {
          pixelRatio: pipe.renderer.getPixelRatio(),
          canvas: [canvas.width, canvas.height],
          client: [canvas.clientWidth, canvas.clientHeight],
          drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        },
        composer: {
          logical: [pipe.composer._width, pipe.composer._height],
          pixelRatio: pipe.composer._pixelRatio,
          target1: [target1.width, target1.height],
          target2: [target2.width, target2.height],
          samples: [target1.samples, target2.samples],
        },
        bloom: {
          enabled: pipe.bloom.enabled,
          bright: [bloomBright.width, bloomBright.height],
          mip0: [bloomHorizontal0.width, bloomHorizontal0.height],
        },
        cameraAspect: pipe.camera.aspect,
        webgl: {
          error: gl.getError(),
          events: structuredClone(globalThis.__postWebGLState?.events || []),
        },
        counters: { ...counters },
      };
    }

    window.__postTest = {
      measure,
      resetCounters(){
        for(const key of Object.keys(counters)) counters[key] = 0;
      },
      governUntilPR(expected, fps){
        for(let index = 0; index < Math.ceil(fps * 1.6) && Math.abs(pipe.PR - expected) > 1e-9; index += 1){
          pipe.govern(1 / fps);
        }
        return measure();
      },
      governUntilBloomDisabled(fps){
        for(let index = 0; index < Math.ceil(fps * 2) && pipe.bloom.enabled; index += 1){
          pipe.govern(1 / fps);
        }
        return measure();
      },
      dispose(){
        for(const pass of pipe.composer.passes) pass.dispose?.();
        pipe.composer.dispose();
        pipe.renderer.dispose();
        pipe.renderer.forceContextLoss();
        delete window.__postTest;
      },
    };
  }, lowfx);
}

async function measure(page){
  return pageEvaluate(page, 'measure post pipeline', () => window.__postTest.measure());
}

async function waitForViewport(page, width, height){
  await boundedCall(`wait for ${width}x${height} viewport`, () => page.waitForFunction(
    ([expectedWidth, expectedHeight]) => innerWidth === expectedWidth && innerHeight === expectedHeight,
    { timeout: OP_TIMEOUT_MS },
    [width, height],
  ), OP_TIMEOUT_MS + 1_000);
  await pageEvaluate(page, 'settle resize frames', () => new Promise(resolve => requestAnimationFrame(
    () => requestAnimationFrame(resolve),
  )));
}

function assertSynchronized(snapshot, { width, height, pr, samples, bloomEnabled, label }){
  const effectiveWidth = width * pr;
  const effectiveHeight = height * pr;
  const canvasWidth = Math.floor(effectiveWidth);
  const canvasHeight = Math.floor(effectiveHeight);
  const bloomWidth = Math.round(effectiveWidth / 2);
  const bloomHeight = Math.round(effectiveHeight / 2);

  assert.deepEqual(snapshot.inner, [width, height], `${label}: logical viewport`);
  assert.ok(closeEnough(snapshot.pr, pr), `${label}: public PR ${snapshot.pr} != ${pr}`);
  assert.ok(closeEnough(snapshot.renderer.pixelRatio, pr), `${label}: renderer PR`);
  assert.ok(closeEnough(snapshot.composer.pixelRatio, pr), `${label}: composer PR`);
  assert.deepEqual(snapshot.renderer.canvas, [canvasWidth, canvasHeight], `${label}: canvas backing size`);
  assert.deepEqual(snapshot.renderer.client, [width, height], `${label}: canvas CSS size`);
  assert.deepEqual(snapshot.renderer.drawingBuffer, [canvasWidth, canvasHeight], `${label}: drawing buffer`);
  assert.deepEqual(snapshot.composer.logical, [width, height], `${label}: composer logical size`);
  for(const [name, dimensions] of [['target1', snapshot.composer.target1], ['target2', snapshot.composer.target2]]){
    assert.ok(closeEnough(dimensions[0], effectiveWidth), `${label}: ${name} width ${dimensions[0]} != ${effectiveWidth}`);
    assert.ok(closeEnough(dimensions[1], effectiveHeight), `${label}: ${name} height ${dimensions[1]} != ${effectiveHeight}`);
  }
  assert.deepEqual(snapshot.composer.samples, [samples, samples], `${label}: MSAA samples`);
  assert.deepEqual(snapshot.bloom.bright, [bloomWidth, bloomHeight], `${label}: bloom bright target`);
  assert.deepEqual(snapshot.bloom.mip0, [bloomWidth, bloomHeight], `${label}: bloom mip 0`);
  assert.equal(snapshot.bloom.enabled, bloomEnabled, `${label}: bloom enabled`);
  assert.ok(closeEnough(snapshot.cameraAspect, width / height), `${label}: camera aspect`);
  assert.equal(snapshot.webgl.error, 0, `${label}: WebGL getError`);
  assert.deepEqual(snapshot.webgl.events, [], `${label}: WebGL context events`);
}

function assertPageDiagnostics(errors, label){
  assert.deepEqual(errors.page, [], `${label}: page errors`);
  assert.deepEqual(errors.console, [], `${label}: console errors`);
  assert.deepEqual(errors.webglConsole, [], `${label}: WebGL console errors/context loss`);
}

function assertGovernorResizePath(snapshot, label){
  assert.deepEqual(snapshot.counters, {
    rendererPixelRatio: 1,
    rendererSize: 1,
    composerPixelRatio: 1,
    composerSize: 1,
  }, `${label}: governor must use one pixel-ratio call per layer and only its implicit resize`);
}

async function directPipelineGate(origin){
  const report = { normal: {}, lowfx: null };
  const normal = await openPage();
  try {
    if(process.env.POST_BROWSER_INJECT_PAGE_HANG){
      process.stderr.write(`post-browser-page-hang-fixture:${RUN_MARKER}\n`);
      await boundedCall('injected page evaluate', () => normal.page.evaluate(
        () => new Promise(() => {}),
      ), INJECT_TIMEOUT_MS);
    }
    await installPipeline(normal.page, origin, false);
    report.normal.initial = await measure(normal.page);
    assertSynchronized(report.normal.initial, {
      width: 1194, height: 834, pr: 1.6, samples: 4, bloomEnabled: true, label: 'normal initial',
    });
    assert.ok(report.normal.initial.bloom.bright[0] <= report.normal.initial.composer.target1[0] / 2,
      'normal initial: bloom width exceeded half the composer');
    assert.ok(report.normal.initial.bloom.bright[1] <= report.normal.initial.composer.target1[1] / 2,
      'normal initial: bloom height exceeded half the composer');

    await pageSetViewport(normal.page, PORTRAIT, 'set portrait viewport');
    await waitForViewport(normal.page, 834, 1194);
    report.normal.portrait = await measure(normal.page);
    assertSynchronized(report.normal.portrait, {
      width: 834, height: 1194, pr: 1.6, samples: 4, bloomEnabled: true, label: 'normal portrait',
    });
    assert.deepEqual(report.normal.portrait.counters, {
      rendererPixelRatio: 0,
      rendererSize: 1,
      composerPixelRatio: 0,
      composerSize: 1,
    }, 'portrait resize must use one logical setSize call per layer');

    await pageSetViewport(normal.page, LANDSCAPE, 'restore landscape viewport');
    await waitForViewport(normal.page, 1194, 834);
    report.normal.landscapeReturn = await measure(normal.page);
    assertSynchronized(report.normal.landscapeReturn, {
      width: 1194, height: 834, pr: 1.6, samples: 4, bloomEnabled: true, label: 'normal landscape return',
    });
    assert.deepEqual(report.normal.landscapeReturn.counters, {
      rendererPixelRatio: 0,
      rendererSize: 2,
      composerPixelRatio: 0,
      composerSize: 2,
    }, 'landscape return must add one logical setSize call per layer');
    assert.equal(report.normal.landscapeReturn.cameraAspect, report.normal.initial.cameraAspect,
      'landscape camera aspect did not return exactly');

    const steps = [];
    for(const expectedPR of [1.35, 1.1, 1]){
      await pageEvaluate(normal.page, `reset counters before PR ${expectedPR}`, () => window.__postTest.resetCounters());
      const snapshot = await pageEvaluate(
        normal.page,
        `govern to PR ${expectedPR}`,
        value => window.__postTest.governUntilPR(value, 30),
        expectedPR,
      );
      assertSynchronized(snapshot, {
        width: 1194, height: 834, pr: expectedPR, samples: 4, bloomEnabled: true,
        label: `governor PR ${expectedPR}`,
      });
      assertGovernorResizePath(snapshot, `governor PR ${expectedPR}`);
      steps.push(snapshot);
    }
    report.normal.governor = steps;

    await pageEvaluate(normal.page, 'reset counters before bloom disable', () => window.__postTest.resetCounters());
    report.normal.bloomDisabled = await pageEvaluate(
      normal.page,
      'govern until bloom disabled',
      () => window.__postTest.governUntilBloomDisabled(20),
    );
    assertSynchronized(report.normal.bloomDisabled, {
      width: 1194, height: 834, pr: 1, samples: 4, bloomEnabled: false, label: 'governor bloom disable',
    });
    assert.deepEqual(report.normal.bloomDisabled.counters, {
      rendererPixelRatio: 0,
      rendererSize: 0,
      composerPixelRatio: 0,
      composerSize: 0,
    }, 'bloom disable at PR1 must not resize either layer');
    assertPageDiagnostics(normal.errors, 'normal pipeline');
    await pageEvaluate(normal.page, 'dispose normal post pipeline', () => window.__postTest.dispose());
  } finally {
    await closePage(normal.page);
  }

  const lowfx = await openPage();
  try {
    await installPipeline(lowfx.page, origin, true);
    report.lowfx = await measure(lowfx.page);
    assertSynchronized(report.lowfx, {
      width: 1194, height: 834, pr: 1, samples: 0, bloomEnabled: true, label: 'lowfx initial',
    });
    assertPageDiagnostics(lowfx.errors, 'lowfx pipeline');
    await pageEvaluate(lowfx.page, 'dispose lowfx post pipeline', () => window.__postTest.dispose());
  } finally {
    await closePage(lowfx.page);
  }
  return report;
}

function postPipelineProbePlugin(game){
  const entry = path.join(ROOT, game, 'src/main.js');
  const needle = 'const { renderer, scene, camera, composer, grade } = pipe;';
  return {
    name: `playforge-post-pipeline-probe-${game}`,
    enforce: 'post',
    transform(code, id){
      if(id.split('?')[0] !== entry) return null;
      const occurrences = code.split(needle).length - 1;
      if(occurrences !== 1) throw new Error(`${game} post probe expected one pipeline destructure, received ${occurrences}`);
      return {
        code: code.replace(needle, `${needle}\nglobalThis.__postPipelineProbe = pipe;`),
        map: null,
      };
    },
  };
}

async function privateSourceVariant(origin, game, globalName, lowfx){
  const { page, errors } = await openPage();
  const quality = lowfx ? 'lowfx' : 'normal';
  try {
    const query = lowfx ? '?lowfx=1&fast=1' : '?fast=1';
    await boundedCall(`${game} ${quality} private source navigation`, () => page.goto(`${origin}/${query}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    }), 61_000);
    await boundedCall(`${game} ${quality} diagnostics ready`, () => page.waitForFunction(name => (
      Boolean(window[name]) && Boolean(globalThis.__postPipelineProbe)
    ), { timeout: 60_000 }, globalName), 61_000);
    const snapshot = await pageEvaluate(page, `${game} ${quality} pipeline snapshot`, name => {
      const pipe = globalThis.__postPipelineProbe;
      const canvas = pipe.renderer.domElement;
      const gl = pipe.renderer.getContext();
      const target1 = pipe.composer.renderTarget1;
      const target2 = pipe.composer.renderTarget2;
      const bloomBright = pipe.bloom.renderTargetBright;
      const bloomHorizontal0 = pipe.bloom.renderTargetsHorizontal[0];
      return {
        title: document.title,
        globalReady: Boolean(window[name]),
        inner: [innerWidth, innerHeight],
        devicePixelRatio,
        pr: pipe.PR,
        renderer: {
          pixelRatio: pipe.renderer.getPixelRatio(),
          canvas: [canvas.width, canvas.height],
          client: [canvas.clientWidth, canvas.clientHeight],
          drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        },
        composer: {
          logical: [pipe.composer._width, pipe.composer._height],
          pixelRatio: pipe.composer._pixelRatio,
          target1: [target1.width, target1.height],
          target2: [target2.width, target2.height],
          samples: [target1.samples, target2.samples],
        },
        bloom: {
          enabled: pipe.bloom.enabled,
          bright: [bloomBright.width, bloomBright.height],
          mip0: [bloomHorizontal0.width, bloomHorizontal0.height],
        },
        cameraAspect: pipe.camera.aspect,
        webgl: {
          error: gl.getError(),
          events: structuredClone(globalThis.__postWebGLState?.events || []),
        },
      };
    }, globalName);
    assert.equal(snapshot.globalReady, true, `${game} ${quality}: diagnostics global`);
    assertSynchronized(snapshot, {
      width: 1194,
      height: 834,
      pr: lowfx ? 1 : 1.6,
      samples: lowfx ? 0 : 4,
      bloomEnabled: true,
      label: `${game} ${quality} real-game boot`,
    });
    assertPageDiagnostics(errors, `${game} ${quality} real-game boot`);
    return snapshot;
  } finally {
    await closePage(page);
  }
}

async function privateSourceSmoke(game, globalName){
  const gameRoot = path.join(ROOT, game);
  const { server, origin } = await startVite(gameRoot, {
    configFile: path.join(gameRoot, 'vite.config.js'),
    plugins: [postPipelineProbePlugin(game)],
  });
  try {
    return {
      normal: await privateSourceVariant(origin, game, globalName, false),
      lowfx: await privateSourceVariant(origin, game, globalName, true),
    };
  } finally {
    await closeServer(server);
  }
}

async function cleanup(){
  const errors = [];
  for(const page of [...trackedPages]){
    try { await closePage(page); }
    catch(error){ errors.push(error); }
  }
  if(browser){
    try {
      await closeBrowserDeterministically(browser);
    } catch(error){
      errors.push(error);
    } finally {
      browser = null;
    }
  }
  for(const server of [...trackedServers]){
    try { await closeServer(server); }
    catch(error){ errors.push(error); }
  }
  return errors;
}

function releaseChildProcessHandles(child){
  if(!child) return;
  for(const stream of child.stdio || []){
    stream?.removeAllListeners?.();
    stream?.destroy?.();
    stream?.unref?.();
  }
  child.removeAllListeners?.();
  child.unref?.();
}

async function runWorker(){
  let report;
  let failure = null;
  let cleanupDiagnostics = null;
  try {
    let bundledChrome = null;
    try { bundledChrome = puppeteer.executablePath(); } catch {}
    const executablePath = resolveChromeExecutable({ bundledPath: bundledChrome });
    browser = await boundedCall('launch browser', () => puppeteer.launch({
      headless: true,
      executablePath,
      userDataDir: HARNESS_TEMP_DIR ? path.join(HARNESS_TEMP_DIR, 'chrome-profile') : undefined,
      timeout: OP_TIMEOUT_MS,
      protocolTimeout: 120_000,
      args: [
        '--no-sandbox', '--mute-audio', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
        '--disable-breakpad', '--disable-crash-reporter', '--no-crash-upload',
        `--playforge-post-harness=${RUN_MARKER}`,
      ],
    }), OP_TIMEOUT_MS + 1_000);

    if(process.env.POST_BROWSER_INJECT_SYNC_HANG){
      process.stderr.write(`post-browser-sync-hang-fixture:${RUN_MARKER}\n`);
      const blocker = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(blocker, 0, 0, 60_000);
      throw new Error('post-browser sync hang fixture unexpectedly returned');
    }

    const directServer = await startVite(ROOT, { configFile: false });
    try {
      report = { pipeline: await directPipelineGate(directServer.origin) };
    } finally {
      await closeServer(directServer.server);
    }
    report.privateSourcePages = {
      golf: await privateSourceSmoke('golf', '__gp'),
      runner: await privateSourceSmoke('runner', '__gp'),
    };
  } catch(error){
    failure = error;
  }

  const cleanupErrors = await cleanup();
  try {
    cleanupDiagnostics = await assertCleanHarness();
  } catch(error){
    cleanupErrors.push(error);
  }
  if(failure || cleanupErrors.length){
    throw new AggregateError([failure, ...cleanupErrors].filter(Boolean), 'post.browser failed');
  }

  report.teardownActiveResources = cleanupDiagnostics;
  console.log('post.browser: PASS');
  console.log(JSON.stringify(report, null, 2));
}

async function runSupervisor(){
  const tempDirectory = await timebox(
    mkdtemp(path.join(tmpdir(), 'playforge-post-browser-')),
    5_000,
    'create post.browser temp directory',
  );
  let child = null;
  let owned = null;
  let exitCode = 1;
  let timedOut = false;
  let acknowledgementReport = null;
  const cleanupErrors = [];
  try {
    const workerTitle = scopedGatedTitle(`${RUN_MARKER}:worker`);
    owned = spawnCapturedGatedNode({
      title: workerTitle,
      args: [SELF, WORKER_ARGUMENT],
      cwd: ROOT,
      env: {
        ...process.env,
        POST_BROWSER_WORKER: '1',
        POST_BROWSER_RUN_MARKER: RUN_MARKER,
        POST_BROWSER_TEMP_DIR: tempDirectory,
        POST_BROWSER_CONTAINMENT_MARKER: workerTitle,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = owned.child;
    let fixtureOutput = '';
    let resolveFixtureReady;
    const fixtureReady = new Promise(resolve => { resolveFixtureReady = resolve; });
    child.stdout.on('data', chunk => process.stdout.write(chunk));
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk);
      fixtureOutput = `${fixtureOutput}${chunk}`.slice(-4_096);
      if(fixtureOutput.includes(`post-browser-sync-hang-fixture:${RUN_MARKER}`)) resolveFixtureReady();
    });
    await releaseCapturedGatedNode(owned);
    const targetResultPromise = capturedGatedTargetResult(owned);
    const raceWithWatchdog = async () => {
      let timeoutId;
      const outcome = await Promise.race([
        targetResultPromise,
        new Promise(resolve => {
          timeoutId = setTimeout(() => resolve({ timeout: true }), OUTER_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timeoutId);
      return outcome;
    };
    let outcome;
    if(process.env.POST_BROWSER_ARM_WATCHDOG_AFTER_FIXTURE === '1'){
      const readiness = await Promise.race([
        targetResultPromise.then(value => ({ exited: true, value })),
        timebox(fixtureReady, OP_TIMEOUT_MS + 1_000, 'wait for sync-hang fixture').then(() => ({ ready: true })),
      ]);
      outcome = readiness.exited ? readiness.value : await raceWithWatchdog();
    } else {
      outcome = await raceWithWatchdog();
    }
    if(outcome.timeout){
      timedOut = true;
      process.stderr.write(`post.browser exceeded outer watchdog ${OUTER_TIMEOUT_MS}ms\n`);
      exitCode = 124;
    } else {
      exitCode = Number.isInteger(outcome.code) ? outcome.code : 1;
      acknowledgementReport = await acknowledgeCapturedGatedSentinelIfAlone(owned);
    }
  } catch(error){
    cleanupErrors.push(error);
  } finally {
    if(owned){
      let finalizationReport = null;
      if(acknowledgementReport?.acknowledged
        && acknowledgementReport.final?.state === 'PROVEN_DEAD'){
        finalizationReport = acknowledgementReport;
      } else {
        try {
          finalizationReport = await finalizeCapturedGatedProcessGroup(owned, {
            label: 'post.browser captured worker group',
          });
        } catch(error){
          finalizationReport = error?.report || null;
          cleanupErrors.push(error);
        }
      }
      const initialMembers = acknowledgementReport?.initial?.memberPids || [];
      if(exitCode === 0 && initialMembers.some(pid => pid !== owned.identity.pid)){
        cleanupErrors.push(new Error('post.browser worker exited successfully with live process-group members'));
      }
    }
    abortCapturedGatedNode(owned);
    releaseChildProcessHandles(child);
    try {
      await timebox(rm(tempDirectory, { recursive: true, force: true }), 5_000, 'remove post.browser temp directory');
    } catch(error){
      cleanupErrors.push(error);
    }
    try {
      await assertCleanHarness();
    } catch(error){
      cleanupErrors.push(error);
    }
  }
  if(cleanupErrors.length){
    for(const error of cleanupErrors) process.stderr.write(`post.browser supervisor cleanup: ${error.message}\n`);
    if(!timedOut) exitCode = 1;
  }
  return exitCode;
}

if(IS_WORKER){
  await runWorker();
} else {
  process.exitCode = await runSupervisor();
}
