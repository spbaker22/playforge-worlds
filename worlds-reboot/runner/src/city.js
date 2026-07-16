/* Gridlock Run Phase 4 — production presentation on the verified Phase 3
   geometry contract. Every placement still resolves through RunnerCourseModel. */
import * as THREE from 'three';
import { canvasTex, mulberry, clamp } from '../../engine/util.js';
import { buildDistricts, tickDistricts } from './districts.js';

export const PAL = {
  zenith: 0x07101F, violet: 0x282052, horizon: 0x71416E, sunHot: 0xFFB8DB,
  fog: 0x211A38,
  deck: 0x101521, deckLit: 0x263149,
  cyan: 0x2EE6FF, magenta: 0xFF3EC8, gold: 0xFFC24B, orange: 0xFF5C29,
  tower: 0x0E1425, window: 0xFFD9A0, pale: 0xA7B6C8, mint: 0x74F4D1,
};

export const DECK_HW = 4.65;
export const ALIGNMENT_TOLERANCE = 2e-5;

const unitBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
const hazardBumperGeometry = new THREE.CylinderGeometry(0.075, 0.075, 0.76, 8);
const gateFaceGeometry = new THREE.PlaneGeometry(DECK_HW * 1.88, 1.55);

const v3 = value => value?.isVector3
  ? value.clone()
  : new THREE.Vector3(value?.x || 0, value?.y || 0, value?.z || 0);

function coursePose(course, s, lane = 0){
  const raw = course.poseAt(s, lane);
  return {
    ...raw,
    pos: v3(raw.pos || raw.position),
    tan: v3(raw.tan || raw.tangent).normalize(),
    right: v3(raw.right).normalize(),
  };
}

