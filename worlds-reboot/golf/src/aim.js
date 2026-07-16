/* Stackyard Golf — absolute world-plane direct-target aiming. */
import * as THREE from 'three';
import { createGestureSession } from '../../engine/gesture.js';
import {
  MAX_TARGET_DISTANCE,
  MIN_TARGET_DISTANCE,
  MOUSE_AIM_ENTER_PX,
  MOUSE_AIM_EXIT_PX,
  targetPowerFromDistance,
} from './putting.js';

const copyVec = vector => vector.toArray().map(value => +value.toFixed(5));

/**
 * The resting reticle stays two metres cupward until the pointer deliberately
 * leaves a screen-space deadzone. Once engaged, the CURRENT pointer ray is
 * intersected with the locked ball plane and that absolute point is the target
 * (clamped radially from the ball). Pointer-down world position is never part
 * of direction or power, so the same current pointer always means the same
 * shot regardless of where the gesture began.
 */
export function createGolfAimController({
  canvas,
  camera,
  getBallPosition,
  canStart = () => true,
  onBegin = () => {},
  onUpdate = () => {},
  onRelease = () => {},
  onAbort = () => {},
  ballRadius = 0.34,
  maxTargetDistance = MAX_TARGET_DISTANCE,
  minTargetDistance = MIN_TARGET_DISTANCE,
  restTargetDistance = 2,
  screenDeadzone = 0.018,
  screenExitDeadzone = 0.012,
  mouseDeadzone = MOUSE_AIM_ENTER_PX,
  mouseExitDeadzone = MOUSE_AIM_EXIT_PX,
} = {}){
  if(!canvas?.getBoundingClientRect) throw new TypeError('GolfAimController requires a canvas');
  if(!camera?.isCamera) throw new TypeError('GolfAimController requires a Three camera');
  if(typeof getBallPosition !== 'function') throw new TypeError('getBallPosition must be a function');
  if(screenExitDeadzone >= screenDeadzone) throw new RangeError('screenExitDeadzone must be below screenDeadzone');
  if(mouseExitDeadzone >= mouseDeadzone) throw new RangeError('mouseExitDeadzone must be below mouseDeadzone');

  const view = canvas.ownerDocument?.defaultView || window;
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = new THREE.Vector2();
  const origin = new THREE.Vector3();
  const currentWorld = new THREE.Vector3();
  const delta = new THREE.Vector3();
  const target = new THREE.Vector3();
  const restTarget = new THREE.Vector3();
  let planeY = 0;

  const model = {
    active: false,
    targeting: false,
    engaged: false,
    valid: false,
    hasTarget: false,
    projectionValid: false,
    phase: 'rest',
    direction: 0,
    restDirection: 0,
    power: 0,
    distance: 0,
    rawDistance: 0,
    sequence: 0,
    sampleCount: 0,
    lastCancelReason: null,
    lastInvalidReason: null,
    lastResetReason: 'initial',
  };

  const thresholdPx = value => value <= 1
    ? Math.min(view.innerWidth, view.innerHeight) * value
    : value;

  function project(clientX, clientY, out){
    const rect = canvas.getBoundingClientRect();
    if(rect.width <= 0 || rect.height <= 0) return false;
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(plane, out) !== null;
  }

  function setRestTarget(direction = model.direction){
    restTarget.set(
      origin.x + Math.sin(direction) * restTargetDistance,
      planeY,
      origin.z + Math.cos(direction) * restTargetDistance,
    );
    target.copy(restTarget);
  }

  function clearAccepted({ phase, reason = null, display = 'rest' }){
    model.engaged = false;
    model.valid = false;
    model.hasTarget = false;
    model.projectionValid = false;
    model.power = 0;
    model.distance = 0;
    model.rawDistance = 0;
    model.direction = model.restDirection;
    model.phase = phase;
    model.lastInvalidReason = reason;
    if(display === 'rest') target.copy(restTarget);
  }

  function snapshot(){
    return {
      active: model.active,
      targeting: model.targeting,
      engaged: model.engaged,
      valid: model.valid,
      hasTarget: model.hasTarget,
      projectionValid: model.projectionValid,
      phase: model.phase,
      direction: model.direction,
      restDirection: model.restDirection,
      power: model.power,
      distance: model.distance,
      rawDistance: model.rawDistance,
      sequence: model.sequence,
      sampleCount: model.sampleCount,
      lastCancelReason: model.lastCancelReason,
      lastInvalidReason: model.lastInvalidReason,
      lastResetReason: model.lastResetReason,
      origin: copyVec(origin),
      target: copyVec(target),
      restTarget: copyVec(restTarget),
      currentWorld: copyVec(currentWorld),
      planeY,
      session: session.state,
    };
  }

  function finishActive(reason = null){
    model.active = false;
    model.targeting = false;
    if(reason) model.lastCancelReason = reason;
    clearAccepted({ phase: 'rest', display: 'rest' });
  }

  function reset({ direction = model.direction, reason = 'lie-reset' } = {}){
    session.cancel(reason);
    origin.copy(getBallPosition());
    planeY = origin.y - ballRadius + 0.04;
    model.direction = direction;
    model.restDirection = direction;
    model.sampleCount = 0;
    model.lastResetReason = reason;
    model.targeting = false;
    setRestTarget(direction);
    clearAccepted({ phase: 'rest', display: 'rest' });
    return snapshot();
  }

  function updateFromPointer(gestureState, event){
    if(!model.active) return false;
    model.sampleCount = gestureState.sampleCount;

    const isMouse = gestureState.pointerType === 'mouse';
    const enterPx = thresholdPx(isMouse ? mouseDeadzone : screenDeadzone);
    const exitPx = thresholdPx(isMouse ? mouseExitDeadzone : screenExitDeadzone);
    if(!model.targeting){
      if(gestureState.distance < enterPx){
        clearAccepted({ phase: 'tracking', reason: 'screen-deadzone', display: 'rest' });
        onUpdate(snapshot(), event);
        return false;
      }
      model.targeting = true;
    } else if(gestureState.distance <= exitPx){
      model.targeting = false;
      clearAccepted({ phase: 'tracking', reason: 'screen-deadzone', display: 'rest' });
      onUpdate(snapshot(), event);
      return false;
    }

    // A miss invalidates the complete accepted shot state immediately. The
    // release path calls this function again, so a stale target cannot fire.
    if(!project(event.clientX, event.clientY, currentWorld)){
      clearAccepted({ phase: 'invalid', reason: 'project-miss', display: 'rest' });
      onUpdate(snapshot(), event);
      return false;
    }

    delta.copy(currentWorld).sub(origin);
    delta.y = 0;
    const rawDistance = delta.length();
    if(rawDistance <= minTargetDistance){
      target.set(currentWorld.x, planeY, currentWorld.z);
      clearAccepted({ phase: 'invalid', reason: 'ball-near', display: 'current' });
      model.rawDistance = rawDistance;
      model.projectionValid = true;
      onUpdate(snapshot(), event);
      return false;
    }

    const distance = Math.min(rawDistance, maxTargetDistance);
    delta.multiplyScalar(distance / rawDistance);
    target.copy(origin).add(delta);
    target.y = planeY;
    model.direction = Math.atan2(delta.x, delta.z);
    model.power = targetPowerFromDistance(distance, minTargetDistance, maxTargetDistance);
    model.distance = distance;
    model.rawDistance = rawDistance;
    model.engaged = true;
    model.valid = model.power > 0;
    model.hasTarget = true;
    model.projectionValid = true;
    model.phase = 'targeting';
    model.lastInvalidReason = null;
    onUpdate(snapshot(), event);
    return model.valid;
  }

  const session = createGestureSession({
    target: canvas,
    deadzone: screenDeadzone,
    hysteresis: screenDeadzone - screenExitDeadzone,
    axisLock: false,
    preventDefault: true,
    onStart(gestureState, event){
      if(!canStart()){
        session.cancel('not-ready', event);
        return;
      }
      origin.copy(getBallPosition());
      planeY = origin.y - ballRadius + 0.04;
      plane.setFromNormalAndCoplanarPoint(
        plane.normal,
        currentWorld.set(origin.x, planeY, origin.z),
      );
      setRestTarget(model.restDirection);
      model.active = true;
      model.targeting = false;
      model.sequence = gestureState.sequence;
      model.sampleCount = gestureState.sampleCount;
      model.lastCancelReason = null;
      clearAccepted({ phase: 'tracking', reason: 'screen-deadzone', display: 'rest' });
      onBegin(snapshot(), event);
    },
    onMove: updateFromPointer,
    onEnd(gestureState, event){
      // Reproject and validate the actual release event. Never rely on the last
      // successful move, which may be stale after a horizon/plane miss.
      const finalValid = updateFromPointer(gestureState, event);
      const result = snapshot();
      const reason = model.lastInvalidReason || 'below-deadzone';
      const shouldRelease = model.active && model.targeting && finalValid && model.valid && model.hasTarget;
      finishActive(shouldRelease ? null : reason);
      if(shouldRelease) onRelease(result, event);
      else onAbort(reason, result, event);
    },
    onCancel(gestureState, event, reason){
      const result = snapshot();
      finishActive(reason);
      onAbort(reason, result, event);
    },
  });

  session.disable();

  return {
    enable: session.enable,
    disable: session.disable,
    cancel: session.cancel,
    dispose: session.dispose,
    reset,
    snapshot,
    get state(){ return snapshot(); },
    get target(){ return target; },
    get restTarget(){ return restTarget; },
    get direction(){ return model.direction; },
    get power(){ return model.power; },
    get active(){ return model.active; },
    get engaged(){ return model.engaged; },
    get valid(){ return model.valid; },
    get phase(){ return model.phase; },
  };
}
