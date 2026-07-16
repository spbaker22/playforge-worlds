/* Playforge engine — renderer + HDR composer + grade pass + quality governor.
   The pinned pipeline: ACES filmic, MSAA HalfFloat target, UnrealBloom,
   vignette/grain/speed-CA grade, pixel-ratio governor for iPads. */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export function createPipeline({
  canvas, lowfx = false,
  exposure = 1.08,
  bloom = { strength: 0.34, radius: 0.55, threshold: 0.85 },
  vignette = 0.34,
  grain = 0.028,
  fov = 60, near = 0.2, far = 9000,
  clear = 0x000000
} = {}){
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  let PR = lowfx ? 1 : Math.min(window.devicePixelRatio || 1, 1.6);
  renderer.setPixelRatio(PR);
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(clear);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, near, far);

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(
    innerWidth, innerHeight, { samples: lowfx ? 0 : 4, type: THREE.HalfFloatType }));
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight),
    bloom.strength, bloom.radius, bloom.threshold);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uCA: { value: 0 }, uVig: { value: vignette }, uGrain: { value: grain } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uTime, uCA, uVig, uGrain;
      varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      void main(){
        vec2 c = vUv - 0.5;
        float r2 = dot(c,c);
        vec2 off = c * r2 * uCA * 0.012; /* CA stays in UV units, capped by callers */
        vec3 col;
        col.r = texture2D(tDiffuse, vUv + off).r;
        col.g = texture2D(tDiffuse, vUv).g;
        col.b = texture2D(tDiffuse, vUv - off).b;
        col = col * (1.0 - uVig * smoothstep(0.18, 0.62, r2));
        col += (hash(vUv * vec2(1920.0,1080.0) + uTime) - 0.5) * uGrain;
        gl_FragColor = vec4(col, 1.0);
      }`
  });
  composer.addPass(grade);

  /* quality governor: step PR down, then drop bloom — iPads must never chug */
  let fpsAcc = 0, fpsN = 0;
  function govern(dt){
    fpsAcc += dt; fpsN++;
    if(fpsAcc >= 1){
      const fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
      if(fps < 33 && PR > 1.0){
        PR = Math.max(1.0, PR - 0.25);
        renderer.setPixelRatio(PR);
        composer.setPixelRatio(PR);
      } else if(fps < 26 && bloomPass.enabled){ bloomPass.enabled = false; }
    }
  }

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  return { renderer, scene, camera, composer, bloom: bloomPass, grade, govern, get PR(){ return PR; } };
}
