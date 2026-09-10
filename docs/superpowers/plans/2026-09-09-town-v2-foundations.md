# Kannon Town v2 Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver stages 1 and 2 of the visual overhaul: the purchased-asset record, the Blender collision guides, the lightmap and texture-compression pipeline, the runtime lightmap and sun-visibility shading, the render tier table, and a real-renderer style test of one street corner that Frank approves before the full town is built.

**Architecture:** Visible geometry moves from procedural scripts to a hand-authored Blender scene placed over locked collision guides. Lighting is baked in Blender into lightmap atlases carried by a project glTF extension `KANNON_lightmap`, textures are GPU-compressed to KTX2, and the runtime patches Three.js shaders so lightmapped surfaces ignore the real-time sun except for character shadows, while characters scale the sun by a collision-derived sun-visibility grid. A pure tier table decides shadows, post-processing and which GLB variant each device loads.

**Tech Stack:** Three.js r185 (`GLTFLoader`, `KTX2Loader`, `MeshoptDecoder`), Blender 5.2 at `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe` (Cycles bake, glTF export), `@gltf-transform/core|extensions|functions|cli` v4, KTX-Software `toktx`, `meshoptimizer`, `sharp`, Node 24+ `node:test` via `tsx`, Vite 8, existing comparison page (`npm run graphics-test`).

**Spec:** `docs/superpowers/specs/2026-09-09-kannon-town-visual-overhaul-design.md`

Stages 3 to 6 of the spec (full town build, scout re-skin, desktop presentation stack, release) get their own plans after Frank approves the style test at the end of this plan.

## Global Constraints

- Shared simulation code is untouched: no edits to `shared/map.ts`, `shared/physics.ts`, `shared/protocol.ts`, `server/**`.
- Existing tests, `npm run typecheck`, `npm run build` and `npm run test:assets` must keep passing after every task.
- Total first-load models ≤ 40 MB; environment GLB ≤ 30 MB; scout GLB ≤ 5 MB; transcoder and decoders ≤ 1 MB.
- Phone tier: 852×393 touch emulation, 95th percentile frame time ≤ 16.8 ms; draw calls ≤ 60 in the fixed bus view with one scout.
- Content Security Policy in `server/app.ts:65` stays as is: `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`. Nothing new is loaded from a third-party origin.
- Style: stylised realistic. Kenney/Synty low-poly and photoscan packs are excluded.
- Every purchased or CC0 asset is recorded in `art/PURCHASED_ASSETS.md` before it is used. Original purchased archives are never committed.
- Blender coordinates: game `(x, y, z)` with Y up maps to Blender `(x, -z, y)` with Z up. Game sun direction is `(-38, 52, 28)` normalised (`src/game/Atmosphere.ts:5`).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work happens on branch `visual/town-v2-design` (already created, contains the spec).

---

## File map

| File | Responsibility |
| --- | --- |
| `art/PURCHASED_ASSETS.md` (create) | Provenance table for purchased and CC0 assets, plus the candidate shortlist |
| `docs/ASSETS.md` (modify) | Replace the "no third-party assets" statement with a pointer to the provenance record |
| `art/source/town-v2/map.json` (generated, committed) | Collision layout export used by Blender scripts |
| `scripts/blender/import_collision_layout.py` (create) | Builds locked, non-rendering guide collections in a Blender file from `map.json` |
| `scripts/blender/lightmap-extension.mjs` (create) | `KANNON_lightmap` extension classes for gltf-transform |
| `scripts/blender/finish_town_v2.mjs` (create) | Attaches lightmaps, resizes per tier, compresses to KTX2 and Meshopt, writes GLB and manifest |
| `scripts/blender/bake_town_v2.py` (create) | Lightmap UV unwrap, Cycles bake to atlases, per-atlas material split, writes the lightmap sidecar |
| `scripts/blender/export_town_v2.py` (create) | Headless glTF export of the baked scene |
| `src/game/Lightmaps.ts` (create) | Runtime extension reader, GLTFLoader plugin, environment shader patch |
| `src/game/SunVisibility.ts` (create) | Collision-derived sun-visibility grid and character shader patch |
| `src/game/RenderTiers.ts` (create) | Pure tier table |
| `src/game/assets.ts` (modify) | New versioned URLs, tier-aware warmup |
| `src/game/World.ts` (modify) | KTX2 loader, lightmap plugin, lightmapped material configuration |
| `src/game/BlenderCharacter.ts` (modify) | Per-character material copies with the sun-visibility uniform |
| `src/game/GameView.ts` (modify) | Tier-driven settings, player-following shadow frustum, per-character sun visibility |
| `src/App.tsx` (modify) | Pass the texture tier into warmup |
| `src/vehicle-test/main.tsx` (modify) | `?graphics=style-test` mode for the comparison page |
| `tests/assets/lightmap-extension.test.ts` (create) | gltf-transform extension round-trip |
| `tests/client/lightmaps.test.ts` (create) | Definition reader, plugin, shader patch |
| `tests/client/sun-visibility.test.ts` (create) | Grid sampling and character shader patch |
| `tests/client/render-tiers.test.ts` (create) | Tier table |
| `package.json` (modify) | New dev dependencies and scripts |

---

### Task 1: Provenance record and shopping list

**Files:**
- Create: `art/PURCHASED_ASSETS.md`
- Modify: `docs/ASSETS.md`

**Interfaces:**
- Produces: the document Frank uses to buy packs and the table every later task appends to.

- [ ] **Step 1: Read the current statement in `docs/ASSETS.md`**

Run: `grep -n -i "third-party\|paid\|stock\|CC0" docs/ASSETS.md`
Expected: lines stating that no paid or stock assets are used. Note their line numbers.

- [ ] **Step 2: Create the provenance record with the shortlist**

```markdown
# Purchased and CC0 assets

Every third-party asset used by Kannon Arena is listed here before it is used. Original
purchased archives live outside the repository at `C:\it\kannon-assets\<vendor>\<product>\`
and are never committed. Only project-specific Blender scenes and exported GLBs are committed.

## Licence rules

A pack qualifies only if all of these hold:

- The licence allows use in a distributed game in any engine (Fab Standard, Unity Asset Store
  EULA, Sketchfab Standard, CGTrader Royalty Free and CC0 all qualify; "editorial only" and
  "personal use" do not).
- It ships FBX, OBJ or glTF plus ordinary PBR textures (base colour, normal,
  roughness/metalness or specular). Packs that depend on Unity or Unreal shaders are out.
- Style is stylised realistic. Flat-shaded low-poly (Kenney, Synty) and photoscan packs are out.

## Record

| Vendor | Product | Licence | Ordered | Price | Used for | Local path |
| --- | --- | --- | --- | --- | --- | --- |
| Poly Haven | (textures listed as used) | CC0 | — | free | Ground and wall surfaces | `C:\it\kannon-assets\polyhaven\` |

## Shortlist to evaluate (step 1 of the plan)

Candidates are evaluated by downloading the preview or buying the cheapest that passes the
licence rules, importing into Blender, and checking scale, texel density and style match
against `docs/art/town-graphics-after-street.png`. Record the verdict in the table above.

| Need | Candidate marketplaces | Search terms |
| --- | --- | --- |
| Modular suburban house kit | Fab, Unity Asset Store, CGTrader | "modular suburban house stylized", "suburb neighborhood modular" |
| Street and yard props | Fab, Unity Asset Store, Sketchfab | "stylized street props", "suburban props pack" |
| Foliage | Fab, Unity Asset Store | "stylized grass trees pack", "stylized vegetation" |
| Decals | Fab, Poly Haven (CC0 decals) | "decal pack cracks dirt road", "stylized decals" |
```

- [ ] **Step 3: Update `docs/ASSETS.md`**

Replace the sentence(s) found in Step 1 with:

```markdown
Third-party assets are permitted from the visual overhaul onward. Every purchased or CC0 item
is recorded in [art/PURCHASED_ASSETS.md](../art/PURCHASED_ASSETS.md) with its licence, price
and local archive location before use. Earlier releases used only original project artwork.
```

- [ ] **Step 4: Commit**

