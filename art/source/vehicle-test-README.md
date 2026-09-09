# Editable vehicle graphics experiment

These reviewed vehicle sources are now included in the [town graphics release](../../docs/TOWN_GRAPHICS.md). This file retains their separate generation recipe.

This source changes only the yellow school bus and the two parked sedans in Kannon Town. The cargo truck and the authored town environment are not part of this export. Gameplay continues using the existing collision boxes in `shared/map.ts`.

## Reproduce

From the repository root in PowerShell:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --python scripts/blender/generate_vehicles.py
node scripts/blender/validate_vehicle_test.mjs
```

The generator uses Blender 5.2.1 and its bundled Python/NumPy. No downloads, network access, add-ons, external fonts or paid services are needed. It writes the editable `art/source/vehicle-test.blend`, procedural PNG/JPEG materials in `art/source/vehicle-materials/`, `public/models/vehicles-improved.glb`, and the measured `art/source/vehicle-test-manifest.json`. The seeded material generator is repeatable. Rebuilding can change Blender binary bookkeeping while retaining the same mesh/material content; use the validator and recorded export hash to identify a particular build.

The Blender file keeps one mesh per vehicle/material to match browser batching. Named vertex groups preserve parts such as formed body panels, wheel-well liners, roof, glazing, rims, handles and bumpers for editing. The authoring script retains their dimensional definitions. Parent objects are `Vehicle_bus`, `Vehicle_south` and `Vehicle_north`; their world-coordinate geometry exports with identity parent transforms.

## Model and material choices

The bus has a compound-curved roof, a tapered crowned hood, open wheel arches, liners, rounded tire carcasses, modeled tread details and dished steel wheels. Passenger glazing has individual rubber seals and sliding sash dividers. The nose has recessed louvers, a radiator opening, circular headlamps, turn signals and a heavy bumper. The rear has an emergency-door outline and separate rear lamps.

The sedans use crowned hood/deck panels, a sloping A/C-pillar profile, compound-curved roofs and windscreens, real wheel apertures, paired alloy-wheel spokes, door seams/handles, headlamp and tail-lamp assemblies, radiator openings, bumpers and small exhaust tips. Teal and gold preserve the original visual identity at each end of the map.

Paint uses generated base-color, metal/roughness and subtle enamel micro-normal textures with a restrained clearcoat. Tires use a separate rubber micro-normal and high roughness. Rubber, black polymer, brushed aluminum, wheel steel, glass and lenses have separate material values. Wear is limited to small lower-body/bumper marks.

Glass is an **opaque tinted PBR approximation** with environment reflections. This avoids alpha sorting and transmission cost; it does not show a detailed passenger interior. Mirrors are compact/folded to stay within the original collision widths. Every new vertex must fit the union of that vehicle's original collision boxes. Rounded corners and wheel arches therefore contain cosmetic inset space inside the unchanged rectangular collision: these are cover props, not enterable/drivable vehicles.

The GLB embeds its textures. The separate source textures and Blender file do not need to ship to players. Its 33 material batches allow independent before/after toggles for each vehicle; this increases draw calls over the old town-wide material batches. Materials use single-sided rendering and explicit outward face winding; source normals account for the bus coordinate-axis reflection. Actual browser download/frame measurements belong in the experiment report, rather than estimates from Blender.

## Provenance and licenses

All model geometry, glyph patterns, material maps and small wear marks are original procedural work authored for this repository. No stock vehicle model, scan, photograph, AI-generated image, third-party texture, commercial brand mark, or external font is included. No asset or service was purchased. There are no additional third-party asset license obligations. Blender and NumPy are build tools; their application/library licenses do not impose a license on the original rendered/model output.

The preview camera and lights in the `.blend` are authoring aids. Any generated `vehicle-test-BLENDER-preview.png` is explicitly a **Blender render**, not evidence of Three.js gameplay graphics. Review the live vehicle comparison and its actual browser captures for the finished test.
