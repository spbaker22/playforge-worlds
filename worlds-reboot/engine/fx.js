/* Playforge engine — particles (one draw call per system) + ribbon trails. */
import * as THREE from 'three';

const VERT = `
  attribute float aSize, aAlpha;
  attribute vec3 aCol;
  varying float vA; varying vec3 vC;
  void main(){
    vA = aAlpha; vC = aCol;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (240.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = `
  varying float vA; varying vec3 vC;
  void main(){
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    float a = smoothstep(0.5, 0.08, r) * vA;
    if(a < 0.01) discard;
    gl_FragColor = vec4(vC, a);
  }`;

export class Particles {
  constructor(scene, max, additive=false){
    this.max = max;
    this.pos = new Float32Array(max*3);
    this.vel = new Float32Array(max*3);
    this.life = new Float32Array(max);
    this.life0 = new Float32Array(max);
    this.size = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.col = new Float32Array(max*3);
    this.grav = new Float32Array(max);
    this.head = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col, 3));
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    this.mesh = new THREE.Points(g, m);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  emit(x,y,z, vx,vy,vz, {life=0.8, size=1.4, grow=1.6, alpha=0.5, col=[0.8,0.7,0.6], grav=0}={}){
    const i = this.head = (this.head+1) % this.max;
    this.pos[i*3]=x; this.pos[i*3+1]=y; this.pos[i*3+2]=z;
    this.vel[i*3]=vx; this.vel[i*3+1]=vy; this.vel[i*3+2]=vz;
    this.life[i]=this.life0[i]=life;
    this.size[i]=size; this.grow[i]=grow;
    this.alpha[i]=this.a0[i]=alpha;
    this.col[i*3]=col[0]; this.col[i*3+1]=col[1]; this.col[i*3+2]=col[2];
    this.grav[i]=grav;
  }
  tick(dt){
    const {pos, vel, life, life0, size, grow, alpha, a0, grav, max} = this;
    for(let i=0;i<max;i++){
      if(life[i]<=0){ alpha[i]=0; continue; }
      life[i]-=dt;
      const t = Math.max(life[i],0)/life0[i];
      pos[i*3]+=vel[i*3]*dt; pos[i*3+1]+=vel[i*3+1]*dt; pos[i*3+2]+=vel[i*3+2]*dt;
      vel[i*3+1]-=grav[i]*dt;
      vel[i*3]*=(1-dt*1.4); vel[i*3+2]*=(1-dt*1.4);
      size[i]+=grow[i]*dt;
      alpha[i]=a0[i]*t;
    }
    this.mesh.geometry.attributes.position.needsUpdate=true;
    this.mesh.geometry.attributes.aSize.needsUpdate=true;
    this.mesh.geometry.attributes.aAlpha.needsUpdate=true;
    this.mesh.geometry.attributes.aCol.needsUpdate=true;
  }
}

export class SkidRibbon {
  constructor(scene, maxSeg=160, width=0.30, color=0x18141C, opacity=0.42){
    this.max=maxSeg; this.w=width; this.n=0; this.head=0;
    this.last=new THREE.Vector3(); this.has=false;
    const g=new THREE.BufferGeometry();
    this.pos=new Float32Array(maxSeg*2*3*2); /* 2 tris per seg = 4 verts strip-ish (we use 6) */
    this.posArr=new Float32Array(maxSeg*6*3);
    g.setAttribute('position', new THREE.BufferAttribute(this.posArr,3));
    this.geo=g;
    const m=new THREE.MeshBasicMaterial({color, transparent:true, opacity, depthWrite:false,
      polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2});
    this.mesh=new THREE.Mesh(g,m);
    this.mesh.frustumCulled=false;
    scene.add(this.mesh);
  }
  add(p, right){
    if(this.has && this.last.distanceToSquared(p) < 0.35) return;
    if(!this.has){ this.last.copy(p); this.has=true; return; }
    const a=this.last, b=p, w=this.w;
    const i=this.head=(this.head+1)%this.max;
    const o=i*18;
    const ax1=a.x-right.x*w, az1=a.z-right.z*w, ax2=a.x+right.x*w, az2=a.z+right.z*w;
    const bx1=b.x-right.x*w, bz1=b.z-right.z*w, bx2=b.x+right.x*w, bz2=b.z+right.z*w;
    const ay=a.y+0.07, by=b.y+0.07;
    const P=this.posArr;
    P[o]=ax1;P[o+1]=ay;P[o+2]=az1; P[o+3]=ax2;P[o+4]=ay;P[o+5]=az2; P[o+6]=bx1;P[o+7]=by;P[o+8]=bz1;
    P[o+9]=ax2;P[o+10]=ay;P[o+11]=az2; P[o+12]=bx2;P[o+13]=by;P[o+14]=bz2; P[o+15]=bx1;P[o+16]=by;P[o+17]=bz1;
    this.geo.attributes.position.needsUpdate=true;
    this.last.copy(p);
  }
  break_(){ this.has=false; }
}