```bash
git add art/PURCHASED_ASSETS.md docs/ASSETS.md
git commit -m "Add purchased-asset provenance record and shortlist

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand Frank the shopping list**

Send Frank the shortlist table with direct links and prices for the top candidate in each row (found by searching the marketplaces above at execution time). He buys; the record's table is filled in as each pack arrives. Tasks 2 to 6 do not need the packs. Task 7 does.

---

### Task 2: Collision layout guides in Blender

**Files:**
- Create: `scripts/blender/import_collision_layout.py`
- Create: `art/source/town-v2/map.json` (generated)
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `scripts/blender/export_map.ts` JSON: `{ arenaHalf, name, obstacles: [{id,x,y,z,w,h,d,...}], spawns: [{x,y,z,yaw}], stairs: [{id, steps, landing, approach, exit}] }`.
- Produces: `art/source/kannon-town-v2.blend` containing collections `Guides_Collision`, `Guides_Spawns`, `Guides_Stairs`, `Guides_Openings`, a `Sun` lamp, and a `World` with a Nishita sky. Later tasks open this file.

- [ ] **Step 1: Add npm scripts**

In `package.json` `scripts`, add:

```json
"town-v2:map": "node --import tsx scripts/blender/export_map.ts > art/source/town-v2/map.json",
"town-v2:guides": "\"C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe\" --background --python scripts/blender/import_collision_layout.py -- --map art/source/town-v2/map.json --save art/source/kannon-town-v2.blend",
"town-v2:guides:check": "\"C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe\" --background --python scripts/blender/import_collision_layout.py -- --map art/source/town-v2/map.json --check"
```

- [ ] **Step 2: Generate the map export**

Run: `mkdir -p art/source/town-v2 && npm run town-v2:map && node -e "const m=require('./art/source/town-v2/map.json');console.log(m.obstacles.length, m.spawns.length, m.stairs.length)"`
Expected: `150 8 4` (or the current counts; note them for the check in Step 4).

- [ ] **Step 3: Write the Blender script**

```python
"""Build locked, non-rendering guide collections from the authoritative map export.

Game coordinates are Y-up; Blender is Z-up. game (x, y, z) -> blender (x, -z, y).
Run:  blender --background --python scripts/blender/import_collision_layout.py -- --map <json> [--save <blend>] [--check]
"""
import argparse, json, math, sys
import bpy
from mathutils import Vector

SUN_GAME = Vector((-38.0, 52.0, 28.0)).normalized()          # src/game/Atmosphere.ts SUN_DIRECTION
OPENINGS = [  # scripts/blender/validate_town_graphics.mjs openings, game coordinates
    (side * 8.5, 1.35, -2.25, f"{'east' if side > 0 else 'west'} front door") for side in (-1, 1)
] + [
    (side * 8.5, 4.8, 0.0, f"{'east' if side > 0 else 'west'} upstairs window") for side in (-1, 1)
] + [
    (side * 8.5, 1.35, 9.75, f"{'east' if side > 0 else 'west'} garage door") for side in (-1, 1)
] + [
    (side * 23.5, 4.6, 4.2, f"{'east' if side > 0 else 'west'} balcony door") for side in (-1, 1)
]

def to_blender(x, y, z):
    return Vector((x, -z, y))

def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--map", required=True)
    parser.add_argument("--save")
    parser.add_argument("--check", action="store_true")
    return parser.parse_args(argv)

def collection(name):
    col = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if col.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(col)
    col.hide_render = True
    return col

def lock(obj):
    obj.lock_location = obj.lock_rotation = obj.lock_scale = (True, True, True)
    obj.hide_render = True
    obj.display_type = "WIRE"

