import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { resolveChromeExecutable } from './chrome-path.mjs';
import { assertContainedPhaseTarget } from './phase-target-bootstrap.mjs';

assertContainedPhaseTarget('foundation browser gate');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let bundledChrome = null;
try { bundledChrome = puppeteer.executablePath(); } catch {}
const CHROME = resolveChromeExecutable({ bundledPath: bundledChrome });

const server = await createServer({
  root: ROOT,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
let browser;

try {
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === 'object' ? address.port : 0;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/tools/foundation-fixture.html`, { waitUntil: 'networkidle0' });

  const screenAudit = await page.evaluate(async () => {
    const { setScreenActive, auditInactiveScreenHits, auditInactiveScreenState } = await import('/engine/screen.js');
    const screen = document.getElementById('inactive');
    const button = document.getElementById('hiddenButton');

    setScreenActive(screen, false);
    const authoritative = {
      hidden: screen.hidden,
      inert: screen.inert,
      ariaHidden: screen.getAttribute('aria-hidden'),
      classHidden: screen.classList.contains('hide'),
      active: screen.dataset.screenActive,
      focused: document.activeElement === button,
    };
    const authoritativeState = auditInactiveScreenState();

    // Emulate a legacy class-only inactive screen to prove that a descendant
    // .rbtn rule cannot restore hit testing through .hide. This hit audit is
    // also callable unchanged against future built standalone artifacts.
    screen.hidden = false;
    screen.inert = false;
    const legacyState = auditInactiveScreenState();
    const inactive = auditInactiveScreenHits({ step: 8 });
    const centerHitWhileHidden = document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.id;

    setScreenActive(screen, true);
    const centerHitWhileActive = document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.id;
    const active = {
      hidden: screen.hidden,
      inert: screen.inert,
      ariaHidden: screen.getAttribute('aria-hidden'),
      classHidden: screen.classList.contains('hide'),
      active: screen.dataset.screenActive,
      focused: document.activeElement === button,
    };
    setScreenActive(screen, false);
    const focusCleared = document.activeElement !== button;
    return {
      authoritative,
      authoritativeState,
      legacyState,
      inactive,
      centerHitWhileHidden,
      centerHitWhileActive,
      active,
      focusCleared,
    };
  });

  assert.deepEqual(screenAudit.authoritative, {
    hidden: true,
    inert: true,
    ariaHidden: 'true',
    classHidden: true,
    active: 'false',
    focused: false,
  });
  assert.deepEqual(screenAudit.authoritativeState, { ok: true, screens: 1, violations: [] });
  assert.equal(screenAudit.legacyState.ok, false, 'state audit must distinguish pointer-safe legacy hiding from authoritative hiding');
  assert.deepEqual(screenAudit.legacyState.violations[0].missing, ['hidden', 'inert']);
  assert.equal(screenAudit.inactive.ok, true);
  assert.equal(screenAudit.inactive.inactiveScreens, 1);
  assert.equal(screenAudit.inactive.interactiveDescendants, 1);
  assert.ok(screenAudit.inactive.samples > 12_000, 'audit must sample the full iPad-sized viewport');
  assert.notEqual(screenAudit.centerHitWhileHidden, 'hiddenButton');
  assert.equal(screenAudit.centerHitWhileActive, 'hiddenButton');
  assert.deepEqual(screenAudit.active, {
    hidden: false,
    inert: false,
    ariaHidden: 'false',
    classHidden: false,
    active: 'true',
    focused: true,
  });
  assert.equal(screenAudit.focusCleared, true);

  const gestureAudit = await page.evaluate(async () => {
    const { createGestureSession } = await import('/engine/gesture.js');
    const surface = document.getElementById('surface');
    const ignoredPointer = document.getElementById('ignoredPointer');
    const outsidePointer = document.getElementById('outsidePointer');
    const events = [];
    let explicitTargetError = null;
    try { createGestureSession(); }
    catch(error){ explicitTargetError = error.message; }

    const session = createGestureSession({
      target: surface,
      ignore: ['.ignored'],
      deadzone: 10,
      hysteresis: 5,
      onStart: state => events.push(['start', state.sequence]),
      onMove: (state, event, samples) => events.push(['move', state.sampleCount, samples.length]),
      onDirection: state => events.push(['direction', state.direction]),
      onEnd: state => events.push(['end', state.engaged, state.direction]),
      onCancel: (state, event, reason) => events.push(['cancel', reason, state.phase]),
    });

    const pointer = (type, pointerId, x, y, options = {}) => new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: 'touch',
      isPrimary: options.isPrimary ?? true,
      clientX: x,
      clientY: y,
    });
    const down = (id = 1) => surface.dispatchEvent(pointer('pointerdown', id, 100, 100));
    const cancelBy = (type, id = 1) => window.dispatchEvent(pointer(type, id, 100, 100));

    ignoredPointer.dispatchEvent(pointer('pointerdown', 90, 30, 30));
    const ignoredFirstPointer = session.state;

    down();
    const coalescedMove = pointer('pointermove', 1, 170, 130);
    Object.defineProperty(coalescedMove, 'getCoalescedEvents', {
      value: () => [pointer('pointermove', 1, 130, 130), pointer('pointermove', 1, 170, 130)],
    });
    window.dispatchEvent(coalescedMove);
    const during = session.state;
    window.dispatchEvent(pointer('pointerup', 1, 170, 130));
    const afterEnd = session.state;

    down(2);
    cancelBy('pointercancel', 2);
    const afterPointerCancel = session.state;

    down(3);
    surface.dispatchEvent(pointer('lostpointercapture', 3, 100, 100));
    const afterLostCapture = session.state;

    down(4);
    window.dispatchEvent(new Event('blur'));
    const afterBlur = session.state;

    let forcedHidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => forcedHidden });
    down(5);
    forcedHidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    forcedHidden = false;
    const afterVisibility = session.state;

    down(6);
    ignoredPointer.dispatchEvent(pointer('pointerdown', 7, 30, 30, { isPrimary: false }));
    const afterIgnoredMultitouch = session.state;

    down(8);
    outsidePointer.dispatchEvent(pointer('pointerdown', 9, 900, 700, { isPrimary: false }));
    const afterOutsideMultitouch = session.state;
    const sequenceAfterOutsideCancel = session.state.sequence;
    outsidePointer.dispatchEvent(pointer('pointerdown', 10, 900, 700));
    const outsideIdle = session.state.active === false && session.state.sequence === sequenceAfterOutsideCancel;

    down(11);
    window.dispatchEvent(new Event('orientationchange'));
    const afterOrientation = session.state;

    down(12);
    session.disable();
    const afterDisable = session.state;
    down(13);
    const disabledStillIdle = session.state;
    session.enable();
    down(14);
    const enabledActive = session.state.active;
    session.dispose();
    const afterDispose = session.state;
    down(15);
    const disposedStillIdle = session.state;
    const enableAfterDispose = session.enable();

    const callbackErrors = [];
    let throwAt = null;
    const fail = name => { if(throwAt === name) throw new Error(`${name} exploded`); };
    const failing = createGestureSession({
      target: surface,
      deadzone: 5,
      hysteresis: 0,
      onStart(){ fail('onStart'); },
      onMove(){ fail('onMove'); },
      onDirection(){ fail('onDirection'); },
      onEnd(){ fail('onEnd'); },
      onCancel(){ fail('onCancel'); },
      onError(error, context){
        callbackErrors.push([context.callback, error.message, context.state.active]);
        if(context.callback === 'onCancel') throw new Error('onError also exploded');
      },
    });

    throwAt = 'onStart';
    surface.dispatchEvent(pointer('pointerdown', 20, 100, 100));
    const afterStartError = failing.state;
    throwAt = 'onMove';
    surface.dispatchEvent(pointer('pointerdown', 21, 100, 100));
    window.dispatchEvent(pointer('pointermove', 21, 102, 102));
    const afterMoveError = failing.state;
    throwAt = 'onDirection';
    surface.dispatchEvent(pointer('pointerdown', 22, 100, 100));
    window.dispatchEvent(pointer('pointermove', 22, 140, 100));
    const afterDirectionError = failing.state;
    throwAt = 'onEnd';
    surface.dispatchEvent(pointer('pointerdown', 23, 100, 100));
    window.dispatchEvent(pointer('pointerup', 23, 100, 100));
    const afterEndError = failing.state;
    throwAt = 'onCancel';
    surface.dispatchEvent(pointer('pointerdown', 24, 100, 100));
    const disableReturn = failing.disable();
    const afterCancelError = failing.state;
    failing.enable();
    surface.dispatchEvent(pointer('pointerdown', 25, 100, 100));
    const disposeReturn = failing.dispose();
    const afterFailingDispose = failing.state;
    const failingEnableAfterDispose = failing.enable();

    const lifecycleReentry = [];
    let reentrant;
    reentrant = createGestureSession({
      target: surface,
      onCancel(state, event, reason){
        lifecycleReentry.push([
          reason,
          reentrant.enable(),
          reentrant.dispose(),
          reentrant.disable(),
        ]);
      },
    });
    surface.dispatchEvent(pointer('pointerdown', 30, 100, 100));
    const reentrantDisableReturn = reentrant.disable();
    const afterReentrantDisable = reentrant.state;
    const enableAfterReentrantDisable = reentrant.enable();
    surface.dispatchEvent(pointer('pointerdown', 31, 100, 100));
    const reentrantDisposeReturn = reentrant.dispose();
    const afterReentrantDispose = reentrant.state;
    const enableAfterReentrantDispose = reentrant.enable();

    return {
      explicitTargetError,
      events,
      ignoredFirstPointer,
      during,
      afterEnd,
      afterPointerCancel,
      afterLostCapture,
      afterBlur,
      afterVisibility,
      afterIgnoredMultitouch,
      afterOutsideMultitouch,
      outsideIdle,
      afterOrientation,
      afterDisable,
      disabledStillIdle,
      enabledActive,
      afterDispose,
      disposedStillIdle,
      enableAfterDispose,
      callbackErrors,
      afterStartError,
      afterMoveError,
      afterDirectionError,
      afterEndError,
      disableReturn,
      afterCancelError,
      disposeReturn,
      afterFailingDispose,
      failingEnableAfterDispose,
      lifecycleReentry,
      reentrantDisableReturn,
      afterReentrantDisable,
      enableAfterReentrantDisable,
      reentrantDisposeReturn,
      afterReentrantDispose,
      enableAfterReentrantDispose,
    };
  });

  assert.match(gestureAudit.explicitTargetError, /explicit EventTarget/);
  assert.equal(gestureAudit.ignoredFirstPointer.active, false);
  assert.equal(gestureAudit.ignoredFirstPointer.sequence, 0);
  assert.equal(gestureAudit.during.active, true);
  assert.equal(gestureAudit.during.engaged, true);
  assert.equal(gestureAudit.during.direction, 'right');
  assert.equal(gestureAudit.during.sampleCount, 3, 'coalesced samples must be processed');
  assert.equal(gestureAudit.afterEnd.active, false);
  assert.equal(gestureAudit.afterPointerCancel.lastCancelReason, 'pointercancel');
  assert.equal(gestureAudit.afterLostCapture.lastCancelReason, 'lostpointercapture');
  assert.equal(gestureAudit.afterBlur.lastCancelReason, 'blur');
  assert.equal(gestureAudit.afterVisibility.lastCancelReason, 'visibilitychange');
  assert.equal(gestureAudit.afterIgnoredMultitouch.lastCancelReason, 'multitouch');
  assert.equal(gestureAudit.afterOutsideMultitouch.lastCancelReason, 'multitouch');
  assert.equal(gestureAudit.outsideIdle, true);
  assert.equal(gestureAudit.afterOrientation.lastCancelReason, 'orientationchange');
  assert.equal(gestureAudit.afterDisable.lastCancelReason, 'disabled');
  assert.equal(gestureAudit.afterDisable.enabled, false);
  assert.equal(gestureAudit.disabledStillIdle.active, false);
  assert.equal(gestureAudit.enabledActive, true);
  assert.equal(gestureAudit.afterDispose.lastCancelReason, 'disposed');
  assert.equal(gestureAudit.afterDispose.enabled, false);
  assert.equal(gestureAudit.afterDispose.disposed, true);
  assert.equal(gestureAudit.disposedStillIdle.active, false);
  assert.equal(gestureAudit.enableAfterDispose, false);
  assert.ok(gestureAudit.events.some(event => event[0] === 'direction' && event[1] === 'right'));

  assert.deepEqual(gestureAudit.callbackErrors.map(error => error[0]), [
    'onStart', 'onMove', 'onDirection', 'onEnd', 'onCancel', 'onCancel',
  ]);
  assert.equal(gestureAudit.afterStartError.lastCancelReason, 'callback-error:onStart');
  assert.equal(gestureAudit.afterMoveError.lastCancelReason, 'callback-error:onMove');
  assert.equal(gestureAudit.afterDirectionError.lastCancelReason, 'callback-error:onDirection');
  assert.equal(gestureAudit.afterEndError.active, false);
  assert.equal(gestureAudit.afterEndError.lastError.callback, 'onEnd');
  assert.equal(gestureAudit.disableReturn, false);
  assert.equal(gestureAudit.afterCancelError.active, false);
  assert.equal(gestureAudit.afterCancelError.enabled, false);
  assert.equal(gestureAudit.afterCancelError.lastError.callback, 'onCancel');
  assert.equal(gestureAudit.disposeReturn, true);
  assert.equal(gestureAudit.afterFailingDispose.active, false);
  assert.equal(gestureAudit.afterFailingDispose.disposed, true);
  assert.equal(gestureAudit.failingEnableAfterDispose, false);
  assert.deepEqual(gestureAudit.lifecycleReentry, [
    ['disabled', false, false, false],
    ['disposed', false, false, false],
  ]);
  assert.equal(gestureAudit.reentrantDisableReturn, false);
  assert.equal(gestureAudit.afterReentrantDisable.enabled, false);
  assert.equal(gestureAudit.afterReentrantDisable.disposed, false);
  assert.equal(gestureAudit.afterReentrantDisable.lifecycle, 'ready');
  assert.equal(gestureAudit.enableAfterReentrantDisable, true);
  assert.equal(gestureAudit.reentrantDisposeReturn, true);
  assert.equal(gestureAudit.afterReentrantDispose.enabled, false);
  assert.equal(gestureAudit.afterReentrantDispose.disposed, true);
  assert.equal(gestureAudit.afterReentrantDispose.lifecycle, 'disposed');
  assert.equal(gestureAudit.enableAfterReentrantDispose, false);
  assert.deepEqual(pageErrors, []);

  console.log(JSON.stringify({
    ok: true,
    chrome: CHROME,
    screen: {
      viewportSamples: screenAudit.inactive.samples,
      inactiveScreens: screenAudit.inactive.inactiveScreens,
      interactiveDescendants: screenAudit.inactive.interactiveDescendants,
      violations: screenAudit.inactive.violations.length,
      authoritativeStateViolations: screenAudit.authoritativeState.violations.length,
      hiddenCenterTarget: screenAudit.centerHitWhileHidden,
      activeCenterTarget: screenAudit.centerHitWhileActive,
    },
    gesture: {
      coalescedSampleCount: gestureAudit.during.sampleCount,
      cancellationReasons: gestureAudit.events.filter(event => event[0] === 'cancel').map(event => event[1]),
      callbackFailuresContained: gestureAudit.callbackErrors.map(error => error[0]),
    },
  }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
