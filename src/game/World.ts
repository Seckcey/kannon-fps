import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ARENA_HALF, OBSTACLES } from '../../shared/map';

/** Draw static scenery in a few material batches rather than hundreds of mobile draw calls. */
class StaticBatch {
  private batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  add(geometry: THREE.BufferGeometry, material: THREE.Material, position: number[], rotation: number[] = [0, 0, 0], scale: number[] = [1, 1, 1]) {
    if (geometry.index) { const expanded = geometry.toNonIndexed(); geometry.dispose(); geometry = expanded; }
    geometry.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(...position as [number, number, number]),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation as [number, number, number])),
      new THREE.Vector3(...scale as [number, number, number]),
    ));
    // Uniform world-scale stone UVs keep large walls and narrow steps consistent.
    if (material.userData.stone) {
      const vertices = geometry.getAttribute('position'); const normals = geometry.getAttribute('normal'); const uv = geometry.getAttribute('uv');
      for (let i = 0; i < vertices.count; i++) {
        if (Math.abs(normals.getY(i)) > 0.6) uv.setXY(i, vertices.getX(i) / 3.5, vertices.getZ(i) / 3.5);
        else if (Math.abs(normals.getX(i)) > 0.6) uv.setXY(i, vertices.getZ(i) / 3.5, vertices.getY(i) / 3.5);
        else uv.setXY(i, vertices.getX(i) / 3.5, vertices.getY(i) / 3.5);
      }
    }
    const list = this.batches.get(material) ?? []; list.push(geometry); this.batches.set(material, list);
  }
  box(size: number[], position: number[], material: THREE.Material, radius = 0, rotation?: number[]) {
    const geometry = radius > 0 ? new RoundedBoxGeometry(size[0], size[1], size[2], 1, radius) : new THREE.BoxGeometry(size[0], size[1], size[2]);
    this.add(geometry, material, position, rotation);
  }
  finish() {
    const root = new THREE.Group();
    for (const [material, geometries] of this.batches) {
      const merged = mergeGeometries(geometries, false);
      if (merged) {
        const mesh = new THREE.Mesh(merged, material); mesh.castShadow = !material.userData.noShadow; mesh.receiveShadow = true;
        root.add(mesh);
      }
      for (const geometry of geometries) geometry.dispose();
    }
    this.batches.clear(); return root;
  }
}

function material(color: string, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.83, ...extra });
}

export interface ArenaWorld { root: THREE.Group; update(time: number): void; dispose(): void }