def add_box(col, name, x, y, z, w, h, d):
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    col.objects.link(obj)
    verts = [Vector((sx * 0.5, sy * 0.5, sz * 0.5)) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj.location = to_blender(x, y, z)
    obj.scale = (w, d, h)          # game (w,h,d) -> blender (x=w, y=d, z=h)
    obj["sizeXYZ"] = [w, h, d]     # preserved in glTF extras for the validator
    lock(obj)
    return obj

def add_empty(col, name, x, y, z, kind="PLAIN_AXES", size=0.6, yaw=None):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = kind
    obj.empty_display_size = size
    obj.location = to_blender(x, y, z)
    if yaw is not None:
        obj.rotation_euler = (0.0, 0.0, -yaw)
    col.objects.link(obj)
    lock(obj)
    return obj

def add_sun():
    light = bpy.data.lights.new("Sun", "SUN")
    light.energy = 4.0
    light.angle = math.radians(1.5)
    obj = bpy.data.objects.new("Sun", light)
    bpy.context.scene.collection.objects.link(obj)
    direction = to_blender(*SUN_GAME)                # points from ground toward the sun
    obj.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    world = bpy.context.scene.world or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    sky = nodes.get("Sky Texture") or nodes.new("ShaderNodeTexSky")
    sky.sky_type = "NISHITA"
    sky.sun_disc = False
    sky.sun_elevation = math.asin(direction.z)
    sky.sun_rotation = math.atan2(direction.x, direction.y)
    sky.sun_intensity = 1.0
    world.node_tree.links.new(sky.outputs["Color"], nodes["Background"].inputs["Color"])
    nodes["Background"].inputs["Strength"].default_value = 0.6
    return obj

def build(map_data):
    boxes = collection("Guides_Collision")
    for o in map_data["obstacles"]:
        add_box(boxes, f"Collision_{o['id']}", o["x"], o["y"], o["z"], o["w"], o["h"], o["d"])
    spawns = collection("Guides_Spawns")
    for i, s in enumerate(map_data["spawns"]):
        add_empty(spawns, f"Spawn_{i}", s["x"], s["y"], s["z"], "SINGLE_ARROW", 1.2, s.get("yaw", 0.0))
    stairs = collection("Guides_Stairs")
    for route in map_data["stairs"]:
        a, e = route["approach"], route["exit"]
        add_empty(stairs, f"Stair_{route['id']}_approach", a["x"], a["y"], a["z"], "SPHERE", 0.4)
        add_empty(stairs, f"Stair_{route['id']}_exit", e["x"], e["y"], e["z"], "SPHERE", 0.4)
    openings = collection("Guides_Openings")
    for x, y, z, label in OPENINGS:
        add_empty(openings, f"Opening_{label.replace(' ', '_')}", x, y, z, "CUBE", 0.5)
    add_sun()

def main():
    args = parse_args()
    with open(args.map, encoding="utf-8") as f:
        map_data = json.load(f)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    build(map_data)
    built = len(bpy.data.collections["Guides_Collision"].objects)
    assert built == len(map_data["obstacles"]), (built, len(map_data["obstacles"]))
    assert len(bpy.data.collections["Guides_Spawns"].objects) == len(map_data["spawns"])
    assert len(bpy.data.collections["Guides_Openings"].objects) == len(OPENINGS)
    sample = map_data["obstacles"][0]
    obj = bpy.data.objects[f"Collision_{sample['id']}"]
    assert (obj.location - to_blender(sample["x"], sample["y"], sample["z"])).length < 1e-6
    if args.check:
        print(f"OK guides: {built} collision boxes, {len(map_data['spawns'])} spawns, {len(OPENINGS)} openings")
        return
    if args.save:
        bpy.ops.wm.save_as_mainfile(filepath=bpy.path.abspath("//" + args.save) if not args.save.startswith(("C:", "/")) else args.save)
        print(f"Saved {args.save}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the check**

Run: `npm run town-v2:guides:check`
Expected: last line `OK guides: 150 collision boxes, 8 spawns, 8 openings` (counts from Step 2). Any assertion error is a coordinate bug; fix before continuing.

- [ ] **Step 5: Save the guide file**

Run: `npm run town-v2:guides && ls -la art/source/kannon-town-v2.blend`
Expected: the file exists and is a few hundred KB.

- [ ] **Step 6: Open the file in Blender's UI once and confirm visually**

Open `art/source/kannon-town-v2.blend`. Expected: wireframe boxes forming two houses, garages, bus, sedans and truck around a street; arrows at spawns; sun lamp pointing from the north-west and high. Take a screenshot to `art/source/town-v2/guides-check.png` and commit it as evidence.

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/blender/import_collision_layout.py art/source/town-v2/map.json art/source/kannon-town-v2.blend art/source/town-v2/guides-check.png
git commit -m "Add Blender collision guide import for Kannon Town v2

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: gltf-transform lightmap extension and finish script

**Files:**
- Create: `scripts/blender/lightmap-extension.mjs`
- Create: `scripts/blender/finish_town_v2.mjs`
- Create: `tests/assets/lightmap-extension.test.ts`
- Modify: `package.json` (devDependencies, `test` script)

**Interfaces:**
- Produces: `KannonLightmap` (gltf-transform `Extension`), `Lightmap` (`ExtensionProperty` with `setTexture`, `getTextureInfo`, `setIntensity`), `LIGHTMAP_EXTENSION = 'KANNON_lightmap'`.
- Produces: CLI `node scripts/blender/finish_town_v2.mjs --input <glb> --lightmaps <sidecar.json> --out <glb> --tier full|phone --manifest <json>`.
- Sidecar format (written by Task 7's bake script): `{ "atlases": { "LM_0": "LM_0.png" }, "materials": { "<material name>": { "atlas": "LM_0", "intensity": 1 } } }`, paths relative to the sidecar.
- glTF JSON produced: `materials[i].extensions.KANNON_lightmap = { intensity: number, texture: { index: number, texCoord: 1 } }`.

- [ ] **Step 1: Install dependencies**

Run: `npm install -D @gltf-transform/core@^4 @gltf-transform/extensions@^4 @gltf-transform/functions@^4 @gltf-transform/cli@^4 meshoptimizer@^0.22 sharp@^0.34`
Expected: no peer errors. Then install KTX-Software (provides `toktx`): download the latest Windows installer from https://github.com/KhronosGroup/KTX-Software/releases, install, and add its `bin` folder to PATH. Verify: `toktx --version` prints a version.

- [ ] **Step 2: Write the failing round-trip test**

`tests/assets/lightmap-extension.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, NodeIO } from '@gltf-transform/core';
import { KannonLightmap, LIGHTMAP_EXTENSION } from '../../scripts/blender/lightmap-extension.mjs';

// 1x1 opaque PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('lightmap extension survives a GLB write and read', async () => {
  const document = new Document();
  const extension = document.createExtension(KannonLightmap);
  const atlas = document.createTexture('LM_0').setImage(PNG).setMimeType('image/png');
  const material = document.createMaterial('Siding');
  const lightmap = extension.createLightmap().setIntensity(0.9).setTexture(atlas);
  lightmap.getTextureInfo()!.setTexCoord(1);
  material.setExtension(LIGHTMAP_EXTENSION, lightmap);
  const io = new NodeIO().registerExtensions([KannonLightmap]);
  const glb = await io.writeBinary(document);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset + 12).getUint32(0, true))));
  assert.deepEqual(json.materials[0].extensions[LIGHTMAP_EXTENSION], { intensity: 0.9, texture: { index: 0, texCoord: 1 } });
  assert.ok(json.extensionsUsed.includes(LIGHTMAP_EXTENSION));
  const back = await io.readBinary(glb);
  const readMaterial = back.getRoot().listMaterials()[0];
  const readLightmap = readMaterial.getExtension<InstanceType<typeof KannonLightmap>['createLightmap'] extends () => infer L ? L : never>(LIGHTMAP_EXTENSION)!;
  assert.equal(readLightmap.getIntensity(), 0.9);
  assert.equal(readLightmap.getTexture()!.getName(), 'LM_0');
  assert.equal(readLightmap.getTextureInfo()!.getTexCoord(), 1);
});
```

- [ ] **Step 3: Add the test directory to the test script and run it to see it fail**

In `package.json`, change `"test"` to:

```json
"test": "tsx --test tests/server/*.test.ts tests/acceptance/*.test.ts tests/client/*.test.ts tests/assets/*.test.ts"
```

Run: `npx tsx --test tests/assets/lightmap-extension.test.ts`
Expected: FAIL, cannot find module `lightmap-extension.mjs`.

- [ ] **Step 4: Write the extension**

`scripts/blender/lightmap-extension.mjs`:

```js
/** Project glTF extension carrying a baked lightmap per material.
 *  materials[i].extensions.KANNON_lightmap = { intensity, texture: { index, texCoord } } */
import { Extension, ExtensionProperty, PropertyType, TextureInfo } from '@gltf-transform/core';

export const LIGHTMAP_EXTENSION = 'KANNON_lightmap';

export class Lightmap extends ExtensionProperty {
  static EXTENSION_NAME = LIGHTMAP_EXTENSION;
  init() { this.extensionName = LIGHTMAP_EXTENSION; this.propertyType = 'Lightmap'; this.parentTypes = [PropertyType.MATERIAL]; }
  getDefaults() { return Object.assign(super.getDefaults(), { intensity: 1, texture: null, textureInfo: new TextureInfo(this.graph, 'textureInfo') }); }
  getIntensity() { return this.get('intensity'); }
  setIntensity(value) { return this.set('intensity', value); }
  getTexture() { return this.getRef('texture'); }
  setTexture(texture) { return this.setRef('texture', texture, { channels: 0b0111 }); }
  getTextureInfo() { return this.getRef('texture') ? this.getRef('textureInfo') : null; }
}

export class KannonLightmap extends Extension {
  static EXTENSION_NAME = LIGHTMAP_EXTENSION;
  extensionName = LIGHTMAP_EXTENSION;
  createLightmap() { return new Lightmap(this.document.getGraph()); }
  read(context) {
    const json = context.jsonDoc.json;
    (json.materials ?? []).forEach((def, index) => {
      const ext = def.extensions?.[LIGHTMAP_EXTENSION]; if (!ext) return;
      const lightmap = this.createLightmap().setIntensity(ext.intensity ?? 1);
      if (ext.texture) {
        const textureDef = json.textures[ext.texture.index];
        lightmap.setTexture(context.textures[textureDef.source]);
        context.setTextureInfo(lightmap.getTextureInfo(), ext.texture);
      }
      context.materials[index].setExtension(LIGHTMAP_EXTENSION, lightmap);
    });
    return this;
  }
  write(context) {
    const json = context.jsonDoc.json;
    for (const material of this.document.getRoot().listMaterials()) {
      const lightmap = material.getExtension(LIGHTMAP_EXTENSION); if (!lightmap) continue;
      const def = json.materials[context.materialIndexMap.get(material)];
      def.extensions ??= {};
      def.extensions[LIGHTMAP_EXTENSION] = {
        intensity: lightmap.getIntensity(),
        texture: context.createTextureInfoDef(lightmap.getTexture(), lightmap.getTextureInfo()),
      };
    }
    return this;
  }
}
```

If `context.textures` or `context.setTextureInfo` differ in the installed version, check `node_modules/@gltf-transform/extensions/dist/extensions.modern.js` for how `KHR_materials_clearcoat` reads and writes its textures and mirror that exactly.

- [ ] **Step 5: Run the test to see it pass**

Run: `npx tsx --test tests/assets/lightmap-extension.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the finish script**

`scripts/blender/finish_town_v2.mjs`:

```js
/** Attach baked lightmaps, resize per tier, compress textures to KTX2 and geometry with
 *  Meshopt, then write the runtime GLB and a manifest.
 *  node scripts/blender/finish_town_v2.mjs --input in.glb --lightmaps lm.json --out out.glb --tier full|phone --manifest out.json */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, textureCompress } from '@gltf-transform/functions';
import { Mode, toktx } from '@gltf-transform/cli';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { KannonLightmap, LIGHTMAP_EXTENSION } from './lightmap-extension.mjs';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const input = arg('input'), lightmapsPath = arg('lightmaps'), out = arg('out'), tier = arg('tier') ?? 'full', manifestPath = arg('manifest');
if (!input || !out || !lightmapsPath) throw new Error('Usage: --input <glb> --lightmaps <json> --out <glb> [--tier full|phone] [--manifest <json>]');
if (!['full', 'phone'].includes(tier)) throw new Error(`Unknown tier ${tier}`);
if (spawnSync('toktx', ['--version']).status !== 0) throw new Error('toktx not found. Install KTX-Software and add its bin folder to PATH.');

const BUDGET = { full: { lightmap: 2048, texture: 2048 }, phone: { lightmap: 1024, texture: 1024 } }[tier];

await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions([...ALL_EXTENSIONS, KannonLightmap]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const document = await io.read(input);
const lightmaps = JSON.parse(readFileSync(lightmapsPath, 'utf8'));
const extension = document.createExtension(KannonLightmap);

const atlases = new Map();
for (const [name, file] of Object.entries(lightmaps.atlases)) {
  const bytes = readFileSync(resolve(dirname(lightmapsPath), file));
  atlases.set(name, document.createTexture(name).setImage(new Uint8Array(bytes)).setMimeType('image/png'));
}
const materialsByName = new Map(document.getRoot().listMaterials().map(m => [m.getName(), m]));
const missing = [];
for (const [materialName, entry] of Object.entries(lightmaps.materials)) {
  const material = materialsByName.get(materialName);
  if (!material) { missing.push(materialName); continue; }
  const atlas = atlases.get(entry.atlas); if (!atlas) throw new Error(`Material ${materialName} references unknown atlas ${entry.atlas}`);
  const lightmap = extension.createLightmap().setIntensity(entry.intensity ?? 1).setTexture(atlas);
  lightmap.getTextureInfo().setTexCoord(1);
  material.setExtension(LIGHTMAP_EXTENSION, lightmap);
}
if (missing.length) throw new Error(`Lightmap sidecar names materials not in the GLB: ${missing.join(', ')}`);
for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
  const material = primitive.getMaterial();
  if (material?.getExtension(LIGHTMAP_EXTENSION) && !primitive.getAttribute('TEXCOORD_1')) throw new Error(`Primitive in ${mesh.getName()} uses lightmapped ${material.getName()} but has no TEXCOORD_1`);
}

await document.transform(
  dedup(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'png', resize: [BUDGET.texture, BUDGET.texture], slots: /^(?!.*lightmap).*$/i }),
  textureCompress({ encoder: sharp, targetFormat: 'png', resize: [BUDGET.lightmap, BUDGET.lightmap], pattern: /^LM_/ }),
  toktx({ mode: Mode.UASTC, slots: /normalTexture/, powerOfTwo: true }),
  toktx({ mode: Mode.ETC1S, quality: 160, slots: /^(?!normalTexture).*$/, powerOfTwo: true }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);

const glb = await io.writeBinary(document);
writeFileSync(out, glb);
const manifest = {
  input, tier, bytes: glb.byteLength, sha256: createHash('sha256').update(glb).digest('hex'),
  textures: document.getRoot().listTextures().map(t => ({ name: t.getName(), mime: t.getMimeType(), bytes: t.getImage()?.byteLength ?? 0, size: t.getSize() })),
  lightmapped: document.getRoot().listMaterials().filter(m => m.getExtension(LIGHTMAP_EXTENSION)).map(m => m.getName()),
};
if (manifestPath) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`${out}: ${(glb.byteLength / 1e6).toFixed(2)} MB, ${manifest.textures.length} textures, ${manifest.lightmapped.length} lightmapped materials`);
```

The `slots` regex on `textureCompress` matches the material slot name (for example `baseColorTexture`); the lightmap texture is not in a standard slot, so it is selected by `pattern` on texture name instead. If the installed `toktx` function does not accept `powerOfTwo`, remove it and confirm every atlas and kit texture is already power of two.

- [ ] **Step 7: Smoke-test the finish script on an existing GLB with an empty sidecar**

Run:
```bash
echo '{"atlases":{},"materials":{}}' > /tmp/empty-lm.json
node scripts/blender/finish_town_v2.mjs --input public/models/environment-vehicle-test.glb --lightmaps /tmp/empty-lm.json --out /tmp/smoke.glb --tier phone --manifest /tmp/smoke.json
node -e "const m=require('/tmp/smoke.json');console.log(m.bytes, m.textures.map(t=>t.mime))"
```
Expected: a GLB smaller than the input, every texture `image/ktx2`. Fix any API mismatch here, not in Task 7.

- [ ] **Step 8: Run the whole test suite**

Run: `npm test`
Expected: all previous tests plus the new one pass.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json scripts/blender/lightmap-extension.mjs scripts/blender/finish_town_v2.mjs tests/assets/lightmap-extension.test.ts
git commit -m "Add KANNON_lightmap glTF extension and KTX2 finish script

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Runtime lightmap loading and environment shading

**Files:**
- Create: `src/game/Lightmaps.ts`
- Create: `tests/client/lightmaps.test.ts`
- Modify: `src/game/World.ts:28` (loader factory) and the material traversal at `src/game/World.ts:56-100`

**Interfaces:**
- Consumes: glTF JSON shape from Task 3.
- Produces:
  - `readLightmapDefinition(materialDef: unknown): LightmapDefinition | null` where `LightmapDefinition = { texture: { index: number; texCoord: number }; intensity: number }`.
  - `class LightmapPlugin implements GLTFLoaderPlugin` with `name` and `extendMaterialParams(materialIndex, materialParams): Promise<void>`.
  - `patchLightmapFragment(fragmentShader: string): string` and `applyLightmapShading(material: THREE.MeshStandardMaterial, shadowStrength?: number): void`.

- [ ] **Step 1: Write the failing tests**

`tests/client/lightmaps.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LIGHTMAP_EXTENSION, LightmapPlugin, patchLightmapFragment, readLightmapDefinition } from '../../src/game/Lightmaps.js';

