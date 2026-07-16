/* Playforge engine — explicit modes with deterministic, mode-owned work. */
import { createStateTrace } from './trace.js';

const errorDetail = (stage, error) => ({ stage, message: error?.message || String(error) });

/**
 * Create an explicit mode scope.
 *
 * handlers: { [mode]: { enter(scope, transition), exit(scope, transition) } }
 * canTransition(from, to, transition): boolean
 *
 * schedule() uses seconds on an explicit clock advanced only by tick(); it is
 * never a wall-clock timeout. Tasks/effects belong to the current generation
 * and are cancelled on transition. Hook failures never escape: exit/cleanup
 * failures leave the scope in a recoverable neutral mode; enter failures tear
 * down everything registered by that enter hook and also leave neutral mode.
 * Reentrant transitions from guards/hooks/teardown are rejected with a trace.
 */
export function createModeScope({
  initial = null,
  handlers = {},
  canTransition = () => true,
  trace = createStateTrace(),
} = {}){
  if(typeof canTransition !== 'function') throw new TypeError('canTransition must be a function');

  let mode = null;
  let generation = 0;
  let disposed = false;
  let phase = 'idle';
  let ticking = false;
  let modeTime = 0;
  let controller = new AbortController();
  let taskSequence = 0;
  const tasks = new Map();
  const effects = new Map();

  const api = {
    transition,
    schedule,
    tick,
    own,
    guard,
    dispose,
    is: expected => mode === expected,
    trace,
    get mode(){ return mode; },
    get modeTime(){ return modeTime; },
    get generation(){ return generation; },
    get signal(){ return controller.signal; },
    get active(){ return !disposed; },
    get phase(){ return phase; },
    get pendingTasks(){ return tasks.size; },
  };

  function transitionRecord(from, to, reason, status, code, errors = [], detail = null){
    const result = { ok: status === 'accepted', from, to, reason, status, code, errors };
    trace.transition(from, to, reason, { status, code, generation, errors, detail });
    return result;
  }

  function rejectTransition(from, to, reason, code, detail = null){
    return transitionRecord(from, to, reason, 'rejected', code, [], detail);
  }

  function rejectRegistration(kind, label){
    trace.record('registration-rejected', { kind, label, mode, phase, generation });
    return () => false;
  }

  function canRegister(){
    return !disposed && mode !== null && (phase === 'idle' || phase === 'entering');
  }

  function teardown(reason){
    const errors = [];
    try { controller.abort(reason); }
    catch(error){
      errors.push(errorDetail('abort', error));
      trace.record('cleanup-error', { mode, label: 'abort-signal', reason, message: error?.message || String(error) });
    }
    tasks.clear();
    for(const [cleanup, label] of [...effects.entries()].reverse()){
      effects.delete(cleanup);
      try { cleanup(reason); }
      catch(error){
        errors.push(errorDetail(`cleanup:${label}`, error));
        trace.record('cleanup-error', { mode, label, reason, message: error?.message || String(error) });
      }
    }
    // Registrations attempted by abort/cleanup callbacks were rejected, but
    // clear defensively in case a host callback mutated during teardown.
    tasks.clear();
    effects.clear();
    return errors;
  }

  function neutralize(reason){
    mode = null;
    modeTime = 0;
    generation += 1;
    controller = new AbortController();
    controller.abort(reason);
  }

  function transition(next, { reason = 'unspecified', detail = null } = {}){
    if(typeof next !== 'string' || !next) throw new TypeError('next mode must be a non-empty string');
    if(typeof reason !== 'string' || !reason) throw new TypeError('transition reason must be a non-empty string');
    const from = mode;

    if(disposed && phase === 'disposed') return rejectTransition(from, next, reason, 'scope-disposed', detail);
    if(phase !== 'idle') return rejectTransition(from, next, reason, 'transition-busy', detail);
    if(disposed) return rejectTransition(from, next, reason, 'scope-disposed', detail);
    if(next === from) return rejectTransition(from, next, reason, 'same-mode', detail);

    const request = { from, to: next, reason, detail };
    phase = 'checking';
    let allowed = false;
    try { allowed = Boolean(canTransition(from, next, request)); }
    catch(error){
      phase = 'idle';
      const errors = [errorDetail('transition-guard', error)];
      return transitionRecord(from, next, reason, 'failed', 'guard-error', errors, detail);
    }
    if(!allowed){
      phase = 'idle';
      return rejectTransition(from, next, reason, 'not-allowed', detail);
    }

    const exitErrors = [];
    phase = 'exiting';
    try { handlers[from]?.exit?.(api, request); }
    catch(error){ exitErrors.push(errorDetail('exit-hook', error)); }
    finally {
      phase = 'teardown';
      exitErrors.push(...teardown(`leave:${from ?? 'none'}:${reason}`));
    }

    if(exitErrors.length){
      neutralize('transition-exit-failed');
      phase = 'idle';
      const code = exitErrors.some(error => error.stage === 'exit-hook') ? 'exit-hook-error' : 'teardown-error';
      return transitionRecord(from, next, reason, 'failed', code, exitErrors, detail);
    }

    mode = next;
    modeTime = 0;
    generation += 1;
    controller = new AbortController();
    phase = 'entering';
    const enterErrors = [];
    try { handlers[next]?.enter?.(api, request); }
    catch(error){ enterErrors.push(errorDetail('enter-hook', error)); }

    if(enterErrors.length){
      phase = 'teardown';
      enterErrors.push(...teardown(`enter-failed:${next}`));
      neutralize('transition-enter-failed');
      phase = 'idle';
      return transitionRecord(from, next, reason, 'failed', 'enter-hook-error', enterErrors, detail);
    }

    phase = 'idle';
    return transitionRecord(from, next, reason, 'accepted', 'ok', [], detail);
  }

  /** Schedule mode-owned work in seconds; tick() is its only clock source. */
  function schedule(delaySeconds, callback, { label = 'task' } = {}){
    if(!canRegister()) return rejectRegistration('task', label);
    if(!Number.isFinite(delaySeconds) || delaySeconds < 0) throw new RangeError('delaySeconds must be a non-negative number');
    if(typeof callback !== 'function') throw new TypeError('callback must be a function');
    const id = ++taskSequence;
    tasks.set(id, { id, remaining: delaySeconds, callback, label, generation, mode });
    return () => tasks.delete(id);
  }

  /** Advance the active mode's deterministic task clock. */
  function tick(deltaSeconds){
    if(!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new RangeError('deltaSeconds must be a non-negative number');
    if(disposed) return { ok: false, code: 'scope-disposed', fired: 0, errors: [] };
    if(ticking) {
      trace.record('tick-rejected', { code: 'tick-busy', mode, generation });
      return { ok: false, code: 'tick-busy', fired: 0, errors: [] };
    }
    if(phase !== 'idle') {
      trace.record('tick-rejected', { code: 'transition-busy', mode, generation });
      return { ok: false, code: 'transition-busy', fired: 0, errors: [] };
    }

    ticking = true;
    const ownerGeneration = generation;
    const ownerMode = mode;
    let fired = 0;
    const errors = [];
    try {
      modeTime += deltaSeconds;
      const due = [];
      for(const task of tasks.values()){
        if(task.generation !== ownerGeneration || task.mode !== ownerMode) continue;
        task.remaining -= deltaSeconds;
        if(task.remaining <= Number.EPSILON) due.push(task);
      }
      due.sort((a, b) => a.id - b.id);
      for(const task of due){
        if(disposed || generation !== ownerGeneration || mode !== ownerMode){
          tasks.delete(task.id);
          trace.record('task-skipped', { mode: task.mode, label: task.label, generation: task.generation });
          continue;
        }
        // Keep a due task registered until its own dispatch so an earlier due
        // callback can still cancel a later sibling in this same tick.
        if(tasks.get(task.id) !== task){
          trace.record('task-cancelled', { mode: task.mode, label: task.label, generation: task.generation });
          continue;
        }
        tasks.delete(task.id);
        try {
          fired += 1;
          trace.record('task-fired', { mode: task.mode, label: task.label, generation: task.generation });
          task.callback(api);
        } catch(error){
          const info = errorDetail(`task:${task.label}`, error);
          errors.push(info);
          trace.record('task-error', { mode: task.mode, label: task.label, generation: task.generation, message: info.message });
        }
      }
    } finally {
      ticking = false;
    }
    return { ok: errors.length === 0, code: errors.length ? 'task-error' : 'ok', fired, errors, modeTime };
  }

  function own(cleanup, { label = 'effect' } = {}){
    if(!canRegister()) return rejectRegistration('effect', label);
    if(typeof cleanup !== 'function') throw new TypeError('cleanup must be a function');
    effects.set(cleanup, label);
    return (reason = 'manual-cancel') => {
      if(!effects.delete(cleanup)) return false;
      try { cleanup(reason); }
      catch(error){
        trace.record('cleanup-error', { mode, label, reason, message: error?.message || String(error) });
        return false;
      }
      return true;
    };
  }

  function guard(callback, { label = 'guard' } = {}){
    if(typeof callback !== 'function') throw new TypeError('callback must be a function');
    const ownerGeneration = generation;
    const ownerMode = mode;
    return (...args) => {
      if(disposed || generation !== ownerGeneration || mode !== ownerMode || controller.signal.aborted){
        trace.record('guard-skipped', { mode: ownerMode, label, generation: ownerGeneration });
        return undefined;
      }
      return callback(...args);
    };
  }

  function dispose(reason = 'dispose'){
    if(typeof reason !== 'string' || !reason) throw new TypeError('dispose reason must be a non-empty string');
    if(disposed && phase === 'disposed') return { ok: false, code: 'scope-disposed', errors: [] };
    if(phase !== 'idle') return { ok: false, code: 'transition-busy', errors: [] };

    const from = mode;
    const request = { from, to: null, reason, detail: null };
    const errors = [];
    phase = 'disposing';
    disposed = true;
    try {
      try { handlers[from]?.exit?.(api, request); }
      catch(error){ errors.push(errorDetail('dispose-exit-hook', error)); }
    } finally {
      try {
        phase = 'teardown';
        errors.push(...teardown(reason));
      } finally {
        mode = null;
        modeTime = 0;
        generation += 1;
        phase = 'disposed';
      }
    }
    trace.record('scope-disposed', { from, reason, generation, errors });
    return { ok: errors.length === 0, code: errors.length ? 'dispose-hook-error' : 'disposed', errors };
  }

  if(initial !== null) transition(initial, { reason: 'initial' });
  return api;
}
