/* Playforge engine — deterministic simulation time separated from presentation. */

/**
 * Fixed-step accumulator with independently tracked wall, cinematic, and
 * simulation clocks. Pass simulate:false (or setSimulating(false)) in terminal
 * modes so presentation can continue without destructive simulation updates.
 */
export function createFixedStepRunner({
  step = 1 / 120,
  maxFrame = 0.1,
  maxSteps = 12,
  onStep = () => {},
} = {}){
  if(!Number.isFinite(step) || step <= 0) throw new RangeError('step must be greater than zero');
  if(!Number.isFinite(maxFrame) || maxFrame <= 0) throw new RangeError('maxFrame must be greater than zero');
  if(!Number.isInteger(maxSteps) || maxSteps < 1) throw new RangeError('maxSteps must be a positive integer');
  if(typeof onStep !== 'function') throw new TypeError('onStep must be a function');
  const epsilon = Math.max(Number.EPSILON * 16, step * 1e-9);

  const state = {
    wallTime: 0,
    cinematicTime: 0,
    simulationTime: 0,
    accumulator: 0,
    droppedTime: 0,
    alpha: 0,
    simulating: true,
  };
  const metrics = {
    legacyAdvanceCalls: 0,
    advanceIntoCalls: 0,
    legacyStepSnapshotAllocations: 0,
    legacyFrameSnapshotAllocations: 0,
    diagnosticSnapshotAllocations: 0,
    reusedStepWrites: 0,
    reusedFrameWrites: 0,
  };
  const reusedStepSnapshot = {};

  function snapshot(extra = {}){
    metrics.diagnosticSnapshotAllocations += 1;
    return { ...state, step, ...extra };
  }

  function writeSnapshotInto(out, steps = undefined, dropped = undefined){
    if(!out || typeof out !== 'object' || Array.isArray(out)){
      throw new TypeError('fixed-step output must be a caller-owned object');
    }
    out.wallTime = state.wallTime;
    out.cinematicTime = state.cinematicTime;
    out.simulationTime = state.simulationTime;
    out.accumulator = state.accumulator;
    out.droppedTime = state.droppedTime;
    out.alpha = state.alpha;
    out.simulating = state.simulating;
    out.step = step;
    out.steps = steps ?? 0;
    out.dropped = dropped ?? 0;
    return out;
  }

  function snapAccumulator(){
    if(Math.abs(state.accumulator) <= epsilon) state.accumulator = 0;
  }

  function advanceCore(wallDelta, options, frameOut = null){
    const simulate = options?.simulate ?? state.simulating;
    const timeScale = options?.timeScale ?? 1;
    const cinematicScale = options?.cinematicScale ?? 1;
    if(!Number.isFinite(wallDelta) || wallDelta < 0) throw new RangeError('wallDelta must be a non-negative number');
    if(!Number.isFinite(timeScale) || timeScale < 0) throw new RangeError('timeScale must be a non-negative number');
    if(!Number.isFinite(cinematicScale) || cinematicScale < 0) throw new RangeError('cinematicScale must be a non-negative number');

    state.wallTime += wallDelta;
    state.cinematicTime += wallDelta * cinematicScale;
    const droppedAtStart = state.droppedTime;
    let steps = 0;
    let dropped = 0;

    if(simulate && state.simulating && timeScale > 0){
      const acceptedWall = Math.min(wallDelta, maxFrame);
      dropped += Math.max(0, wallDelta - acceptedWall) * timeScale;
      state.accumulator += acceptedWall * timeScale;

      while(state.simulating && state.accumulator >= step - epsilon && steps < maxSteps){
        state.accumulator -= step;
        snapAccumulator();
        state.simulationTime += step;
        steps += 1;
        if(frameOut){
          metrics.reusedStepWrites += 1;
          onStep(step, writeSnapshotInto(reusedStepSnapshot, steps));
        } else {
          metrics.legacyStepSnapshotAllocations += 1;
          onStep(step, snapshot({ steps }));
        }
      }

      if(state.accumulator >= step - epsilon){
        const wholeSteps = Math.floor((state.accumulator + epsilon) / step);
        const overflow = wholeSteps * step;
        state.accumulator -= overflow;
        snapAccumulator();
        dropped += overflow;
      }
      state.droppedTime += dropped;
    }

    snapAccumulator();
    state.alpha = Math.min(1, Math.max(0, state.accumulator / step));
    const droppedThisFrame = state.droppedTime - droppedAtStart;
    if(frameOut){
      metrics.reusedFrameWrites += 1;
      return writeSnapshotInto(frameOut, steps, droppedThisFrame);
    }
    metrics.legacyFrameSnapshotAllocations += 1;
    return snapshot({ steps, dropped: droppedThisFrame });
  }

  function advance(wallDelta, options = undefined){
    metrics.legacyAdvanceCalls += 1;
    return advanceCore(wallDelta, options, null);
  }

  /** Allocation-free companion to advance(). Existing callers keep the
   * historical fresh snapshots; hot loops may reuse `out` and receive one
   * stable step-state identity in onStep. */
  function advanceInto(wallDelta, options, out){
    if(!out || typeof out !== 'object' || Array.isArray(out)){
      throw new TypeError('advanceInto requires a caller-owned output object');
    }
    metrics.advanceIntoCalls += 1;
    return advanceCore(wallDelta, options, out);
  }

  function setSimulating(value){
    state.simulating = Boolean(value);
    // Discard partial/catch-up time when simulation stops so resuming can never
    // replay destructive updates accumulated after a terminal transition.
    if(!state.simulating){
      state.droppedTime += state.accumulator;
      state.accumulator = 0;
    }
    return state.simulating;
  }

  function reset({ wallTime = 0, cinematicTime = 0, simulationTime = 0 } = {}){
    for(const [name, value] of Object.entries({ wallTime, cinematicTime, simulationTime })){
      if(!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative number`);
    }
    Object.assign(state, {
      wallTime,
      cinematicTime,
      simulationTime,
      accumulator: 0,
      droppedTime: 0,
      alpha: 0,
    });
    return snapshot();
  }

  return {
    advance,
    advanceInto,
    setSimulating,
    reset,
    snapshot,
    get state(){ return snapshot(); },
    get metrics(){ return { ...metrics }; },
  };
}
