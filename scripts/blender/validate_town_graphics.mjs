/** Validate the actual decoded release, including protected geometry and routes. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Ray, Vector3 } from 'three';
import { hash } from './split_vehicle_baseline.mjs';
import { readGeometry } from './read_refined_glb.mjs';

const root = new URL('../../', import.meta.url), path = p => new URL(p, root);
const map = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(path('scripts/blender/export_map.ts'))], { cwd: fileURLToPath(root), encoding: 'utf8' }));
const receipt = JSON.parse(readFileSync(path('art/source/town-graphics-export.json')));
const release = await readGeometry(path('public/models/environment-refined.glb'), true);
const { gltf, world, triangles, primitives, vertices, bytes } = release;
assert.equal(hash(bytes), receipt.sha256); assert.equal(bytes.length, receipt.bytes);
assert.equal(hash(readFileSync(path('shared/map.ts'))), receipt.mapSha256);
assert.equal(hash(readFileSync(path('public/models/vehicles-improved.glb'))), receipt.vehicleSourceSha256);
assert.equal(hash(readFileSync(path('public/models/environment-vehicle-test.glb'))), receipt.commonSourceSha256);
assert.ok(bytes.length <= 8_500_000 && primitives <= 36 && triangles.length <= 180_000, 'Bounded release download and render budgets');
assert.equal(triangles.length, receipt.triangles); assert.equal(primitives, receipt.primitives);
assert.ok(gltf.extensionsRequired.includes('EXT_meshopt_compression'));
assert.equal(gltf.animations?.length ?? 0, 0); assert.equal(gltf.cameras?.length ?? 0, 0); assert.ok(!gltf.extensions?.KHR_lights_punctual);
assert.equal(gltf.nodes.filter(n => n.name?.startsWith('Collision_')).length, map.obstacles.length);
for (const o of map.obstacles) {
  const n = gltf.nodes.find(n => n.name === `Collision_${o.id}`); assert.ok(n, o.id);
  assert.ok(new Vector3().setFromMatrixPosition(world.get(n.name)).distanceTo(new Vector3(o.x,o.y,o.z)) < 1e-5);
  assert.deepEqual(n.extras.sizeXYZ, [o.w,o.h,o.d]);
}
for (const image of gltf.images) {
  assert.equal(image.uri, undefined); assert.ok(['image/jpeg','image/png'].includes(image.mimeType));
  const v = gltf.bufferViews[image.bufferView]; assert.equal(v.buffer, 0);
  assert.ok(v.byteLength > 100 && (v.byteOffset ?? 0) + v.byteLength <= release.binary.length);
}
for (const m of gltf.materials) {
  const p = m.pbrMetallicRoughness;
  for (const n of [p.roughnessFactor ?? 1, p.metallicFactor ?? 1]) assert.ok(Number.isFinite(n) && n >= 0 && n <= 1);
}

// Batching/compression must preserve every approved vehicle triangle. A spatial
// index tolerates float32 serialization but checks matching points and material,
// including tiny faces where rounded digest keys alone would be insufficient.
const tolerance = .00003;
function preserve(source, candidate, label) {
  const buckets = new Map(), center = t => t.points.reduce((v,p) => v.add(p), new Vector3()).multiplyScalar(1/3);
  const cell = t => center(t).toArray().map(v => Math.floor(v*100));
  for (const t of candidate) { const key = `${t.material}:${cell(t)}`; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(t); }
  for (const t of source) {
    const c = cell(t); let found;
    for (let x=-1;x<=1&&!found;x++) for (let y=-1;y<=1&&!found;y++) for (let z=-1;z<=1&&!found;z++) {
      const bucket = buckets.get(`${t.material}:${[c[0]+x,c[1]+y,c[2]+z]}`);
      const i = bucket?.findIndex(other => [0,1,2].some(shift => t.points.every((p,k) => p.distanceTo(other.points[(k+shift)%3]) < tolerance)));
      if (i !== undefined && i >= 0) { found = bucket.splice(i,1)[0]; }
    }
    assert.ok(found, `${label}: missing/reversed/changed ${t.material} triangle at ${center(t).toArray()}`);
  }
  return source.length;
}
const vehicle = await readGeometry(path('public/models/vehicles-improved.glb'));
const vehicleTriangles = triangles.filter(t => t.material.startsWith('Vehicle_'));
assert.equal(vehicleTriangles.length, vehicle.triangles.length);
const protectedVehicleTriangles = preserve(vehicle.triangles, vehicleTriangles, 'Approved vehicles');
const common = await readGeometry(path('public/models/environment-vehicle-test.glb'));
const isTruck = t => /TownPaint|TownGroundWood|TownLimestoneTrim|TownRubber|TownBronzeMetal/.test(t.material) && t.points.every(p => p.x>.7 && p.x<4.6 && p.y>=-.01 && p.y<3.3 && p.z>-.5 && p.z<10.7);
const protectedTruckTriangles = preserve(common.triangles.filter(isTruck), triangles.filter(isTruck), 'Cargo truck');
assert.ok(protectedTruckTriangles > 100);
const ray = new Ray(), hit = new Vector3();
function intersections(origin, direction, limit) {
  ray.set(new Vector3().fromArray(origin), new Vector3().fromArray(direction)); const distances = [];
  for (const { points: [a,b,c] } of triangles) if (ray.intersectTriangle(a,b,c,false,hit)) { const d=hit.distanceTo(ray.origin); if(d<=limit) distances.push(d); }
  return distances;
}
const vehicleIds = ['school-bus-body','school-bus-hood','south-car','south-car-cabin','north-car','north-car-cabin'];
let collisionFaces = 0;
for (const o of map.obstacles.filter(o => !vehicleIds.includes(o.id))) for(let axis=0;axis<3;axis++) for(const sign of [-1,1]) {
  const origin=[o.x,o.y,o.z],size=[o.w,o.h,o.d],direction=[0,0,0];origin[axis]+=sign*(size[axis]/2+.04);direction[axis]=-sign;
  assert.ok(intersections(origin,direction,.081).some(d=>Math.abs(d-.04)<.0001),`Missing original collision face: ${o.id}, ${axis}, ${sign}`);collisionFaces++;
}
const openings=[];
for(const side of [-1,1]) for(const [x,y,z,label] of [[side*8.5,1.35,-2.25,'front door'],[side*8.5,4.8,0,'upstairs window'],[side*8.5,1.35,9.75,'garage door'],[side*23.5,4.6,4.2,'balcony door']]) {
  assert.equal(intersections([x,y,z],[label==='balcony door'?-side:side,0,0],2.4).length,0,label);openings.push(`${side}:${label}`);
}
assert.equal(intersections([2.65,1.5,11],[0,0,-1],3).length,0,'Cargo entrance remains open');
const report={status:'passed',bytes:bytes.length,sha256:hash(bytes),triangles:triangles.length,vertices,primitives,images:gltf.images.length,collisionReferences:map.obstacles.length,collisionFaces,openings,protectedVehicleTriangles,protectedTruckTriangles,toleranceMetres:tolerance,vehicleEnvelopeProof:'validate_vehicle_test.mjs checks complete triangles against the original collision union; this validator checks those triangles survive the final export unchanged.'};
writeFileSync(path('art/source/town-graphics-validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
