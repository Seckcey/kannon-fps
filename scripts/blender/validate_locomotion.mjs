/** Inspect the actual exported skin using Three's AnimationMixer, without a GPU. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AnimationMixer, LoopOnce, Texture, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const source = new URL('../../art/source/', import.meta.url);
const motionSource = new URL('motion/cmu-09/', source);
const provenance = JSON.parse(readFileSync(new URL('provenance.json', motionSource), 'utf8'));
assert.deepEqual(provenance.sources.map(item => item.file), ['09.asf', '09_01.amc']);
for (const item of provenance.sources) {
  const original = readFileSync(new URL(item.file, motionSource));
  assert.equal(original.length, item.bytes, `${item.file}: preserve the exact publisher bytes`);
  assert.equal(createHash('sha256').update(original).digest('hex'), item.sha256, `${item.file}: source digest must survive checkout on every platform`);
}
const path = fileURLToPath(new URL('../../public/models/scout.glb', import.meta.url));
const bytes = readFileSync(path);
// Texture pixels do not affect skeletal deformation. Production geometry, clips,
// inverse bind matrices and AnimationMixer interpolation remain unmodified.
const loader = new GLTFLoader();
loader.register(() => ({ name: 'CPU_skin_validation', loadTexture: () => Promise.resolve(new Texture()) }));
const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
const model = gltf.scene;
const mixer = new AnimationMixer(model);
const feet = { l: [], r: [] };
model.traverse(mesh => {
  if (!mesh.isSkinnedMesh) return;
  const joints = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
  for (const side of ['l', 'r']) {
    const joint = mesh.skeleton.bones.findIndex(bone => bone.name === `foot_${side}`);
    for (let index = 0; index < joints.count; index++) {
      for (let lane = 0; lane < 4; lane++) {
        if (joints.getComponent(index, lane) === joint && weights.getComponent(index, lane) > .9) {
          feet[side].push({ mesh, index }); break;
        }
      }
    }
  }
});
assert.ok(feet.l.length > 10 && feet.r.length > 10);
const point = new Vector3();
function sample() {
  model.updateMatrixWorld(true);
  const result = {};
  for (const side of ['l', 'r']) result[side] = feet[side].map(({ mesh, index }) => {
    point.fromBufferAttribute(mesh.geometry.attributes.position, index);
    mesh.applyBoneTransform(index, point); mesh.localToWorld(point);
    assert.ok(Number.isFinite(point.x + point.y + point.z));
    return point.clone();
  });
  return result;
}
function percentile(values, fraction) {
  if (!values.length) return null;
  return values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
}
const results = [];
// Regression limits for the grounded gait. The previous shipped asset measured
// 20 mm-band p95 slip of 1.75/2.72 m/s and loop velocity changes of 2.54/3.29 m/s
// (Walk/Run). These near-floor bands are contact proxies, not literal foot locks.
// Require near-floor coverage too. This discourages lifting as a shortcut, while
// the release comparison separately checks each foot's baseline stance phases.
const gaitLimits = {
  Walk: { seamVelocity: 1.3, slipP95: [.6, 1.2], minimumDuty: [.28, .48] },
  Run: { seamVelocity: 1.8, slipP95: [1, 2.5], minimumDuty: [.24, .40] },
};
for (const [name, reference, duration] of [['Walk', 6.5, 16 / 30], ['Run', 9, 14 / 30]]) {
  const clip = gltf.animations.find(clip => clip.name === name);
  assert.ok(Math.abs(clip.duration - duration) < 1e-6, `${name} keeps its measured reference duration`);
  const sampledDuration = clip.duration;
  mixer.stopAllAction();
  const action = mixer.clipAction(clip).reset().setLoop(LoopOnce, 1);
  action.clampWhenFinished = true; action.play();
  const samples = [], steps = Math.ceil(duration * 480);
  for (let index = 0; index <= steps; index++) {
    mixer.setTime(sampledDuration * index / steps); samples.push(sample());
  }
  const floor = samples.map(row => Math.min(...row.l.map(p => p.y), ...row.r.map(p => p.y)));
  const bands = [];
  for (const height of [.02, .04]) {
    const velocities = []; let contactFrames = 0;
    for (let index = 1; index < samples.length; index++) {
      const a = samples[index - 1], b = samples[index], dt = sampledDuration / steps;
      let lowest = null;
      for (const side of ['l', 'r']) for (let vertex = 0; vertex < a[side].length; vertex++) {
        const pa = a[side][vertex], pb = b[side][vertex];
        // Track the same sole vertex and exclude penetrating points from contact statistics.
        if (Math.min(pa.y, pb.y) >= -.001 && Math.max(pa.y, pb.y) < height && (!lowest || pa.y + pb.y < lowest.height))
          lowest = { pa, pb, height: pa.y + pb.y };
      }
      if (lowest) {
        contactFrames++;
        const velocity = lowest.pb.clone().sub(lowest.pa).divideScalar(dt);
        velocity.z -= reference;
        velocities.push(Math.hypot(velocity.x, velocity.z));
      }
    }
    bands.push({ heightMetres: height, contactFrames, sampledIntervals: steps, contactDuty: contactFrames / steps,
      horizontalSlipMedian: percentile(velocities, .5), horizontalSlipP95: percentile(velocities, .95) });
  }
  let seamPosition = 0, seamVelocity = 0;
  for (const side of ['l', 'r']) for (let vertex = 0; vertex < feet[side].length; vertex++) {
    const first = samples[0][side][vertex], second = samples[1][side][vertex];
    const last = samples.at(-1)[side][vertex], prior = samples.at(-2)[side][vertex];
    seamPosition = Math.max(seamPosition, first.distanceTo(last));
    seamVelocity = Math.max(seamVelocity, second.clone().sub(first).sub(last.clone().sub(prior)).length() / (sampledDuration / steps));
  }
  const minFloor = Math.min(...floor), maxFloor = Math.max(...floor);
  assert.ok(minFloor >= -.001, `${name} exported sole penetrates: ${minFloor} m`);
  assert.ok(maxFloor < .12, `${name} flight height remains bounded`);
  assert.ok(seamPosition < .0001, `${name} loop position seam: ${seamPosition} m`);
  const limits = gaitLimits[name];
  assert.ok(seamVelocity < limits.seamVelocity, `${name} loop velocity seam regressed: ${seamVelocity} m/s`);
  bands.forEach((band, index) => {
    assert.ok(band.contactDuty >= limits.minimumDuty[index], `${name} lost near-floor coverage in the ${band.heightMetres} m band`);
    assert.ok(band.horizontalSlipP95 !== null && band.horizontalSlipP95 < limits.slipP95[index], `${name} near-floor sliding regressed in the ${band.heightMetres} m band: ${band.horizontalSlipP95} m/s`);
  });
  results.push({ clip: name, referenceSpeed: reference, duration, sampledDuration, samples: samples.length,
    minFloor, maxFloor, seamPosition, seamVelocity, contactBands: bands });
}

// Optional migration proof compares every Float32 track against a previous asset.
// Normal validation remains self-contained; the baseline is never needed at runtime.
const baselinePath = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11);
const preserved = [];
let baselineHash;
if (baselinePath) {
  const previous = readFileSync(baselinePath);
  baselineHash = createHash('sha256').update(previous).digest('hex');
  const parse = data => { const size = data.readUInt32LE(12); return { data, json: JSON.parse(data.subarray(20, 20 + size)), bin: 28 + size }; };
  const old = parse(previous), current = parse(bytes);
  const floats = (asset, index) => {
    const acc = asset.json.accessors[index], view = asset.json.bufferViews[acc.bufferView];
    assert.equal(acc.componentType, 5126);
    const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[acc.type]; assert.ok(width);
    const offset = asset.bin + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    return Array.from({ length: acc.count * width }, (_, i) => asset.data.readFloatLE(offset + i * 4));
  };
  for (const name of ['Idle', 'Jump', 'Aim', 'Fire', 'Reload', 'Heal']) {
    const a = old.json.animations.find(c => c.name === name), b = current.json.animations.find(c => c.name === name);
    assert.equal(a.channels.length, b.channels.length);
    for (const channel of a.channels) {
      const node = old.json.nodes[channel.target.node].name;
      const other = b.channels.find(c => current.json.nodes[c.target.node].name === node && c.target.path === channel.target.path);
      assert.ok(other);
      for (const field of ['input', 'output']) assert.deepEqual(floats(old, a.samplers[channel.sampler][field]), floats(current, b.samplers[other.sampler][field]), `${name} ${node} ${field} changed`);
    }
    preserved.push({ clip: name, exactFloat32Tracks: true });
  }
}
const report = { status: 'passed', scope: 'Actual exported GLB skin at 480 Hz; CPU AnimationMixer. Contact bands exclude penetration. No actor height correction. This does not prove runtime crossfade contact.',
  assetBytes: bytes.length, assetSha256: createHash('sha256').update(bytes).digest('hex'), soleVertices: { left: feet.l.length, right: feet.r.length }, gaitLimits, results };
writeFileSync(new URL('scout-locomotion-export-review.json', source), `${JSON.stringify(report, null, 2)}\n`);
if (baselinePath) writeFileSync(new URL('scout-locomotion-migration-review.json', source), `${JSON.stringify({ status: 'passed', baselineSha256: baselineHash, candidateSha256: report.assetSha256, preserved }, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
