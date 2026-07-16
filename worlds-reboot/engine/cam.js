/* Playforge engine — cinematic camera kit: spring chase w/ velocity
   feed-forward, handheld sway, impact shake, FOV spring, orbit helper. */
import * as THREE from 'three';

export class SpringCam {
  constructor(camera, { k = 9, lookK = 11, ffPos = 0.115, ffLook = 0.05, baseFov = 58 } = {}){
    this.cam = camera;
    this.k = k; this.lookK = lookK;
    this.ffPos = ffPos; this.ffLook = ffLook;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.fov = baseFov;
    this.baseFov = baseFov;
    this.shake = 0;
    this._t = new THREE.Vector3();
    this._l = new THREE.Vector3();
  }
  snap(pos, look){ this.pos.copy(pos); this.look.copy(look); this.cam.position.copy(pos); this.cam.lookAt(look); }
  addShake(a){ this.shake = Math.min(1, this.shake + a); }
  /* targetPos/targetLook: Vector3s. vel: Vector3 world velocity (feed-forward). */
  tick(dt, targetPos, targetLook, vel, { sway = 0, fovTarget = null, fovK = 4.5 } = {}){
    this._t.copy(targetPos).addScaledVector(vel, this.ffPos);
    this._l.copy(targetLook).addScaledVector(vel, this.ffLook);
    this.pos.lerp(this._t, 1 - Math.exp(-this.k * dt));
    this.look.lerp(this._l, 1 - Math.exp(-this.lookK * dt));
    this.cam.position.copy(this.pos);
    if(sway > 0){
      const t = performance.now() / 1000;
      this.cam.position.x += Math.sin(t * 1.35) * sway + Math.sin(t * 3.1) * sway * 0.4;
      this.cam.position.y += Math.sin(t * 1.05) * sway * 0.7;
    }
    if(this.shake > 0){
      this.cam.position.x += (Math.random() - .5) * this.shake * 1.5;
      this.cam.position.y += (Math.random() - .5) * this.shake * 1.1;
      this.shake *= Math.exp(-5.5 * dt);
    }
    this.cam.lookAt(this.look);
    if(fovTarget !== null){
      this.fov += (fovTarget - this.fov) * Math.min(1, dt * fovK);
      this.cam.fov = this.fov;
      this.cam.updateProjectionMatrix();
    }
  }
}

export function orbit(camera, center, t, { r = 10, h = 3, speed = 0.12, lookY = 0.8, rise = 0 } = {}){
  camera.position.set(
    center.x + Math.sin(t * speed) * r,
    center.y + h + t * rise,
    center.z + Math.cos(t * speed) * r);
  camera.lookAt(center.x, center.y + lookY, center.z);
  camera.updateProjectionMatrix();
}