test('reads a valid lightmap definition and rejects malformed ones', () => {
  assert.deepEqual(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { intensity: 0.8, texture: { index: 3, texCoord: 1 } } } }),
    { intensity: 0.8, texture: { index: 3, texCoord: 1 } });
  assert.deepEqual(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { texture: { index: 0 } } } }),
    { intensity: 1, texture: { index: 0, texCoord: 1 } });
  assert.equal(readLightmapDefinition({}), null);
  assert.equal(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { texture: { index: -1 } } } }), null);
  assert.equal(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { intensity: 'x', texture: { index: 0 } } } }), null);
});

test('plugin assigns the lightmap texture and intensity through the parser', async () => {
  const assigned: unknown[] = [];
  const parser = {
    json: { materials: [{ extensions: { [LIGHTMAP_EXTENSION]: { intensity: 0.7, texture: { index: 2, texCoord: 1 } } } }, {}] },
    assignTexture: async (params: Record<string, unknown>, key: string, mapDef: unknown, colorSpace: string) => { params[key] = mapDef; assigned.push([key, mapDef, colorSpace]); },
  };
  const plugin = new LightmapPlugin(parser as never);
  const params: Record<string, unknown> = {};
  await plugin.extendMaterialParams(0, params);
  assert.equal(params.lightMapIntensity, 0.7);
  assert.deepEqual(assigned, [['lightMap', { index: 2, texCoord: 1 }, THREE.SRGBColorSpace]]);
  const untouched: Record<string, unknown> = {};
  await plugin.extendMaterialParams(1, untouched);
  assert.deepEqual(untouched, {});
});

test('environment patch removes the direct sun but keeps its shadow on the lightmap', () => {
  const patched = patchLightmapFragment(THREE.ShaderLib.standard.fragmentShader);
  assert.ok(!patched.includes('#include <lights_fragment_begin>'));
  assert.ok(!patched.includes('#include <lights_fragment_maps>'));
  assert.ok(patched.includes('float kannonSunShadow = 1.0;'));
  assert.ok(patched.includes('irradiance += lightMapIrradiance * mix( 1.0, kannonSunShadow, uSunShadowStrength );'));
  assert.ok(patched.includes('uniform float uSunShadowStrength;'));
  // The directional loop no longer calls RE_Direct; point and spot loops still do.
  const start = patched.indexOf('NUM_DIR_LIGHTS > 0');
  const directionalBlock = patched.slice(start, patched.indexOf('#pragma unroll_loop_end', start));
  assert.ok(!directionalBlock.includes('RE_Direct( directLight'));
  assert.ok(directionalBlock.includes('kannonSunShadow = min( kannonSunShadow'));
  // Hemisphere light is silenced for lightmapped surfaces.
  assert.ok(patched.includes('getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal ) * 0.0'));
  // Idempotent.
  assert.equal(patchLightmapFragment(patched), patched);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx tsx --test tests/client/lightmaps.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/game/Lightmaps.ts`**

```ts
import * as THREE from 'three';
import type { GLTFLoaderPlugin, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const LIGHTMAP_EXTENSION = 'KANNON_lightmap';
export interface LightmapDefinition { texture: { index: number; texCoord: number }; intensity: number }

/** Validates materials[i].extensions.KANNON_lightmap from untrusted GLB JSON. */
export function readLightmapDefinition(materialDef: unknown): LightmapDefinition | null {
  const ext = (materialDef as { extensions?: Record<string, unknown> } | null)?.extensions?.[LIGHTMAP_EXTENSION] as { intensity?: unknown; texture?: { index?: unknown; texCoord?: unknown } } | undefined;
  if (!ext || typeof ext !== 'object' || !ext.texture || typeof ext.texture !== 'object') return null;
  const index = ext.texture.index, texCoord = ext.texture.texCoord ?? 1, intensity = ext.intensity ?? 1;
  if (!Number.isInteger(index) || (index as number) < 0) return null;
  if (!Number.isInteger(texCoord) || (texCoord as number) < 0 || (texCoord as number) > 1) return null;
  if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0) return null;
  return { texture: { index: index as number, texCoord: texCoord as number }, intensity };
}

/** GLTFLoader plugin: `loader.register(parser => new LightmapPlugin(parser))`. */
export class LightmapPlugin implements GLTFLoaderPlugin {
  readonly name = LIGHTMAP_EXTENSION;
  constructor(private readonly parser: GLTFParser) {}
  extendMaterialParams(materialIndex: number, materialParams: Record<string, unknown>): Promise<void> {
    const definition = readLightmapDefinition(this.parser.json.materials?.[materialIndex]);
    if (!definition) return Promise.resolve();
    materialParams.lightMapIntensity = definition.intensity;
    return this.parser.assignTexture(materialParams as never, 'lightMap', definition.texture, THREE.SRGBColorSpace).then(() => {});
  }
}

const DIRECTIONAL_RE_DIRECT = /(getDirectionalLightInfo\( directionalLight, directLight \);[\s\S]*?)RE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);/;

/** Lightmapped surfaces carry the sun in the bake. Drop the real-time sun's direct term,
 *  silence the hemisphere fill, and let the sun shadow map darken the lightmap so
 *  characters still ground on the baked world. */
export function patchLightmapFragment(fragmentShader: string): string {
  if (fragmentShader.includes('kannonSunShadow')) return fragmentShader;
  const begin = THREE.ShaderChunk.lights_fragment_begin
    .replace(DIRECTIONAL_RE_DIRECT, '$1kannonSunShadow = min( kannonSunShadow, directLight.color.g / max( directionalLight.color.g, 1e-4 ) );')
    .replace('getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal )', 'getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal ) * 0.0');
  const maps = THREE.ShaderChunk.lights_fragment_maps
    .replace('irradiance += lightMapIrradiance;', 'irradiance += lightMapIrradiance * mix( 1.0, kannonSunShadow, uSunShadowStrength );');
  return fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uSunShadowStrength;')
    .replace('#include <lights_fragment_begin>', `float kannonSunShadow = 1.0;\n${begin}`)
    .replace('#include <lights_fragment_maps>', maps);
}

export function applyLightmapShading(material: THREE.MeshStandardMaterial, shadowStrength = 0.6): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uSunShadowStrength = { value: shadowStrength };
    shader.fragmentShader = patchLightmapFragment(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => 'kannon-lightmap-v1';
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx tsx --test tests/client/lightmaps.test.ts`
Expected: PASS. If the `RE_Direct` regex does not match, print `THREE.ShaderChunk.lights_fragment_begin` and adjust the regex to the exact r185 text; do not weaken the assertions.

- [ ] **Step 5: Wire the plugin and KTX2 into `World.ts`**

At the top of `src/game/World.ts` add:

```ts
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { LightmapPlugin, applyLightmapShading } from './Lightmaps';
```

Replace the loader factory (`const loader = () => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);`) with:

```ts
  const ktx2 = new KTX2Loader().detectSupport(renderer);
  const loader = () => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2).register(parser => new LightmapPlugin(parser));