export function createWorld(renderer: THREE.WebGLRenderer): ArenaWorld {
  const root = new THREE.Group(); const batch = new StaticBatch(); const scenery = new StaticBatch();
  const stoneMap = new THREE.TextureLoader().load('/assets/limestone.png');
  stoneMap.colorSpace = THREE.SRGBColorSpace; stoneMap.wrapS = stoneMap.wrapT = THREE.RepeatWrapping;
  stoneMap.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const stone = material('#f5e5c8', { map: stoneMap }); stone.userData.stone = true;
  const peach = material('#e8aa83', { map: stoneMap }); peach.userData.stone = true;
  const cream = material('#f5e8cb', { map: stoneMap }); cream.userData.stone = true;
  const terracotta = material('#bc714c');
  const teal = material('#387f87');
  const trim = material('#cf9b5a', { metalness: 0.15, roughness: 0.58 });
  const grout = material('#c8b699');
  const navy = material('#173f4d');
  const soil = material('#746b45');
  const bark = material('#79644a');
  const green = [material('#4d7146'), material('#668449'), material('#789953'), material('#8ba65c')];
  const flower = material('#e7c866');
  batch.box([ARENA_HALF * 2, 0.65, ARENA_HALF * 2], [0, -0.325, 0], stone);
  // Course markings and inlaid tiles give each lane a readable identity.
  for (const x of [-12, 12]) batch.box([0.22, 0.013, 63.5], [x, 0.008, 0], teal);
  for (const z of [-12, 12]) batch.box([63.5, 0.013, 0.22], [0, 0.009, z], terracotta);
  for (let x = -28; x <= 28; x += 4) batch.box([0.012, 0.008, 63.9], [x, 0.006, 0], grout);
  for (let z = -28; z <= 28; z += 4) batch.box([63.9, 0.008, 0.012], [0, 0.006, z], grout);
  batch.add(new THREE.CylinderGeometry(5.8, 5.8, 0.018, 64), teal, [0, 0.018, 0]);
  batch.add(new THREE.CylinderGeometry(5.3, 5.3, 0.02, 64), stone, [0, 0.021, 0]);
  batch.add(new THREE.CylinderGeometry(1.9, 1.9, 0.023, 4), terracotta, [0, 0.025, 0], [0, Math.PI / 4, 0]);
  batch.add(new THREE.CylinderGeometry(1.55, 1.55, 0.025, 4), cream, [0, 0.028, 0], [0, Math.PI / 4, 0]);
  batch.add(new THREE.CylinderGeometry(0.7, 0.7, 0.026, 4), teal, [0, 0.03, 0], [0, Math.PI / 4, 0]);
  for (const obstacle of OBSTACLES) {
    const { x, y, z, w, h, d, kind } = obstacle;
    const bodyMaterial = obstacle.id === 'west-block' || kind === 'cover' ? peach : stone;
    batch.box([w, h, d], [x, y, z], bodyMaterial, Math.min(0.065, h / 6));
    const bottom = y - h / 2; const top = y + h / 2;
    if (kind === 'step') {
      batch.box([w, 0.055, 0.1], [x, top - 0.03, z - d / 2 + 0.03], cream);
      batch.box([w - 0.3, 0.035, 0.05], [x, top - 0.10, z - d / 2 - 0.009], teal);
      continue;
    }
    batch.box([w + 0.08, 0.13, d + 0.08], [x, top - 0.045, z], cream, 0.035);
    if (h > 2.8 && w > 3) {
      batch.box([w + 0.035, 0.32, d + 0.035], [x, top - 0.36, z], teal);
      batch.box([w + 0.055, 0.11, d + 0.055], [x, top - 0.14, z], terracotta);
      batch.box([w + 0.03, 0.055, d + 0.03], [x, top - 0.54, z], trim);
    } else if (h > 0.8) batch.box([w + 0.035, 0.19, d + 0.035], [x, bottom + 0.28, z], teal);
    for (let row = bottom + 0.85; row < top - 0.55; row += 0.85) {
      batch.box([w + 0.015, 0.018, d + 0.015], [x, row, z], grout);
    }
    if (kind === 'wall' && h > 3 && d > 3) {
      // Shallow inset panels preserve the exact solid geometry used by the server.
      const panelW = Math.min(2.3, w - 0.9); const panelH = Math.min(2.7, h - 1.1);
      for (const side of [-1, 1]) {
        batch.box([panelW + 0.22, panelH + 0.24, 0.05], [x, bottom + panelH / 2 + 0.38, z + side * (d / 2 + 0.025)], terracotta, 0.02);
        batch.box([panelW, panelH, 0.063], [x, bottom + panelH / 2 + 0.39, z + side * (d / 2 + 0.032)], bodyMaterial, 0.02);
        batch.box([0.06, panelH * 0.7, 0.07], [x, bottom + panelH / 2 + 0.39, z + side * (d / 2 + 0.038)], trim);
      }
    }
  }
  // Solid border remains outside the playable collision boundary.
  for (const side of [-1, 1]) {
    batch.box([65.2, 0.9, 0.8], [0, -0.05, side * 32.45], stone);
    batch.box([65.3, 0.10, 0.87], [0, 0.43, side * 32.45], teal);
    batch.box([0.8, 0.9, 64], [side * 32.45, -0.05, 0], stone);
    batch.box([0.87, 0.10, 64], [side * 32.45, 0.43, 0], teal);
    for (let i = -28; i <= 28; i += 8) {
      batch.box([1.08, 1.45, 1.08], [i, 0.4, side * 32.45], cream, 0.04);
      batch.box([1.18, 0.15, 1.18], [i, 1.17, side * 32.45], terracotta, 0.03);
      batch.box([1.08, 1.45, 1.08], [side * 32.45, 0.4, i], cream, 0.04);
    }
  }
  // Art direction: warm training courtyard above a quiet Mediterranean-like sea.
  function tree(x: number, z: number, height: number, seed: number) {
    let state = seed;
    const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
    scenery.add(new THREE.CylinderGeometry(0.15, 0.37, height * 0.64, 9), bark, [x, height * 0.32, z], [0.03, 0, -0.05]);
    for (let i = 0; i < 13; i++) {
      const angle = i * 2.399; const radius = (0.7 + random() * 1.1) * height / 7;
      const px = x + Math.cos(angle) * radius; const pz = z + Math.sin(angle) * radius;
      const py = height * (0.60 + random() * 0.22);
      const branch = new THREE.Vector3(px - x, py - height * 0.38, pz - z);
      const branchGeometry = new THREE.CylinderGeometry(0.065, 0.13, branch.length(), 6);
      branchGeometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), branch.clone().normalize()));
      scenery.add(branchGeometry, bark, [x + branch.x / 2, height * 0.38 + branch.y / 2, z + branch.z / 2]);
      scenery.add(new THREE.IcosahedronGeometry(1, 1), green[i % green.length], [px, py, pz], [random(), random(), random()], [1.1 + random(), 0.65 + random() * 0.7, 1.1 + random()]);
    }
  }
  for (const [index, coordinates] of [[-35, -20], [-35, 6], [-28, -35], [-7, -36], [18, -36], [35, -22], [36, 7], [35, 24], [-36, 25], [-21, 36], [11, 36]].entries()) {
    const [x, z] = coordinates;
    scenery.box([4.0, 1.15, 4.0], [x, -0.1, z], peach, 0.10);
    scenery.box([4.25, 0.2, 4.25], [x, 0.51, z], terracotta, 0.05);
    scenery.box([3.7, 0.06, 3.7], [x, 0.58, z], soil);
    tree(x, z, 7 + (index % 3), index + 45);
  }
  // Cypress trees and flower beds flank the raised platform without hiding collision paths.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const x = side * 35.3; const z = -8 + i * 5;
      scenery.add(new THREE.CylinderGeometry(0.12, 0.19, 4, 7), bark, [x, 1.6, z]);
      scenery.add(new THREE.SphereGeometry(1, 10, 8), green[0], [x, 3.5, z], [0, 0, 0], [0.75, 3.1, 0.75]);
    }
    for (let i = 0; i < 18; i++) {
      scenery.add(new THREE.IcosahedronGeometry(0.26, 0), green[i % 4], [side * 33.5, 0.35, -29 + i * 3.35], [0, i, 0], [1.7, 1.0, 1.3]);
      scenery.add(new THREE.IcosahedronGeometry(0.08, 0), flower, [side * 33.5 + 0.2, 0.57, -28.8 + i * 3.35]);
    }
  }
  // Training gate motif and pennants, kept flat against existing stone.
  for (const x of [-8, 8]) {
    batch.box([1.1, 2.5, 0.035], [x, 3.0, -14.44], navy);
    batch.box([1.16, 0.075, 0.05], [x, 4.27, -14.42], trim);
    batch.box([0.44, 0.44, 0.06], [x, 3.25, -14.40], cream, 0.015, [0, 0, Math.PI / 4]);
    batch.box([0.22, 0.22, 0.073], [x, 3.25, -14.39], terracotta, 0.005, [0, 0, Math.PI / 4]);
    batch.box([0.55, 0.04, 0.05], [x, 2.35, -14.42], trim);
  }
  const arenaMesh = batch.finish(); root.add(arenaMesh);
  const exterior = scenery.finish(); root.add(exterior);
  // Limestone bedrock gives the arena an honest edge above the water.
  const rock = material('#b7b5a2');
  const foundation = new THREE.Mesh(new THREE.CylinderGeometry(43, 37, 9, 11), rock);
  foundation.position.y = -5.15; foundation.rotation.y = 0.22; foundation.receiveShadow = true; root.add(foundation);
  const waterMaterial = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: 'varying vec3 vWorld; void main(){ vec4 p=modelMatrix*vec4(position,1.); vWorld=p.xyz; gl_Position=projectionMatrix*viewMatrix*p; }',
    fragmentShader: `varying vec3 vWorld; uniform float uTime;
      void main(){ float wave=sin(vWorld.x*.4+vWorld.z*.65+uTime*.7)*sin(vWorld.z*.23-uTime*.4);
      float fine=pow(max(0.,sin(vWorld.x*1.5+vWorld.z*2.9+uTime)),22.);
      float fade=clamp(length(vWorld.xz)/380.,0.,1.);
      vec3 c=mix(vec3(.10,.44,.56),vec3(.37,.65,.71),fade);
      c+=wave*.025+fine*.065*(1.-fade); gl_FragColor=vec4(c,1.); }`,
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), waterMaterial);
  water.rotation.x = -Math.PI / 2; water.position.y = -3.2; root.add(water);
  const distant = new StaticBatch();
  const mountain = material('#8daeb6'); mountain.userData.noShadow = true;
  const mountainLight = material('#a0bac0'); mountainLight.userData.noShadow = true;
  for (let i = 0; i < 12; i++) {
    const x = -250 + i * 44; const height = 16 + Math.sin(i * 2.4) * 9 + (i % 3) * 5;
    distant.add(new THREE.ConeGeometry(35 + i % 3 * 8, height, 6, 1), i % 2 ? mountain : mountainLight, [x, height / 2 - 4, -245 - Math.cos(i) * 30], [0, i, 0], [1.5, 1, 1]);
  }
  root.add(distant.finish());
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vPosition;void main(){vPosition=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec3 vPosition;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.)),u.x),u.y);}
      float fbm(vec2 p){float v=0.;float a=.52;for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.04+vec2(7.1,2.8);a*=.48;}return v;}
      void main(){vec3 dir=normalize(vPosition);float h=max(0.,dir.y);float t=pow(h,.48);
      vec3 sky=mix(vec3(.76,.88,.88),vec3(.16,.47,.72),t);
      vec2 uv=dir.xz/(h+.14)*1.55;float cloud=fbm(uv);
      float shape=smoothstep(.51,.71,cloud)*smoothstep(.012,.13,h);
      float illumination=clamp(.5+fbm(uv+vec2(-.18,.08)),0.,1.);
      vec3 white=mix(vec3(.69,.78,.80),vec3(.99,.99,.96),illumination);
      sky=mix(sky,white,shape);gl_FragColor=vec4(sky,1.);}`,
  });
  // Draw the atmosphere after opaque scenery so depth testing avoids shading hidden sky pixels.
  const sky = new THREE.Mesh(new THREE.SphereGeometry(620, 24, 16), skyMaterial); sky.renderOrder = 100; root.add(sky);
  return {
    root,
    update(time) { waterMaterial.uniforms.uTime.value = time; },
    dispose() { stoneMap.dispose(); },
  };
}