function deckTexture(){
  const texture = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#131b29';
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(70,88,120,.12)';
    g.fillRect(w * 0.18, 0, w * 0.64, h);
    const random = mulberry(31072026);
    for(let i = 0; i < 760; i++){
      const c = 34 + (random() * 28 | 0);
      g.fillStyle = `rgba(${c},${c + 6},${c + 18},.30)`;
      g.fillRect(random() * w, random() * h, 1.5, 1.5);
    }
    for(let i = 0; i < 18; i++){
      const x = random() * w;
      g.fillStyle = `rgba(120,155,230,${0.025 + random() * 0.04})`;
      g.fillRect(x, 0, 2 + random() * 5, h);
    }
    g.fillStyle = '#31dff3';
    g.fillRect(5, 0, 6, h);
    g.fillStyle = '#f044bd';
    g.fillRect(w - 11, 0, 6, h);
    g.setLineDash([32, 24]);
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(225,235,255,.30)';
    for(const x of [w / 3, w * 2 / 3]){
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
    g.setLineDash([]);
    for(let y = 0; y < h; y += 96){
      g.fillStyle = 'rgba(112,146,190,.10)';
      g.fillRect(0, y, w, 2);
    }
    // Broad wet patches and regular drain grates break the deck into readable
    // service panels without introducing another runtime texture.
    g.fillStyle = 'rgba(142,190,235,.075)';
    for(let y = 34; y < h; y += 128){
      g.beginPath();
      g.ellipse(w * 0.52 + Math.sin(y) * 74, y, 104, 18, -0.08, 0, Math.PI * 2);
      g.fill();
    }
    for(let y = 72; y < h; y += 144){
      for(const x of [30, w - 58]){
        g.fillStyle = 'rgba(3,8,18,.72)';
        g.fillRect(x, y, 28, 10);
        g.fillStyle = 'rgba(108,168,208,.26)';
        for(let slot = 3; slot < 27; slot += 6) g.fillRect(x + slot, y + 2, 2, 6);
      }
    }
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function bannerTexture(text, sub, color = '#2ee6ff'){
  return canvasTex(1024, 192, (g, w, h) => {
    g.fillStyle = '#100c20';
    g.fillRect(0, 0, w, h);
    g.fillStyle = color;
    g.fillRect(0, 0, w, 9);
    g.fillRect(0, h - 9, w, 9);
    g.font = '800 78px -apple-system,Helvetica,Arial';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#f2f6ff';
    g.shadowColor = color;
    g.shadowBlur = 16;
    g.fillText(text, w / 2, h / 2 - (sub ? 16 : 0));
    if(sub){
      g.shadowBlur = 0;
      g.fillStyle = color;
      g.font = '700 28px -apple-system,Helvetica,Arial';
      g.fillText(sub, w / 2, h / 2 + 54);
    }
  });
}

const basicMaterialCache = new Map();
function sharedBasic(color, opacity = 1){
  const key = `${color}:${opacity}`;
  if(!basicMaterialCache.has(key)){
    basicMaterialCache.set(key, new THREE.MeshBasicMaterial({
      color, transparent: opacity < 1, opacity,
    }));
  }
  return basicMaterialCache.get(key);
}

const productionHazardMaterial = new THREE.MeshStandardMaterial({
  color: 0x253048, roughness: 0.32, metalness: 0.7,
  emissive: 0x10182A, emissiveIntensity: 0.42, side: THREE.FrontSide,
});
const productionPylonMaterial = new THREE.MeshStandardMaterial({
  color: 0x171F32, roughness: 0.38, metalness: 0.72,
  emissive: 0x0C1325, emissiveIntensity: 0.35,
});

function hazardData(course){
  if(!Array.isArray(course.hazards)) throw new TypeError('RunnerCourseModel must expose authored hazards');
  return course.hazards;
}

function checkpointData(course){
  if(!Array.isArray(course.checkpoints)) throw new TypeError('RunnerCourseModel must expose authored checkpoints');
  return course.checkpoints;
}

function fullWidthGaps(hazards){
  return hazards.filter(hazard => hazard.kind === 'gap' && (!hazard.lanes || hazard.lanes.length >= 3));
}

function makeRibbon(course, a, b, material){
  const positions = [], normals = [], uvs = [], indices = [];
  const steps = Math.max(2, Math.ceil((b - a) / 1.5));
  for(let i = 0; i <= steps; i++){
    const s = a + (b - a) * i / steps;
    const pose = coursePose(course, s);
    const left = pose.pos.clone().addScaledVector(pose.right, -DECK_HW);
    const right = pose.pos.clone().addScaledVector(pose.right, DECK_HW);
    positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(0, s / 8, 1, s / 8);
    if(i < steps){
      const k = i * 2;
      indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `deck-ribbon:${a.toFixed(3)}-${b.toFixed(3)}`;
  mesh.receiveShadow = true;
  return {
    mesh,
    start: { owner: mesh, leftIndex: 0, rightIndex: 1, courseS: a },
    end: { owner: mesh, leftIndex: steps * 2, rightIndex: steps * 2 + 1, courseS: b },
  };
}

function placeGroup(course, group, s, lane = 0, y = 0){
  const pose = coursePose(course, s, lane);
  group.position.copy(pose.pos);
  group.position.y += y;
  group.rotation.y = Math.atan2(pose.tan.x, pose.tan.z);
  return pose;
}

function placeChildFromCourse(course, parent, object, s, lane = 0, y = 0){
  const pose = coursePose(course, s, lane);
  const world = pose.pos.clone();
  world.y += y;
  parent.updateMatrixWorld(true);
  object.position.copy(parent.worldToLocal(world));
  object.rotation.y = Math.atan2(pose.tan.x, pose.tan.z) - parent.rotation.y;
  return pose;
}

function deckBoundaryObservation(boundary, course, lane){
  return out => {
    const positions = boundary.owner.geometry.getAttribute('position');
    const mix = clamp((lane * course.laneSpacing + DECK_HW) / (DECK_HW * 2), 0, 1);
    out.set(
      positions.getX(boundary.leftIndex) + (positions.getX(boundary.rightIndex) - positions.getX(boundary.leftIndex)) * mix,
      positions.getY(boundary.leftIndex) + (positions.getY(boundary.rightIndex) - positions.getY(boundary.leftIndex)) * mix,
      positions.getZ(boundary.leftIndex) + (positions.getZ(boundary.rightIndex) - positions.getZ(boundary.leftIndex)) * mix,
    );
    return out.applyMatrix4(boundary.owner.matrixWorld);
  };
}

function geometryVerticesObservation(owner, vertexIndices){
  return out => {
    owner.updateWorldMatrix(true, false);
    const positions = owner.geometry.getAttribute('position');
    out.set(0, 0, 0);
    for(let index = 0; index < vertexIndices.length; index += 1){
      const vertexIndex = vertexIndices[index];
      out.x += positions.getX(vertexIndex);
      out.y += positions.getY(vertexIndex);
      out.z += positions.getZ(vertexIndex);
    }
    out.multiplyScalar(1 / vertexIndices.length);
    return out.applyMatrix4(owner.matrixWorld);
  };
}

function pushLocalVertex(positions, parent, world){
  const local = parent.worldToLocal(world.clone());
  positions.push(local.x, local.y, local.z);
  return positions.length / 3 - 1;
}

function createBlockerBody(course, group, hazard, lane, material, bodyBoundaries, hazardBodies){
  const width = 2.25;
  const height = 0.8;
  const positions = [];
  const edgeIndices = {};
  group.updateWorldMatrix(true, false);
  for(const [part, courseS] of [['start', hazard.s0], ['end', hazard.s1]]){
    const pose = coursePose(course, courseS, lane);
    const left = pose.pos.clone().addScaledVector(pose.right, -width / 2);
    const right = pose.pos.clone().addScaledVector(pose.right, width / 2);
    const leftBottom = pushLocalVertex(positions, group, left);
    const rightBottom = pushLocalVertex(positions, group, right);
    const leftTop = pushLocalVertex(positions, group, left.clone().setY(left.y + height));
    const rightTop = pushLocalVertex(positions, group, right.clone().setY(right.y + height));
    edgeIndices[part] = [leftBottom, rightBottom];
    edgeIndices[`${part}Top`] = [leftTop, rightTop];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([
    0, 1, 4, 1, 5, 4,
    2, 6, 3, 3, 6, 7,
    0, 4, 2, 2, 4, 6,
    1, 3, 5, 3, 7, 5,
    0, 2, 1, 1, 2, 3,
    4, 5, 6, 5, 7, 6,
  ]);
  geometry.computeVertexNormals();
  const body = new THREE.Mesh(geometry, material);
  body.name = `hazard-body:${hazard.id}:lane:${lane}`;
  body.userData.hazardId = hazard.id;
  body.userData.lane = lane;
  body.castShadow = true;
  group.add(body);
  hazardBodies.set(`${hazard.id}:lane:${lane}`, body);
  for(const part of ['start', 'end']){
    const key = `hazard:${hazard.id}:${part}:lane:${lane}`;
    bodyBoundaries.set(key, {
      owner: body,
      observe: geometryVerticesObservation(body, edgeIndices[part]),
      observationSource: 'hazard-body-geometry-edge',
      vertexIndices: edgeIndices[part],
    });
  }
  return body;
}

function createOverheadBody(course, group, hazard, material, bodyBoundaries, hazardBodies){
  const bottomY = hazard.boundaryHeight ?? 1.58;
  const height = 1.12;
  const panelHalfWidth = DECK_HW * 1.85 / 2;
  const laterals = [-panelHalfWidth, ...hazard.lanes.map(lane => lane * course.laneSpacing), panelHalfWidth]
    .sort((a, b) => a - b)
    .filter((value, index, values) => index === 0 || Math.abs(value - values[index - 1]) > 1e-9);
  const positions = [];
  const boundaryIndices = new Map();
  group.updateWorldMatrix(true, false);
  for(const [part, courseS] of [['start', hazard.s0], ['end', hazard.s1]]){
    const pose = coursePose(course, courseS, 0);
    for(let lateralIndex = 0; lateralIndex < laterals.length; lateralIndex += 1){
      const lateral = laterals[lateralIndex];
      const bottom = pose.pos.clone().addScaledVector(pose.right, lateral);
      bottom.y += bottomY;
      const bottomIndex = pushLocalVertex(positions, group, bottom);
      pushLocalVertex(positions, group, bottom.clone().setY(bottom.y + height));
      const lane = hazard.lanes.find(candidate => Math.abs(candidate * course.laneSpacing - lateral) <= 1e-9);
      if(lane !== undefined) boundaryIndices.set(`${part}:${lane}`, bottomIndex);
    }
  }
  const widthCount = laterals.length;
  const endBase = widthCount * 2;
  const indices = [];
  for(let lateralIndex = 0; lateralIndex < widthCount - 1; lateralIndex += 1){
    const s0 = lateralIndex * 2;
    const s1 = (lateralIndex + 1) * 2;
    const e0 = endBase + lateralIndex * 2;
    const e1 = endBase + (lateralIndex + 1) * 2;
    indices.push(
      s0, s1, e0, s1, e1, e0,
      s0 + 1, e0 + 1, s1 + 1, s1 + 1, e0 + 1, e1 + 1,
      s0, s0 + 1, s1, s1, s0 + 1, s1 + 1,
      e0, e1, e0 + 1, e1, e1 + 1, e0 + 1,
    );
  }
  const startLeft = 0, startRight = (widthCount - 1) * 2;
  const endLeft = endBase, endRight = endBase + (widthCount - 1) * 2;
  indices.push(
    startLeft, endLeft, startLeft + 1, startLeft + 1, endLeft, endLeft + 1,
    startRight, startRight + 1, endRight, startRight + 1, endRight + 1, endRight,
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const body = new THREE.Mesh(geometry, material);
  body.name = `hazard-body:${hazard.id}:gate`;
  body.userData.hazardId = hazard.id;
  body.userData.lanes = [...hazard.lanes];
  body.castShadow = true;
  group.add(body);
  hazardBodies.set(`${hazard.id}:gate`, body);
  for(const lane of hazard.lanes){
    for(const part of ['start', 'end']){
      const vertexIndex = boundaryIndices.get(`${part}:${lane}`);
      const key = `hazard:${hazard.id}:${part}:lane:${lane}`;
      bodyBoundaries.set(key, {
        owner: body,
        observe: geometryVerticesObservation(body, [vertexIndex]),
        observationSource: 'hazard-body-geometry-vertex',
        vertexIndices: [vertexIndex],
      });
    }
  }
  return body;
}

function addGate(parent, course, s, text, sub, color, semanticGates, { lightweight = false } = {}){
  const gate = new THREE.Group();
  placeGroup(course, gate, s);
  const metal = productionPylonMaterial;
  const pylons = new THREE.InstancedMesh(unitBoxGeometry, metal, 2);
  pylons.name = `gate:${text}:pylons`;
  const pylonDummy = new THREE.Object3D();
  for(let index = 0; index < 2; index += 1){
    const side = index === 0 ? -1 : 1;
    pylonDummy.position.set(side * (DECK_HW + 0.4), 2.9, 0);
    pylonDummy.scale.set(0.62, 5.8, 0.62);
    pylonDummy.updateMatrix();
    pylons.setMatrixAt(index, pylonDummy.matrix);
  }
  pylons.visible = !lightweight;
  gate.add(pylons);
  const texture = bannerTexture(text, sub, color);
  const faceMaterial = new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide });
  const approachFace = new THREE.Mesh(
    gateFaceGeometry,
    faceMaterial,
  );
  // PlaneGeometry faces local +Z. Runners approach along the course tangent,
  // so the readable face must point back down-course (-Z in gate space).
  approachFace.position.set(0, 4.65, -0.02);
  approachFace.rotation.y = Math.PI;
  approachFace.name = `gate:${text}:approach-face`;
  gate.add(approachFace);
  const rearFace = new THREE.Mesh(
    gateFaceGeometry,
    faceMaterial,
  );
  rearFace.position.set(0, 4.65, 0.02);
  rearFace.name = `gate:${text}:rear-face`;
  rearFace.visible = !lightweight;
  gate.add(rearFace);
  parent.add(gate);
  semanticGates.push({ id: text === 'TRAINING CLEAR' ? 'finish' : 'start', s, gate, approachFace, rearFace });
  return gate;
}

function addWarning(parent, course, hazard, semanticWarnings, warningVisuals){
  const cueStart = hazard.cueStart ?? Math.max(0, hazard.s0 - 9);
  const end = Math.max(cueStart + 0.5, hazard.s0 - 0.7);
  const color = hazard.action === 'slide' ? PAL.magenta
    : hazard.action === 'lane-right' || hazard.kind === 'lane-gate' ? PAL.gold
      : PAL.orange;
  const width = Math.min(1.55, course.laneSpacing * 0.72);
  for(const lane of hazard.lanes){
    for(let s = cueStart; s <= end; s += 2.2){
      const marker = new THREE.Object3D();
      placeChildFromCourse(course, parent, marker, s, lane, 0.035);
      marker.name = `warning:${hazard.id}:lane:${lane}:${s.toFixed(2)}`;
      marker.userData.hazardId = hazard.id;
      marker.userData.lane = lane;
      marker.userData.courseS = s;
      marker.userData.semanticWidth = width;
      parent.add(marker);
      semanticWarnings.push({ hazardId: hazard.id, lane, courseS: s, width, object: marker, owner: parent });
      warningVisuals.push({ color, opacity: 0.72, courseS: s, lane, y: 0.035, width, depth: 0.28 });
    }
  }
}

function addBoundaryAnchors(parent, course, hazard, visualAnchors, semanticAnchors, deckBoundaries, bodyBoundaries, anchorVisuals){
  const parts = [
    ['cue', hazard.cueStart, PAL.gold],
    ['start', hazard.s0, PAL.orange],
    ['end', hazard.s1, PAL.magenta],
    ['landing', hazard.landingEnd, PAL.cyan],
  ];
  const width = Math.min(1.72, course.laneSpacing * 0.76);
  for(const lane of hazard.lanes){
    for(const [part, courseS, color] of parts){
      const key = `hazard:${hazard.id}:${part}:lane:${lane}`;
      const bodyBoundary = bodyBoundaries.get(key) || null;
      const marker = new THREE.Object3D();
      placeChildFromCourse(course, parent, marker, courseS, lane,
        bodyBoundary && (part === 'start' || part === 'end') ? hazard.boundaryHeight ?? 0 : 0);
      marker.name = key;
      marker.userData.anchorKey = key;
      marker.userData.courseS = courseS;
      marker.userData.lane = lane;
      marker.userData.part = part;
      parent.add(marker);
      const deckBoundary = hazard.kind === 'gap' && (part === 'start' || part === 'end')
        ? deckBoundaries.get(courseS)
        : null;
      const entry = {
        key,
        kind: 'hazard',
        sourceId: hazard.id,
        part,
        courseS,
        lane,
        object: marker,
        owner: deckBoundary?.owner || bodyBoundary?.owner || parent,
        observe: deckBoundary
          ? deckBoundaryObservation(deckBoundary, course, lane)
          : bodyBoundary?.observe || null,
        observationSource: deckBoundary ? 'deck-boundary-vertices'
          : bodyBoundary ? bodyBoundary.observationSource
          : part === 'cue' ? 'hazard-warning-group'
            : part === 'landing' ? 'hazard-landing-group' : 'hazard-body-group',
        vertexIndices: deckBoundary
          ? [deckBoundary.leftIndex, deckBoundary.rightIndex]
          : bodyBoundary?.vertexIndices,
        width,
      };
      visualAnchors.set(key, entry);
      semanticAnchors.push(entry);
      anchorVisuals.push({
        color, opacity: 0.72,
        courseS, lane, y: 0.048, width,
        depth: part === 'start' || part === 'end' ? 0.18 : 0.12,
      });
    }
  }
}

function addHazardVisual(
  parent, course, hazard, visualAnchors, semanticAnchors, semanticWarnings,
  deckBoundaries, bodyBoundaries, hazardGroups, hazardBodies, warningVisuals, anchorVisuals,
){
  const mid = (hazard.s0 + hazard.s1) / 2;
  const lanes = hazard.lanes?.length ? hazard.lanes : [0];
  const group = new THREE.Group();
  placeGroup(course, group, mid);
  group.name = `hazard:${hazard.id}`;
  group.userData.courseS = mid;
  group.userData.hazardId = hazard.id;

  const dark = productionHazardMaterial;
  const orange = sharedBasic(PAL.orange);
  const magenta = sharedBasic(PAL.magenta);

  if(hazard.kind === 'bar' || hazard.kind === 'barrier' || hazard.kind === 'blocker' || hazard.kind === 'lane-gate'){
    for(const lane of lanes){
      const laneOffset = course.poseAt(mid, lane).lateral ?? lane * 2.75;
      createBlockerBody(course, group, hazard, lane, dark, bodyBoundaries, hazardBodies);
      const strip = new THREE.Mesh(unitBoxGeometry, orange);
      strip.name = `hazard-accent:${hazard.id}:lane:${lane}`;
      strip.position.set(laneOffset, 0.88, 0);
      strip.scale.set(2.28, 0.12, Math.max(0.64, hazard.s1 - hazard.s0 + 0.04));
      group.add(strip);
      for(const side of [-1, 1]){
        const bumper = new THREE.Mesh(hazardBumperGeometry, sharedBasic(PAL.gold));
        bumper.name = `hazard-bumper:${hazard.id}:lane:${lane}:${side}`;
        bumper.position.set(laneOffset + side * 0.92, 0.42, -(hazard.s1 - hazard.s0) * 0.48);
        group.add(bumper);
      }
    }
  } else if(hazard.kind === 'sign' || hazard.kind === 'slide' || hazard.kind === 'overhead'){
    const supports = new THREE.InstancedMesh(unitBoxGeometry, productionPylonMaterial, 2);
    supports.name = `hazard-supports:${hazard.id}`;
    const supportDummy = new THREE.Object3D();
    for(let index = 0; index < 2; index += 1){
      supportDummy.position.set((index ? 1 : -1) * (DECK_HW - 0.22), 1.65, 0);
      supportDummy.scale.set(0.35, 3.3, 0.35);
      supportDummy.updateMatrix();
      supports.setMatrixAt(index, supportDummy.matrix);
    }
    group.add(supports);
    createOverheadBody(course, group, hazard, dark, bodyBoundaries, hazardBodies);
    const span = Math.max(0.5, hazard.s1 - hazard.s0 + 0.02);
    const clearance = new THREE.InstancedMesh(unitBoxGeometry, magenta, 3);
    clearance.name = `hazard-accent:${hazard.id}:continuous-clearance`;
    const clearanceDummy = new THREE.Object3D();
    const clearanceParts = [
      [0, 1.535, 0, DECK_HW * 1.80, 0.13, span],
      [0, 1.58, -span * 0.49, DECK_HW * 1.86, 0.22, 0.12],
      [0, 1.58, span * 0.49, DECK_HW * 1.86, 0.16, 0.10],
    ];
    for(let index = 0; index < clearanceParts.length; index += 1){
      const [x, y, z, sx, sy, sz] = clearanceParts[index];
      clearanceDummy.position.set(x, y, z);
      clearanceDummy.scale.set(sx, sy, sz);
      clearanceDummy.updateMatrix();
      clearance.setMatrixAt(index, clearanceDummy.matrix);
    }
    group.add(clearance);
  }

  parent.add(group);
  hazardGroups.set(hazard.id, group);
  addBoundaryAnchors(group, course, hazard, visualAnchors, semanticAnchors, deckBoundaries, bodyBoundaries, anchorVisuals);
  addWarning(group, course, hazard, semanticWarnings, warningVisuals);
  return group;
}

const stripUnitGeometry = new THREE.BoxGeometry(1, 0.025, 1);
function addStripBatches(parent, course, entries, prefix){
  const buckets = new Map();
  for(const entry of entries){
    const key = `${entry.color}:${entry.opacity}`;
    if(!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  const dummy = new THREE.Object3D();
  let batchIndex = 0;
  for(const bucket of buckets.values()){
    const first = bucket[0];
    const batch = new THREE.InstancedMesh(stripUnitGeometry, sharedBasic(first.color, first.opacity), bucket.length);
    batch.name = `${prefix}:${batchIndex}`;
    for(let index = 0; index < bucket.length; index += 1){
      const entry = bucket[index];
      const pose = coursePose(course, entry.courseS, entry.lane);
      dummy.position.copy(pose.pos);
      dummy.position.y += entry.y;
      dummy.rotation.set(0, Math.atan2(pose.tan.x, pose.tan.z), 0);
      dummy.scale.set(entry.width, 1, entry.depth);
      dummy.updateMatrix();
      batch.setMatrixAt(index, dummy.matrix);
    }
    batch.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    batch.computeBoundingSphere?.();
    parent.add(batch);
    batchIndex += 1;
  }
  return batchIndex;
}

function addBackground(parent, course, lowfx){
  const random = mulberry(20260715);
  const count = lowfx ? 42 : 96;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const warm = new THREE.MeshStandardMaterial({ color: 0x2b2940, roughness: 0.72, metalness: 0.24, emissive: 0x4b3028, emissiveIntensity: 0.28 });
  const cool = new THREE.MeshStandardMaterial({ color: 0x242a44, roughness: 0.72, metalness: 0.24, emissive: 0x183e52, emissiveIntensity: 0.3 });
  const warmMesh = new THREE.InstancedMesh(geometry, warm, count);
  const coolMesh = new THREE.InstancedMesh(geometry, cool, count);
  const dummy = new THREE.Object3D();
  let wi = 0, ci = 0;
  for(let i = 0; i < count * 2; i++){
    const s = random() * course.length;
    const pose = coursePose(course, s);
    const side = random() < 0.5 ? -1 : 1;
    const offset = 16 + random() * 35;
    const width = 5 + random() * 9;
    const depth = 5 + random() * 10;
    const height = 14 + random() * 50;
    dummy.position.copy(pose.pos).addScaledVector(pose.right, side * offset);
    dummy.position.y = height / 2 - 3;
    dummy.scale.set(width, height, depth);
    dummy.rotation.y = random() * 0.5 - 0.25;
    dummy.updateMatrix();
    if(random() < 0.5){
      if(wi < count) warmMesh.setMatrixAt(wi++, dummy.matrix);
    } else if(ci < count) coolMesh.setMatrixAt(ci++, dummy.matrix);
  }
  warmMesh.count = wi;
  coolMesh.count = ci;
  parent.add(warmMesh, coolMesh);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1100, 1100).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x0a0814, roughness: 0.92, metalness: 0.08, emissive: 0x24152f, emissiveIntensity: 0.22 }),
  );
  ground.position.y = -3;
  parent.add(ground);
}

/** Build production presentation without weakening the Phase 3 geometry gate. */
export function buildCity(scene, course, { lowfx = false } = {}){
  if(!course?.poseAt) throw new TypeError('buildCity requires RunnerCourseModel');
  const group = new THREE.Group();
  group.name = 'runner-phase4-city';
  scene.add(group);
  const hazards = hazardData(course);
  const gaps = fullWidthGaps(hazards).sort((a, b) => a.s0 - b.s0);
  const deckMaterial = new THREE.MeshPhysicalMaterial({
    map: deckTexture(), color: 0x8795AA, roughness: 0.31, metalness: 0.58,
    clearcoat: 0.32, clearcoatRoughness: 0.24,
    envMapIntensity: 1.25, side: THREE.DoubleSide,
  });
  const deckBoundaries = new Map();
  const deckRibbons = [];
  function addRibbonSegment(a, b){
    const ribbon = makeRibbon(course, a, b, deckMaterial);
    group.add(ribbon.mesh);
    deckRibbons.push(ribbon.mesh);
    deckBoundaries.set(a, ribbon.start);
    deckBoundaries.set(b, ribbon.end);
  }
  let stretchStart = 0;
  for(const gap of gaps){
    if(gap.s0 - stretchStart > 0.25) addRibbonSegment(stretchStart, gap.s0);
    stretchStart = gap.s1;
  }
  if(course.length - stretchStart > 0.25) addRibbonSegment(stretchStart, course.length);

  const visualAnchors = new Map();
  const hazardGroups = new Map();
  const hazardBodies = new Map();
  const bodyBoundaries = new Map();
  const semanticAnchors = [];
  const semanticWarnings = [];
  const warningVisuals = [];
  const anchorVisuals = [];
  const semanticCheckpoints = [];
  const semanticSafePads = [];
  const semanticGates = [];
  for(const hazard of hazards){
    addHazardVisual(
      group, course, hazard, visualAnchors, semanticAnchors,
      semanticWarnings, deckBoundaries, bodyBoundaries, hazardGroups, hazardBodies,
      warningVisuals, anchorVisuals,
    );
  }
  const warningBatchCount = addStripBatches(group, course, warningVisuals, 'warning-batch');
  const anchorBatchCount = addStripBatches(group, course, anchorVisuals, 'anchor-batch');

  const checkpointVisuals = [];
  for(const checkpoint of checkpointData(course)){
    const key = `checkpoint:${checkpoint.id}`;
    const pad = new THREE.Object3D();
    placeGroup(course, pad, checkpoint.s, 0);
    pad.name = key;
    pad.userData.anchorKey = key;
    pad.userData.courseS = checkpoint.s;
    group.add(pad);
    const entry = { key, kind: 'checkpoint', sourceId: checkpoint.id, part: 'center', courseS: checkpoint.s, lane: 0, object: pad, width: DECK_HW * 1.9 };
    visualAnchors.set(key, entry);
    semanticAnchors.push(entry);
    semanticCheckpoints.push({ id: checkpoint.id, key, object: pad });
    if(checkpoint.visible){
      checkpointVisuals.push({
        color: PAL.cyan, opacity: 0.72,
        courseS: checkpoint.s, lane: 0, y: 0.04, width: DECK_HW * 1.9, depth: 2.4,
      });
    }
  }

  const safePadVisuals = [];
  for(const safePad of course.safePads){
    const key = `safe-pad:${safePad.id}`;
    const marker = new THREE.Object3D();
    placeGroup(course, marker, safePad.resumeS, safePad.lane);
    marker.name = key;
    marker.userData.anchorKey = key;
    marker.userData.courseS = safePad.resumeS;
    marker.userData.lane = safePad.lane;
    group.add(marker);
    const entry = { key, kind: 'safe-pad', sourceId: safePad.id, part: 'resume', courseS: safePad.resumeS, lane: safePad.lane, object: marker, width: 1.66 };
    visualAnchors.set(key, entry);
    semanticAnchors.push(entry);
    semanticSafePads.push({ id: safePad.id, key, object: marker });
    safePadVisuals.push({
      color: PAL.gold, opacity: 0.72, courseS: safePad.resumeS,
      lane: safePad.lane, y: 0.045, width: 1.66, depth: 0.2,
    });
  }
  addStripBatches(group, course, checkpointVisuals, 'checkpoint-batch');
  addStripBatches(group, course, safePadVisuals, 'safe-pad-batch');

  const startGate = addGate(group, course, 2, 'GRIDLOCK RUN', 'SWIPE TO MOVE', '#2ee6ff', semanticGates, { lightweight: lowfx });
  const finishGate = addGate(group, course, course.length - 0.5, 'TRAINING CLEAR', 'DISTRICT 01', '#ff3ec8', semanticGates);
  const districts = buildDistricts(group, course, {
    lowfx,
    accentMaterials: {
      magenta: sharedBasic(PAL.magenta),
      gold: sharedBasic(PAL.gold),
    },
  });

  // A real, course-anchored rewind assembly. During recovery the courier's
  // parcel tether terminates at this visible eye while the line on the deck
  // keeps the failed gap, landing, and safe pad in one readable story beat.
  const recoveryAnchor = new THREE.Group();
  recoveryAnchor.name = 'recovery:safe-pad-anchor';
  const recoveryEye = new THREE.Mesh(new THREE.OctahedronGeometry(0.29, 0), sharedBasic(PAL.gold));
  recoveryEye.name = 'recovery:anchor-eye';
  recoveryEye.scale.setScalar(1.55);
  recoveryAnchor.add(recoveryEye);
  const recoveryTrailAttribute = new THREE.BufferAttribute(new Float32Array(24 * 3), 3);
  const recoveryTrailGeometry = new THREE.BufferGeometry();
  recoveryTrailGeometry.setAttribute('position', recoveryTrailAttribute);
  const recoveryTrail = new THREE.Line(recoveryTrailGeometry, new THREE.LineBasicMaterial({
    color: PAL.gold, transparent: true, opacity: 0.82,
  }));
  recoveryTrail.name = 'recovery:rewind-trail';
  recoveryTrail.frustumCulled = false;
  group.add(recoveryAnchor, recoveryTrail);
  const recoveryVisual = {
    anchor: recoveryAnchor,
    eye: recoveryEye,
    trail: recoveryTrail,
    active: false,
    safeS: 0,
    anchorS: 0,
    fromS: 0,
  };
  const recoveryOccluders = [
    districts.group.getObjectByName('district:edge-posts'),
    districts.group.getObjectByName('relay-causeway:service-ribs'),
    districts.group.getObjectByName('relay-causeway:finish-gate-structure'),
    districts.group.getObjectByName('relay-causeway:finish-gate-light'),
    districts.group.getObjectByName('landmark:aster-relay'),
    finishGate,
  ].filter(Boolean);
  function setRecoveryPresentation(active, safeS = recoveryVisual.safeS, fromS = recoveryVisual.fromS){
    recoveryVisual.active = Boolean(active);
    recoveryVisual.safeS = clamp(Number(safeS) || 0, 0, course.length);
    recoveryVisual.fromS = clamp(Number(fromS) || recoveryVisual.safeS, recoveryVisual.safeS, course.length);
    recoveryVisual.anchorS = Math.min(
      recoveryVisual.fromS,
      recoveryVisual.safeS + Math.min(7.5, (recoveryVisual.fromS - recoveryVisual.safeS) * 0.36),
    );
    const anchorPose = coursePose(course, recoveryVisual.anchorS, 0);
    recoveryAnchor.position.copy(anchorPose.pos);
    recoveryAnchor.position.y += 2.72;
    recoveryAnchor.rotation.set(0, Math.atan2(anchorPose.tan.x, anchorPose.tan.z), 0);
    const positions = recoveryTrailAttribute.array;
    for(let index = 0; index < recoveryTrailAttribute.count; index += 1){
      const amount = index / Math.max(1, recoveryTrailAttribute.count - 1);
      const s = recoveryVisual.safeS + (recoveryVisual.fromS - recoveryVisual.safeS) * amount;
      const pose = coursePose(course, s, 0);
      positions[index * 3] = pose.pos.x;
      positions[index * 3 + 1] = pose.pos.y + 0.075;
      positions[index * 3 + 2] = pose.pos.z;
    }
    recoveryTrailAttribute.needsUpdate = true;
    recoveryTrailGeometry.computeBoundingSphere();
    recoveryAnchor.visible = recoveryVisual.active;
    recoveryTrail.visible = recoveryVisual.active;
    for(let index = 0; index < recoveryOccluders.length; index += 1){
      recoveryOccluders[index].visible = !recoveryVisual.active;
    }
    return recoveryVisual.active;
  }
  setRecoveryPresentation(false, course.safePads?.at(-1)?.resumeS ?? 0, course.length);

  const holos = [];
  const visibleCheckpoints = checkpointData(course).filter(checkpoint => checkpoint.visible);
  const holoMaterial = new THREE.MeshBasicMaterial({
    color: PAL.cyan, transparent: true, opacity: 0.46,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const holoGeometry = new THREE.TorusGeometry(5.7, 0.12, 8, 48);
  for(let index = 0; index < visibleCheckpoints.length; index += 1){
    const checkpoint = visibleCheckpoints[index];
    const pose = coursePose(course, checkpoint.s);
    const ring = new THREE.Mesh(
      holoGeometry,
      holoMaterial,
    );
    ring.position.copy(pose.pos);
    ring.position.y += 3.8;
    ring.rotation.y = Math.atan2(pose.tan.x, pose.tan.z);
    ring.rotateOnAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2 - 0.12);
    group.add(ring);
    holos.push({ m: ring, phase: checkpoint.s * 0.1, checkpointId: checkpoint.id });
  }

  const anchorOriginals = new Map();
  const hazardOriginals = new Map();
  const detachedOwners = new Map();
  const worldPosition = new THREE.Vector3();
  const worldNormal = new THREE.Vector3();
  function alignmentReport(){
    const canonicalReport = course.debugAnchors?.();
    if(!canonicalReport?.anchors) return { ok: false, maxDelta: Infinity, rows: [], reason: 'course-debug-anchors-unavailable' };
    group.updateMatrixWorld(true);
    let maxDelta = 0;
    let missing = 0;
    const rows = canonicalReport.anchors.map(anchor => {
      const entry = visualAnchors.get(anchor.key);
      const observedObject = entry?.owner || entry?.object;
      if(!entry?.object || !observedObject?.parent){
        missing += 1;
        maxDelta = Infinity;
        return {
          id: anchor.key, kind: anchor.kind, visual: null,
          collider: [anchor.canonical.x, anchor.canonical.y, anchor.canonical.z],
          delta: Infinity, missing: true,
        };
      }
      if(typeof entry.observe === 'function') entry.observe(worldPosition);
      else entry.object.getWorldPosition(worldPosition);
      const delta = worldPosition.distanceTo(v3(anchor.canonical));
      maxDelta = Math.max(maxDelta, delta);
      return {
        id: anchor.key,
        kind: anchor.kind,
        visual: [worldPosition.x, worldPosition.y, worldPosition.z],
        collider: [anchor.canonical.x, anchor.canonical.y, anchor.canonical.z],
        delta,
        observationSource: entry.observationSource || entry.kind,
        ownerName: observedObject.name || observedObject.type,
        ownerType: observedObject.type,
        ownerIsMesh: Boolean(observedObject.isMesh),
        geometryVertexCount: observedObject.geometry?.getAttribute?.('position')?.count ?? null,
        vertexIndices: entry.vertexIndices ? [...entry.vertexIndices] : null,
        missing: false,
      };
    });
    return {
      ok: missing === 0 && maxDelta <= ALIGNMENT_TOLERANCE,
      tolerance: ALIGNMENT_TOLERANCE,
      maxDelta,
      missing,
      rows,
    };
  }

  function semanticReport(){
    group.updateMatrixWorld(true);
    return {
      anchors: semanticAnchors.map(entry => ({
        key: entry.key,
        kind: entry.kind,
        hazardId: entry.kind === 'hazard' ? entry.sourceId : undefined,
        sourceId: entry.sourceId,
        part: entry.part,
        lane: entry.lane,
        courseS: entry.courseS,
        width: entry.width,
        observationSource: entry.observationSource || entry.kind,
        ownerName: (entry.owner || entry.object)?.name || (entry.owner || entry.object)?.type,
        ownerType: (entry.owner || entry.object)?.type,
        ownerIsMesh: Boolean((entry.owner || entry.object)?.isMesh),
        geometryVertexCount: (entry.owner || entry.object)?.geometry?.getAttribute?.('position')?.count ?? null,
        vertexIndices: entry.vertexIndices ? [...entry.vertexIndices] : null,
      })),
      warnings: semanticWarnings.map(entry => ({
        hazardId: entry.hazardId,
        lane: entry.lane,
        courseS: entry.courseS,
        width: entry.width,
      })),
      gates: semanticGates.map(entry => {
        const tangent = coursePose(course, entry.s).tan;
        worldNormal.set(0, 0, 1).transformDirection(entry.approachFace.matrixWorld);
        return {
          kind: entry.id,
          courseS: entry.s,
          approachFacingDot: worldNormal.dot(tangent),
          approachFrontSide: entry.approachFace.material.side === THREE.FrontSide,
          separateRearFace: entry.rearFace !== entry.approachFace,
        };
      }),
      checkpoints: semanticCheckpoints.map(entry => ({ id: entry.id, key: entry.key })),
      safePads: semanticSafePads.map(entry => ({ id: entry.id, key: entry.key })),
      districts: districts.semanticReport(),
      visualBatches: {
        warnings: { instances: warningVisuals.length, draws: warningBatchCount },
        hazardAnchors: { instances: anchorVisuals.length, draws: anchorBatchCount },
      },
    };
  }

  function debugOffsetAnchor(key, delta = {}){
    const entry = visualAnchors.get(key);
    const owner = entry?.owner || entry?.object;
    if(!owner) return false;
    if(!anchorOriginals.has(key)) anchorOriginals.set(key, { owner, position: owner.position.clone() });
    owner.position.add(new THREE.Vector3(Number(delta.x) || 0, Number(delta.y) || 0, Number(delta.z) || 0));
    owner.updateMatrixWorld(true);
    return true;
  }

  function restoreOffsetAnchor(key){
    const original = anchorOriginals.get(key);
    if(!original?.owner) return false;
    original.owner.position.copy(original.position);
    original.owner.updateMatrixWorld(true);
    anchorOriginals.delete(key);
    return true;
  }

  function debugOffsetHazard(hazardId, delta = {}){
    const owner = hazardGroups.get(hazardId);
    if(!owner) return false;
    if(!hazardOriginals.has(hazardId)) hazardOriginals.set(hazardId, owner.position.clone());
    owner.position.add(new THREE.Vector3(Number(delta.x) || 0, Number(delta.y) || 0, Number(delta.z) || 0));
    owner.updateMatrixWorld(true);
    return true;
  }

  function restoreOffsetHazard(hazardId){
    const owner = hazardGroups.get(hazardId);
    const original = hazardOriginals.get(hazardId);
    if(!owner || !original) return false;
    owner.position.copy(original);
    owner.updateMatrixWorld(true);
    hazardOriginals.delete(hazardId);
    return true;
  }

  function debugDetachAnchorOwner(key){
    const entry = visualAnchors.get(key);
    const owner = entry?.owner || entry?.object;
    if(!owner?.parent || detachedOwners.has(key)) return false;
    detachedOwners.set(key, { owner, parent: owner.parent });
    owner.removeFromParent();
    return true;
  }

  function restoreDetachedAnchorOwner(key){
    const detached = detachedOwners.get(key);
    if(!detached) return false;
    detached.parent.add(detached.owner);
    detached.owner.updateMatrixWorld(true);
    detachedOwners.delete(key);
    return true;
  }

  function setTitlePresentation(active){
    startGate.visible = !active;
    districts.setTitlePresentation(active);
  }

  return {
    group, holos, hazards, districts, visualAnchors, hazardGroups, hazardBodies, bodyBoundaries, deckRibbons,
    recoveryVisual,
    alignmentReport, semanticReport,
    debugOffsetAnchor, restoreOffsetAnchor,
    debugOffsetHazard, restoreOffsetHazard,
    debugDetachAnchorOwner, restoreDetachedAnchorOwner,
    setTitlePresentation, setRecoveryPresentation,
  };
}

export function tickCity(dt, t, city){
  for(const holo of city.holos || []){
    holo.m.material.opacity = 0.34 + 0.16 * Math.sin(t * 2.1 + holo.phase);
    holo.m.rotation.z += dt * 0.28;
  }
  tickDistricts(t, city.districts, city.districts?.course || city.course);
}

export function hazardCueFor(course, s){
  const next = typeof course.cueAt === 'function'
    ? course.cueAt(s)
    : hazardData(course).find(hazard => s < hazard.s1 && s >= (hazard.cueStart ?? hazard.s0 - 10));
  if(!next) return null;
  const label = next.action === 'jump' ? '↑ SWIPE UP'
    : next.action === 'double-jump' ? '↑ ↑ DOUBLE SWIPE'
      : next.action === 'slide' ? '↓ SWIPE DOWN'
        : next.action === 'lane-left' ? '← SWIPE LEFT'
          : next.action === 'lane-right' ? '→ SWIPE RIGHT'
            : next.action === 'lane' ? `← ${next.label || 'CHOOSE A LANE'} →`
              : next.label || 'SWIPE';
  return {
    id: next.id,
    label,
    distance: Math.max(0, next.s0 - s),
    action: next.action,
    cueStart: next.cueStart,
    actionAt: next.actionAt ?? next.cueStart,
    actionReady: s >= (next.actionAt ?? next.cueStart),
    s0: next.s0,
    lethal: Boolean(next.lethal),
  };
}
