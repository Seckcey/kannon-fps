"""Build locked, non-rendering guide collections from the authoritative map export.

Game coordinates are Y-up; Blender is Z-up. game (x, y, z) -> blender (x, -z, y).
Run:  blender --background --python scripts/blender/import_collision_layout.py -- --map <json> [--save <blend>] [--check]
"""
import argparse, json, math, os, sys
import bpy
from mathutils import Vector

SUN_GAME = Vector((-38.0, 52.0, 28.0)).normalized()          # src/game/Atmosphere.ts SUN_DIRECTION
OPENINGS = (  # scripts/blender/validate_town_graphics.mjs openings, game coordinates
    [(side * 8.5, 1.35, -2.25, f"{'east' if side > 0 else 'west'} front door") for side in (-1, 1)]
    + [(side * 8.5, 4.8, 0.0, f"{'east' if side > 0 else 'west'} upstairs window") for side in (-1, 1)]
    + [(side * 8.5, 1.35, 9.75, f"{'east' if side > 0 else 'west'} garage door") for side in (-1, 1)]
    + [(side * 23.5, 4.6, 4.2, f"{'east' if side > 0 else 'west'} balcony door") for side in (-1, 1)]
)


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


def add_box(col, name, x, y, z, w, h, d, extras=None):
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
    obj["kannonGuide"] = True      # the runtime hides guide nodes
    for key, value in (extras or {}).items():
        obj[key] = value
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
    sky.sky_type = "MULTIPLE_SCATTERING"  # Blender 5 physically based sky (Nishita successor)
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
        add_box(boxes, f"Collision_{o['id']}", o["x"], o["y"], o["z"], o["w"], o["h"], o["d"],
                {"kind": o.get("kind", "wall"), "surface": o.get("surface", "")})
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
    # A wall box's world-space size must equal the game box in every axis.
    bpy.context.view_layer.update()
    bounds = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    extent = [max(b[i] for b in bounds) - min(b[i] for b in bounds) for i in range(3)]
    assert all(abs(extent[i] - e) < 1e-6 for i, e in enumerate((sample["w"], sample["d"], sample["h"]))), extent
    if args.check:
        print(f"OK guides: {built} collision boxes, {len(map_data['spawns'])} spawns, {len(OPENINGS)} openings")
        return
    if args.save:
        target = os.path.abspath(args.save)
        bpy.ops.wm.save_as_mainfile(filepath=target)
        print(f"Saved {target}")


if __name__ == "__main__":
    main()