```

`KTX2Loader` resolves its transcoder files relative to its own module URL, so Vite bundles `basis_transcoder.js` and `.wasm` as same-origin assets automatically; no copy step and no CSP change.

Inside the material traversal, after `if (!(material instanceof THREE.MeshStandardMaterial)) continue;`, add:

```ts
        if (material.lightMap) {
          applyLightmapShading(material);
          material.envMapIntensity = 0.25;
          object.castShadow = false;
          continue;
        }
```

In `dispose()`, add `ktx2.dispose();`.

- [ ] **Step 6: Typecheck, full tests, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all pass. The build output lists `basis_transcoder` assets in `dist/assets/`; confirm with `ls dist/assets | grep -i basis`.

- [ ] **Step 7: Commit**

```bash
git add src/game/Lightmaps.ts src/game/World.ts tests/client/lightmaps.test.ts
git commit -m "Load KANNON_lightmap and KTX2 textures with baked-sun shading

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Sun-visibility grid for characters

**Files:**
- Create: `src/game/SunVisibility.ts`
- Create: `tests/client/sun-visibility.test.ts`
- Modify: `src/game/BlenderCharacter.ts:49-80` (material copies), the returned model object
- Modify: `src/game/GameView.ts` (build grid once; update per player each frame in the player update loop near line 432)

**Interfaces:**
- Produces:
  - `buildSunVisibility(raycast: (origin: Vec3, direction: Vec3, limit: number) => number, options?: { half?: number; cells?: number; heights?: [number, number]; sun?: Vec3 }): SunVisibilityGrid`
  - `SunVisibilityGrid.sample(x: number, z: number, y: number): number` in `[0, 1]`, bilinear, layer chosen by `y >= 3.0`.
  - `patchSunVisibilityFragment(fragmentShader: string): string` and `applySunVisibility(material: THREE.Material, uniform: { value: number }): void`.
  - `BlenderCharacter` model gains `sunVisibility: { value: number }`.

- [ ] **Step 1: Write the failing tests**

`tests/client/sun-visibility.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { raycastMap } from '../../shared/physics.js';
import { buildSunVisibility, patchSunVisibilityFragment } from '../../src/game/SunVisibility.js';

test('grid reports 1 in the open, 0 in shade and blends between them', () => {
  // A wall at x = 0 blocks every ray starting at x < 0.
  const grid = buildSunVisibility((origin, _direction, limit) => origin.x < 0 ? 1 : limit, { half: 32, cells: 64, heights: [1.2, 4.6] });
  assert.equal(grid.sample(16, 0, 0), 1);
  assert.equal(grid.sample(-16, 0, 0), 0);
  const edge = grid.sample(0, 0, 0);
  assert.ok(edge > 0 && edge < 1, `expected a blend at the boundary, got ${edge}`);
  assert.equal(grid.sample(-16, 0, 4.5), 0);
  assert.equal(grid.sample(99, 99, 0), 1, 'outside the arena clamps to the edge cell');
});

test('the upper layer is sampled above the floor threshold', () => {
  const grid = buildSunVisibility((origin, _direction, limit) => origin.y > 3 ? limit : 1, { half: 8, cells: 8, heights: [1.2, 4.6] });
  assert.equal(grid.sample(0, 0, 0), 0);
  assert.equal(grid.sample(0, 0, 3.2), 1);
});

test('the real map produces both sunlit and shaded cells', () => {
  const grid = buildSunVisibility(raycastMap);
  let lit = 0, shaded = 0;
  for (let x = -30; x <= 30; x += 2) for (let z = -22; z <= 22; z += 2) { const v = grid.sample(x, z, 0); assert.ok(v >= 0 && v <= 1); if (v > 0.99) lit++; if (v < 0.01) shaded++; }
  assert.ok(lit > 50 && shaded > 20, `lit ${lit}, shaded ${shaded}`);
});

test('character patch scales only the directional light', () => {
  const patched = patchSunVisibilityFragment(THREE.ShaderLib.standard.fragmentShader);
  assert.ok(patched.includes('uniform float uSunVisibility;'));
  assert.ok(patched.includes('getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= uSunVisibility;'));
  assert.equal(patchSunVisibilityFragment(patched), patched);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx tsx --test tests/client/sun-visibility.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/game/SunVisibility.ts`**

```ts
import * as THREE from 'three';
import type { Vec3 } from '../../shared/protocol';
import { ARENA_HALF } from '../../shared/map';
import { SUN_DIRECTION } from './Atmosphere';

export interface SunVisibilityGrid { sample(x: number, z: number, y: number): number }
export interface SunVisibilityOptions { half?: number; cells?: number; heights?: [number, number]; sun?: Vec3 }

/** How much direct sun reaches a standing character, from the collision map the bake
 *  approximates. Two layers: ground level and the upper floor. Built once per world. */
export function buildSunVisibility(raycast: (origin: Vec3, direction: Vec3, limit: number) => number, options: SunVisibilityOptions = {}): SunVisibilityGrid {
  const half = options.half ?? ARENA_HALF, cells = options.cells ?? 64, heights = options.heights ?? [1.2, 4.6];
  const sun = options.sun ?? { x: SUN_DIRECTION.x, y: SUN_DIRECTION.y, z: SUN_DIRECTION.z };
  const limit = 200, step = (2 * half) / cells;
  const layers = heights.map(height => {
    const data = new Float32Array(cells * cells);
    for (let row = 0; row < cells; row++) for (let column = 0; column < cells; column++) {
      const origin = { x: -half + (column + 0.5) * step, y: height, z: -half + (row + 0.5) * step };
      data[row * cells + column] = raycast(origin, sun, limit) >= limit ? 1 : 0;
    }
    return data;
  });
  const read = (data: Float32Array, column: number, row: number) => data[THREE.MathUtils.clamp(row, 0, cells - 1) * cells + THREE.MathUtils.clamp(column, 0, cells - 1)];
  return {
    sample(x, z, y) {
      const data = layers[y >= 3.0 ? 1 : 0];
      const u = (x + half) / step - 0.5, v = (z + half) / step - 0.5;
      const c0 = Math.floor(u), r0 = Math.floor(v), fu = u - c0, fv = v - r0;
      const top = read(data, c0, r0) * (1 - fu) + read(data, c0 + 1, r0) * fu;
      const bottom = read(data, c0, r0 + 1) * (1 - fu) + read(data, c0 + 1, r0 + 1) * fu;
      return top * (1 - fv) + bottom * fv;
    },
  };
}

/** Characters keep the real-time sun, scaled by where they stand. */
export function patchSunVisibilityFragment(fragmentShader: string): string {
  if (fragmentShader.includes('uSunVisibility')) return fragmentShader;
  const begin = THREE.ShaderChunk.lights_fragment_begin
    .replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= uSunVisibility;');
  return fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uSunVisibility;')
    .replace('#include <lights_fragment_begin>', begin);
}

export function applySunVisibility(material: THREE.Material, uniform: { value: number }): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uSunVisibility = uniform;
    shader.fragmentShader = patchSunVisibilityFragment(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => 'kannon-sun-visibility-v1';
}
```

