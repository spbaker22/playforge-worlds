/* Stackyard Golf — guarded, mode-owned turn and screen lifecycle. */
import { createModeScope } from '../../engine/mode.js';

const ALLOWED = new Map([
  [null, new Set(['title'])],
  ['title', new Set(['intro'])],
  ['intro', new Set(['aim-enter'])],
  ['aim-enter', new Set(['aim'])],
  ['aim', new Set(['aiming', 'roll'])],
  ['aiming', new Set(['aim', 'roll'])],
  ['roll', new Set(['settling', 'sunk'])],
  ['settling', new Set(['aim-enter'])],
  ['sunk', new Set(['card'])],
  ['card', new Set(['next-hole', 'results'])],
  ['next-hole', new Set(['aim-enter'])],
  ['results', new Set(['replay'])],
  ['replay', new Set(['aim-enter'])],
]);

/**
 * GolfFlow is intentionally small: it defines the legal game graph and leaves
 * presentation/physics to mode handlers supplied by the world.
 */
export function createGolfFlow({ handlers, trace } = {}){
  let lastTransition = null;
  const scope = createModeScope({
    handlers,
    trace,
    canTransition(from, to){ return ALLOWED.get(from)?.has(to) === true; },
  });

  function transition(to, options = {}){
    const result = scope.transition(to, options);
    lastTransition = {
      ...result,
      detail: options.detail ?? null,
      generation: scope.generation,
    };
    return result;
  }

  return {
    transition,
    schedule: (...args) => scope.schedule(...args),
    tick: (...args) => scope.tick(...args),
    own: (...args) => scope.own(...args),
    guard: (...args) => scope.guard(...args),
    is: (...args) => scope.is(...args),
    dispose: (...args) => scope.dispose(...args),
    get mode(){ return scope.mode; },
    get modeTime(){ return scope.modeTime; },
    get generation(){ return scope.generation; },
    get pendingTasks(){ return scope.pendingTasks; },
    get trace(){ return scope.trace; },
    get lastTransition(){ return lastTransition ? structuredClone(lastTransition) : null; },
  };
}