If `Vec3` is not exported from `shared/protocol`, import it from wherever `shared/physics.ts` imports it (`grep -n "Vec3" shared/physics.ts | head -1`).

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx tsx --test tests/client/sun-visibility.test.ts`
Expected: PASS. If the real-map test's counts fail, print `lit` and `shaded` and adjust only the thresholds after checking the numbers make sense (most of the street is sunlit; house interiors and the north side of buildings are shaded).

- [ ] **Step 5: Per-character material copies in `BlenderCharacter.ts`**

Add the import `import { applySunVisibility } from './SunVisibility';` and, next to `clonedMaterials`, `const sunVisibility = { value: 1 };`.

Replace the `recolored` mapping so every material is copied per character and patched:

```ts
        const recolored = materials.map(material => {
          const existing = materialCopies.get(material); if (existing) return existing;
          const copy = material.clone();
          if (/PlayerAccent/i.test(material.name) && copy instanceof THREE.MeshStandardMaterial) copy.color.set(color);
          applySunVisibility(copy, sunVisibility);
          clonedMaterials.push(copy); materialCopies.set(material, copy); return copy;
        });
```

Expose `sunVisibility` on the returned model object (find the `return {` of the factory and add `sunVisibility,`). Add `sunVisibility: { value: number }` to the model's exported interface/type so `GameView` can set it.

- [ ] **Step 6: Build and apply the grid in `GameView.ts`**

Imports: `import { buildSunVisibility, type SunVisibilityGrid } from './SunVisibility';` and `raycastMap` from `../../shared/physics` (already imported from there; extend the list).

Field: `private readonly sunVisibility: SunVisibilityGrid = buildSunVisibility(raycastMap);`

In the per-player update loop, next to the existing line `entry.shadow.position.set(rendered.x, shadowFloor + 0.018, rendered.z);`, add:

```ts
      entry.model.sunVisibility.value = this.sunVisibility.sample(rendered.x, rendered.z, rendered.y);
```

- [ ] **Step 7: Typecheck, tests, build, and look at it**

Run: `npm run typecheck && npm test && npm run build`
Expected: pass.

Run: `npm run graphics-test`, open http://127.0.0.1:5184/graphics-test.html, choose **Walk around**, walk the scout into a house interior and back out. Expected: the scout's lit side dims indoors and brightens outdoors with a soft transition across the doorway. Save a screenshot of each state to `art/source/town-v2/sun-visibility-indoor.png` and `-outdoor.png`.

- [ ] **Step 8: Commit**

```bash
git add src/game/SunVisibility.ts src/game/BlenderCharacter.ts src/game/GameView.ts tests/client/sun-visibility.test.ts art/source/town-v2/sun-visibility-indoor.png art/source/town-v2/sun-visibility-outdoor.png
git commit -m "Scale the sun on characters by collision-derived sun visibility

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Render tiers, player-following shadows, tier-aware assets

**Files:**
- Create: `src/game/RenderTiers.ts`
- Create: `tests/client/render-tiers.test.ts`
- Modify: `src/game/assets.ts` (URLs, warmup signature)
- Modify: `src/game/GameView.ts:117-130` (sun setup), `setSettings` at `:160-187`, frame loop
- Modify: `src/game/World.ts:34` (environment URL by tier)
- Modify: `src/App.tsx:115`
- Modify: `tests/client/assets.test.ts` if it asserts the old `warmArenaAssets()` signature

**Interfaces:**
- Produces:
  - `type Quality = 'auto' | 'high' | 'low'`
  - `interface RenderTier { name: 'phone' | 'desktop' | 'desktop-high'; textureTier: 'phone' | 'full'; shadowMapSize: 1024 | 2048; shadowHalfExtent: number; postprocessing: boolean; bloom: boolean; grassDensity: 0 | 1 | 2 }`
  - `renderTier(quality: Quality, touch: boolean, floatTargets: boolean): RenderTier`
  - `ARENA_ASSETS.environmentPhone`, `environmentAssetUrl(textureTier)`, `warmArenaAssets(textureTier: 'phone' | 'full')`.

- [ ] **Step 1: Write the failing tier test**

`tests/client/render-tiers.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTier } from '../../src/game/RenderTiers.js';

test('touch devices get the phone tier unless High is forced', () => {
  assert.deepEqual(renderTier('auto', true, true), { name: 'phone', textureTier: 'phone', shadowMapSize: 1024, shadowHalfExtent: 14, postprocessing: false, bloom: false, grassDensity: 0 });
  assert.equal(renderTier('low', true, true).name, 'phone');
  assert.equal(renderTier('high', true, true).name, 'desktop-high');
});

test('desktop auto adds post-processing only with float targets', () => {
  assert.deepEqual(renderTier('auto', false, true), { name: 'desktop', textureTier: 'full', shadowMapSize: 2048, shadowHalfExtent: 24, postprocessing: true, bloom: true, grassDensity: 1 });
  assert.equal(renderTier('auto', false, false).postprocessing, false);
  assert.equal(renderTier('low', false, true).name, 'phone');
});

test('high is the full desktop stack', () => {
  assert.deepEqual(renderTier('high', false, true), { name: 'desktop-high', textureTier: 'full', shadowMapSize: 2048, shadowHalfExtent: 24, postprocessing: true, bloom: true, grassDensity: 2 });
  assert.equal(renderTier('high', false, false).postprocessing, false);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx tsx --test tests/client/render-tiers.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/game/RenderTiers.ts`**

```ts
export type Quality = 'auto' | 'high' | 'low';
export interface RenderTier {
  name: 'phone' | 'desktop' | 'desktop-high';
  textureTier: 'phone' | 'full';
  shadowMapSize: 1024 | 2048;
  /** Metres either side of the local player covered by the character shadow map. */
  shadowHalfExtent: number;
  postprocessing: boolean;
  bloom: boolean;
  grassDensity: 0 | 1 | 2;
}

/** One place decides what each device renders. Environment lighting is always baked;
 *  the tiers differ in character shadows, screen effects, foliage and texture size. */
export function renderTier(quality: Quality, touch: boolean, floatTargets: boolean): RenderTier {
  if (quality === 'low' || (quality === 'auto' && touch)) {
    return { name: 'phone', textureTier: 'phone', shadowMapSize: 1024, shadowHalfExtent: 14, postprocessing: false, bloom: false, grassDensity: 0 };
  }
  const high = quality === 'high';
  return { name: high ? 'desktop-high' : 'desktop', textureTier: 'full', shadowMapSize: 2048, shadowHalfExtent: 24, postprocessing: floatTargets, bloom: floatTargets, grassDensity: high ? 2 : 1 };
}
```

- [ ] **Step 4: Run the tier test to see it pass**

Run: `npx tsx --test tests/client/render-tiers.test.ts`
Expected: PASS.

- [ ] **Step 5: Tier-aware asset URLs**

In `src/game/assets.ts` replace `ARENA_ASSETS` with:

```ts
export const ARENA_ASSETS = {
  character: '/models/scout.glb?v=scout-grounded-v1',
  environment: '/models/environment-refined.glb?v=kannon-town-graphics-v2',
  environmentPhone: '/models/environment-refined.glb?v=kannon-town-graphics-v2',
} as const;
export type TextureTier = 'phone' | 'full';
export const environmentAssetUrl = (tier: TextureTier) => tier === 'phone' ? ARENA_ASSETS.environmentPhone : ARENA_ASSETS.environment;
```

Both point at the current town until Task 7 ships a v2 file; the phone URL is switched then. Change `warmArenaAssets`:

```ts
export function warmArenaAssets(tier: TextureTier = 'full'): Promise<void> {
  if (import.meta.env?.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('graphics') === 'current') {
    return Promise.all([ARENA_ASSETS.character, VEHICLE_TEST_ASSETS.originalTown].map(getArenaAssetBuffer)).then(() => {});
  }
  return Promise.all([ARENA_ASSETS.character, environmentAssetUrl(tier)].map(getArenaAssetBuffer)).then(() => {});
}
```

In `src/App.tsx:115`, pass the tier: `warmArenaAssets(renderTier(settings.quality, touch, true).textureTier)` where `settings` is the loaded `Settings` and `touch` is `matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0` (same expression as `GameScreen.tsx:31`; hoist it into a small exported helper `isTouchDevice()` in `src/lib/storage.ts` and use it in both places). Import `renderTier` from `./game/RenderTiers`.

In `src/game/World.ts`, `createWorld` gains a `textureTier: TextureTier` parameter after `renderer` and line 34 becomes `getArenaAssetBuffer(environmentAssetUrl(textureTier))`. `GameView` passes `renderTier(this.settings.quality, this.options.input.isTouch, this.renderer.extensions.has('EXT_color_buffer_float')).textureTier`.

Run: `grep -n "warmArenaAssets" tests/client/assets.test.ts` and update any call to the new signature.

- [ ] **Step 6: Tier-driven `setSettings` and a player-following shadow frustum in `GameView.ts`**

Import `renderTier` and `type RenderTier`. Add field `private tier: RenderTier = renderTier('auto', false, false);`.

In the constructor, change the shadow camera to a tight box that follows the player (initial values are overwritten every frame):

```ts
    this.sun.shadow.camera.left = -24; this.sun.shadow.camera.right = 24;
    this.sun.shadow.camera.top = 24; this.sun.shadow.camera.bottom = -24;
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 120;
```

In `setSettings`, replace the block from `const mobile = this.options.input.isTouch;` through the `shadowSize` update with:

```ts
    const floatTargets = this.renderer.extensions.has('EXT_color_buffer_float');
    this.tier = renderTier(this.settings.quality, this.options.input.isTouch, floatTargets);
    this.renderer.shadowMap.enabled = true;
    const request = ++this.presentationRequest;
    if (this.tier.postprocessing && this.presentation) this.presentation.enabled = true;
    else if (this.tier.postprocessing) {
      void import('./Presentation').then(({ ArenaPresentation: Presentation }) => {
        if (this.disposed || request !== this.presentationRequest) return;
        this.presentation = new Presentation(this.renderer, this.scene, this.camera);
        this.presentation.resize(this.width, this.height);
      }).catch(() => { /* A failed optional enhancement leaves direct rendering available. */ });
    } else { this.presentation?.dispose(); this.presentation = null; }
    if (this.sun.shadow.mapSize.x !== this.tier.shadowMapSize) {
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
      this.sun.shadow.mapSize.set(this.tier.shadowMapSize, this.tier.shadowMapSize); this.sun.shadow.needsUpdate = true;
    }
    const extent = this.tier.shadowHalfExtent;
    this.sun.shadow.camera.left = -extent; this.sun.shadow.camera.right = extent;
    this.sun.shadow.camera.top = extent; this.sun.shadow.camera.bottom = -extent;
    this.sun.shadow.camera.updateProjectionMatrix();
```

In the frame method, before rendering and after the local player's rendered position is known (the same `rendered` used for the local entry), move the light so the shadow box is centred on the player and snapped to shadow-map texels to stop shimmer:

```ts
  private followShadow(center: THREE.Vector3) {
    const texel = (2 * this.tier.shadowHalfExtent) / this.sun.shadow.mapSize.x;
    const snapped = center.clone().divideScalar(texel).round().multiplyScalar(texel);
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(SUN_DIRECTION, 70);
    this.sun.target.updateMatrixWorld();
  }
```

Call `this.followShadow(localEntry.position)` once per frame when a local entry exists; otherwise leave the light where it is. Add `tier: this.tier.name` to `graphicsTestState()`.

- [ ] **Step 7: Typecheck, tests, build, and confirm behaviour**

Run: `npm run typecheck && npm test && npm run build`
Expected: pass.

Run: `npm run graphics-test`, open the comparison page in the touch layout (Chromium device emulation, 852×393) with Graphics set to Automatic. Expected: the scout still casts a shadow on the ground (previously Low disabled shadows), the shadow stays sharp while walking across the map, and the stats overlay reports the same or fewer draw calls than before. Capture `art/source/town-v2/tier-phone-shadow.png`.

- [ ] **Step 8: Commit**

```bash
git add src/game/RenderTiers.ts src/game/assets.ts src/game/World.ts src/game/GameView.ts src/App.tsx src/lib/storage.ts src/components/GameScreen.tsx tests/client/render-tiers.test.ts tests/client/assets.test.ts art/source/town-v2/tier-phone-shadow.png
git commit -m "Add render tiers with player-following character shadows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Style test — one street corner, baked, in the real renderer

This task needs the purchased kit from Task 1 and is the checkpoint that decides whether the full town is built.

**Files:**
- Create: `scripts/blender/bake_town_v2.py`
- Create: `scripts/blender/export_town_v2.py`
- Create: `art/source/style-test.blend` (hand-authored)
- Create: `art/source/town-v2/style-test-lightmaps.json` and `LM_0.png` (generated)
- Create: `public/models/style-test.glb`, `public/models/style-test-phone.glb` (generated)
- Modify: `src/vehicle-test/main.tsx:85-87` (add `?graphics=style-test`)
- Modify: `src/game/assets.ts` (`VEHICLE_TEST_ASSETS.styleTest`, `styleTestPhone`)
- Modify: `package.json` (scripts)
- Modify: `art/PURCHASED_ASSETS.md` (record the packs used)

**Interfaces:**
- Consumes: Task 2's guide file, Task 3's finish script and sidecar format, Task 4's runtime loader.
- Produces: `bake_town_v2.py` CLI `blender --background <blend> --python scripts/blender/bake_town_v2.py -- --out <dir> --atlas-size 2048 --samples 256`, writing `<dir>/LM_<n>.png` and `<dir>/<blend-stem>-lightmaps.json`. `export_town_v2.py` CLI `blender --background <blend> --python scripts/blender/export_town_v2.py -- --out <glb>`.

- [ ] **Step 1: Import the kit and build the corner**

Open `art/source/kannon-town-v2.blend`, **Save As** `art/source/style-test.blend`. Import the purchased house kit and props (File → Import → FBX or glTF), fix scale so a door is about 2.1 m tall, and assemble the **west house's street-facing corner, its garage, the front path, the adjoining road and kerb, the front yard, and six to ten props** on top of the `Guides_Collision` wireframes. Keep every visible wall inside or flush with its collision box; keep the west front door and garage door openings clear. Delete kit materials that use engine-specific node groups and rebuild them as Principled BSDF with the pack's base colour, normal and roughness maps. Ground surfaces use Poly Haven textures toned in the shader (desaturate 20 to 30%, lift value). Record every pack and texture in `art/PURCHASED_ASSETS.md` now.

Put all visible, static objects in a collection named `Static`. Anything that should not be lightmapped (none in the style test) would go in `Dynamic`.

- [ ] **Step 2: Write the bake script**

`scripts/blender/bake_town_v2.py`:

```python
"""Lightmap-unwrap the Static collection, split materials per atlas, bake combined lighting
with Cycles, and write the sidecar the finish script consumes.
blender --background <blend> --python scripts/blender/bake_town_v2.py -- --out <dir> [--atlas-size 2048] [--samples 256] [--per-atlas 40]
"""
import argparse, json, os, sys
import bpy

def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--atlas-size", type=int, default=2048)
    p.add_argument("--samples", type=int, default=256)
    p.add_argument("--per-atlas", type=int, default=40, help="objects per lightmap atlas")
    return p.parse_args(argv)

def static_meshes():
    col = bpy.data.collections.get("Static")
    assert col, "No 'Static' collection"
    return [o for o in col.all_objects if o.type == "MESH" and not o.hide_render]

def ensure_uv(obj):
    uvs = obj.data.uv_layers
    if "Lightmap" not in uvs:
        uvs.new(name="Lightmap")
    return uvs["Lightmap"]

def unwrap(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
        ensure_uv(o)
        o.data.uv_layers.active = o.data.uv_layers["Lightmap"]
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.lightmap_pack(PREF_CONTEXT="ALL_OBJECTS", PREF_PACK_IN_ONE=True, PREF_NEW_UV_LAYER=False, PREF_BOX_DIV=12, PREF_MARGIN_DIV=0.2)
    bpy.ops.object.mode_set(mode="OBJECT")

def split_materials(objects, suffix):
    """Materials shared across atlases get one copy per atlas so a material maps to one lightmap."""
    for o in objects:
        for slot in o.material_slots:
            mat = slot.material
            if not mat:
                continue
            name = f"{mat.name.split('__LM')[0]}__{suffix}"
            copy = bpy.data.materials.get(name) or mat.copy()
            copy.name = name
            slot.material = copy

def bake(objects, image, samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.bake.use_pass_direct = True
    scene.render.bake.use_pass_indirect = True
    scene.render.bake.use_pass_color = False       # lighting only; albedo stays in the material
    scene.render.bake.margin = 8
    scene.render.bake.use_clear = True
    for o in objects:
        for slot in o.material_slots:
            mat = slot.material
            mat.use_nodes = True
            nodes = mat.node_tree.nodes
            node = nodes.get("KannonBakeTarget") or nodes.new("ShaderNodeTexImage")
            node.name = "KannonBakeTarget"
            node.image = image
            uv = nodes.get("KannonBakeUV") or nodes.new("ShaderNodeUVMap")
            uv.name = "KannonBakeUV"
            uv.uv_map = "Lightmap"
            mat.node_tree.links.new(uv.outputs["UV"], node.inputs["Vector"])
            nodes.active = node
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, uv_layer="Lightmap", use_clear=True, margin=8)

def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    meshes = static_meshes()
    assert meshes, "Static collection has no meshes"
    for m in meshes:
        assert "Guides" not in [c.name for c in m.users_collection], f"{m.name} is a guide"
    groups = [meshes[i:i + args.per_atlas] for i in range(0, len(meshes), args.per_atlas)]
    sidecar = {"atlases": {}, "materials": {}}
    for index, group in enumerate(groups):
        atlas = f"LM_{index}"
        split_materials(group, atlas)
        unwrap(group)
        image = bpy.data.images.new(atlas, args.atlas_size, args.atlas_size, float_buffer=False)
        image.colorspace_settings.name = "sRGB"
        bake(group, image, args.samples)
        path = os.path.join(args.out, f"{atlas}.png")
        image.filepath_raw = path
        image.file_format = "PNG"
        image.save()
        sidecar["atlases"][atlas] = f"{atlas}.png"
        for o in group:
            for slot in o.material_slots:
                if slot.material:
                    # Remove the bake nodes so the export carries only the PBR graph.
                    for name in ("KannonBakeTarget", "KannonBakeUV"):
                        node = slot.material.node_tree.nodes.get(name)
                        if node:
                            slot.material.node_tree.nodes.remove(node)
                    sidecar["materials"][slot.material.name] = {"atlas": atlas, "intensity": 1.0}
    stem = os.path.splitext(os.path.basename(bpy.data.filepath))[0]
    with open(os.path.join(args.out, f"{stem}-lightmaps.json"), "w", encoding="utf-8") as f:
        json.dump(sidecar, f, indent=2)
    bpy.ops.wm.save_mainfile()
    print(f"Baked {len(groups)} atlas(es) for {len(meshes)} objects; {len(sidecar['materials'])} materials")

if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Write the export script**

`scripts/blender/export_town_v2.py`:

```python
"""Export the baked scene (Static collection plus Guides_Collision boxes as empties) to GLB.
blender --background <blend> --python scripts/blender/export_town_v2.py -- --out <glb>
"""
import argparse, sys
import bpy

def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    return p.parse_args(argv)

def main():
    args = parse_args()
    for col in bpy.data.collections:
        col.hide_render = not (col.name == "Static" or col.name == "Guides_Collision")
    # Collision guides export as nodes with extras so validators can find them; their meshes are excluded.
    for o in bpy.data.collections["Guides_Collision"].all_objects:
        o.hide_render = False
        o.display_type = "WIRE"
    bpy.ops.export_scene.gltf(
        filepath=args.out, export_format="GLB", use_renderable=True, use_visible=False,
        export_apply=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials="EXPORT", export_image_format="AUTO", export_extras=True,
        export_animations=False, export_cameras=False, export_lights=False,
        export_yup=True,
    )
    print(f"Exported {args.out}")

if __name__ == "__main__":
    main()
```

Guide boxes are exported so the validator (plan 2) can find `Collision_*` nodes with `sizeXYZ` extras, as the current validator does. Their mesh must not render: after export, the finish script's `prune()` keeps them because they have geometry, so in the Blender file set each guide box's material to none and, in `import_collision_layout.py`, add `obj["kannonGuide"] = True`. Task 4's traversal in `World.ts` hides any node whose `userData.kannonGuide` is true:

```ts
      if (object.userData.kannonGuide) { object.visible = false; return; }
```

Add that line at the top of the `gltf.scene.traverse` callback in `World.ts`, and add the `obj["kannonGuide"] = True` line to `add_box` in Task 2's script (re-run `npm run town-v2:guides` afterwards, then re-do the Save As for the style test).

- [ ] **Step 4: Add scripts and run the pipeline**

`package.json` scripts:

```json
"style-test:bake": "\"C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe\" --background art/source/style-test.blend --python scripts/blender/bake_town_v2.py -- --out art/source/town-v2 --atlas-size 2048 --samples 256",
"style-test:export": "\"C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe\" --background art/source/style-test.blend --python scripts/blender/export_town_v2.py -- --out art/source/town-v2/style-test-raw.glb",
"style-test:finish": "node scripts/blender/finish_town_v2.mjs --input art/source/town-v2/style-test-raw.glb --lightmaps art/source/town-v2/style-test-lightmaps.json --out public/models/style-test.glb --tier full --manifest art/source/town-v2/style-test-manifest.json && node scripts/blender/finish_town_v2.mjs --input art/source/town-v2/style-test-raw.glb --lightmaps art/source/town-v2/style-test-lightmaps.json --out public/models/style-test-phone.glb --tier phone --manifest art/source/town-v2/style-test-phone-manifest.json",
"style-test": "npm run style-test:bake && npm run style-test:export && npm run style-test:finish"
```

Run: `npm run style-test`
Expected: bake prints one atlas; export writes the raw GLB; finish prints two GLBs with `image/ktx2` textures and at least one lightmapped material. Open `art/source/town-v2/LM_0.png`: it should show soft sunlit and shaded regions, not black. Black means the bake target node was not active or the UV layer was wrong.

- [ ] **Step 5: Add the comparison-page mode**

In `src/game/assets.ts` `VEHICLE_TEST_ASSETS`, add `styleTest: '/models/style-test.glb', styleTestPhone: '/models/style-test-phone.glb'`.

In `src/vehicle-test/main.tsx` around line 85, add a `styleTest` branch selected by `new URLSearchParams(location.search).get('graphics') === 'style-test'`, producing `artwork: { environmentUrl: touchLayout ? VEHICLE_TEST_ASSETS.styleTestPhone : VEHICLE_TEST_ASSETS.styleTest }` for **After** and `{ environmentUrl: ARENA_ASSETS.environment }` for **Before**, so the same fifteen fixed cameras compare the current town with the style-test corner. Views whose camera does not see the corner still capture; only the west-house views matter for the verdict.

- [ ] **Step 6: Capture and measure**

Run: `npm run graphics-test`, open `http://127.0.0.1:5184/graphics-test.html?graphics=style-test`. Capture **Before** and **After** for `Main street`, `West house front`, `Garage` and `Third-person bus approach` on Desktop High and in the 852×393 touch layout on Automatic. Save to `docs/art/style-test-{view}-{before|after}-{desktop|phone}.png`. Run **Measure 20 s** on the touch layout, After, adaptation locked. Record FPS, 95th percentile frame time, draws, and both GLB sizes from the manifests in `docs/superpowers/plans/2026-09-09-style-test-results.md`.

Expected against the spec: phone 95th percentile ≤ 16.8 ms; draws ≤ 60; `style-test.glb` well under 30 MB (a corner should be a few MB). Report the numbers whatever they are.

- [ ] **Step 7: Typecheck, tests, build, asset checks**

Run: `npm run typecheck && npm test && npm run build && npm run test:assets`
Expected: pass. `test:assets` still validates the shipped `environment-refined.glb`; the style test is not shipped to gameplay yet.

- [ ] **Step 8: Commit**

```bash
git add package.json scripts/blender/bake_town_v2.py scripts/blender/export_town_v2.py scripts/blender/import_collision_layout.py art/source/style-test.blend art/source/kannon-town-v2.blend art/source/town-v2/ public/models/style-test.glb public/models/style-test-phone.glb src/game/assets.ts src/game/World.ts src/vehicle-test/main.tsx art/PURCHASED_ASSETS.md docs/art/style-test-*.png docs/superpowers/plans/2026-09-09-style-test-results.md
git commit -m "Add baked style-test corner with purchased kit and comparison mode

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 9: Checkpoint with Frank**

Show Frank the four After captures next to their Before captures and the phone numbers in plain words. He answers one question: build the whole town this way, adjust the look first, or stop. Plans for stages 3 to 6 are written only after a yes.

---

## Self-review notes

- Spec coverage: assets and provenance (Task 1), Blender guides (Task 2), lightmap extension, KTX2, Meshopt, tier-sized GLBs and manifest (Task 3), runtime loader and lightmapped shading (Task 4), sun-visibility probe (Task 5), tier table, character shadows on every tier, phone GLB selection (Task 6), bake and export scripts and the style-test checkpoint (Task 7). Full town, validator, scout re-skin, bloom/SMAA/LUT stack, foliage instancing, release evidence are deferred to later plans by design.
- Names used across tasks: `LIGHTMAP_EXTENSION`, `KannonLightmap`, `Lightmap`, `LightmapPlugin`, `applyLightmapShading`, `patchLightmapFragment`, `buildSunVisibility`, `SunVisibilityGrid.sample`, `patchSunVisibilityFragment`, `applySunVisibility`, `renderTier`, `RenderTier`, `TextureTier`, `environmentAssetUrl`, `warmArenaAssets(tier)`, `createWorld(renderer, textureTier, ...)`, `userData.kannonGuide`, sidecar `{ atlases, materials }`.
- Verified against the installed Three.js r185: `lights_fragment_begin` lists point lights before directional lights, the directional block reads `getDirectionalLightInfo( directionalLight, directLight );` then `RE_Direct( directLight, ... );`, the hemisphere line and `irradiance += lightMapIrradiance;` match the patch strings, and `GLTFLoader` plugins use `extendMaterialParams` with `parser.assignTexture(params, key, mapDef, colorSpace)`. `Vec3` is exported from `shared/protocol.ts`.
- Known API uncertainty: gltf-transform `ReaderContext.textures` / `setTextureInfo` and `toktx` option names. Each task names the file to check and forbids weakening the tests.
