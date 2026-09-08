"""Inspect the saved Blender source and render three keyed motion review frames."""
import bpy
import json
import math
from pathlib import Path
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/'art'/'source'
bpy.ops.wm.open_mainfile(filepath=str(SOURCE/'scout.blend'))
rig=bpy.data.objects['ScoutRig']
expected=['Idle','Walk','Run','Jump','Aim','Fire','Reload','Heal']
assert all(name in bpy.data.actions for name in expected)
assert len(rig.data.bones)==18
body=bpy.data.objects['scout_body']
assert all(len(v.groups)>0 for v in body.data.vertices),'Every character vertex must be bound to the skeleton.'
assert max(abs(sum(g.weight for g in v.groups)-1) for v in body.data.vertices)<.00001
assert len([v for v in body.data.vertices if len(v.groups)>1])>0,'Torso requires blended skin weights.'
for name in ['weapon_ar','weapon_shotgun','healing_item','muzzle']:assert name in bpy.data.objects
for track in rig.animation_data.nla_tracks:track.mute=True
scene=bpy.context.scene
scene.render.resolution_x=750;scene.render.resolution_y=900
scene.cycles.samples=24
checks=[]
for name,frame,weapon in [('Run',7,'weapon_ar'),('Reload',23,'weapon_ar'),('Heal',45,'healing_item')]:
    for item in ['weapon_ar','weapon_shotgun','healing_item']:bpy.data.objects[item].hide_render=item!=weapon
    action=bpy.data.actions[name]
    rig.animation_data.action=action
    if action.slots:rig.animation_data.action_slot=action.slots[0]
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    checks.append({'clip':name,'frame':frame,'right_hand_world':list(rig.matrix_world@rig.pose.bones['hand_r'].head),'left_foot_world':list(rig.matrix_world@rig.pose.bones['foot_l'].head)})
    scene.render.filepath=str(SOURCE/f'scout-{name.lower()}.png')
    bpy.ops.render.render(write_still=True)

# Inspect a complete gait cycle, not only the attractive mid-stride frame.
feet={}
for name in ['foot_l','foot_r']:
    group=body.vertex_groups[name]
    feet[name]=[v.co.copy() for v in body.data.vertices if any(g.group==group.index and g.weight>.9 for g in v.groups)]
contacts=[]
for name,frames in [('Walk',22),('Run',18)]:
    action=bpy.data.actions[name];rig.animation_data.action=action
    if action.slots:rig.animation_data.action_slot=action.slots[0]
    minima=[]
    for frame in range(1,frames+2):
        scene.frame_set(frame);bpy.context.view_layer.update()
        heights=[]
        for bone,vertices in feet.items():
            deformation=rig.pose.bones[bone].matrix@rig.data.bones[bone].matrix_local.inverted()
            heights.append(min((deformation@v).z for v in vertices))
        minima.append(min(heights))
    assert min(minima)>-.035, f'{name} boots penetrate the floor: {min(minima):.3f}m'
    assert max(minima)<.075, f'{name} must retain believable ground contact: {max(minima):.3f}m'
    contacts.append({'clip':name,'framesChecked':len(minima),'lowestBoot':min(minima),'highestContact':max(minima)})

# Render a real Blender contact sheet of baked poses. These are geometry snapshots,
# not raster composites; studio objects stay out of the shipping character export.
snapshots=[]
label_material=bpy.data.materials.new('Review lettering');label_material.diffuse_color=(.82,.84,.81,1)
poses=[('Walk',1,'weapon_ar'),('Walk',6,'weapon_ar'),('Walk',12,'weapon_ar'),('Walk',17,'weapon_ar'),
       ('Run',1,'weapon_ar'),('Run',5,'weapon_ar'),('Run',10,'weapon_ar'),('Run',14,'weapon_ar')]
for index,(name,frame,weapon) in enumerate(poses):
    action=bpy.data.actions[name];rig.animation_data.action=action
    if action.slots:rig.animation_data.action_slot=action.slots[0]
    scene.frame_set(frame);bpy.context.view_layer.update()
    depsgraph=bpy.context.evaluated_depsgraph_get();offset=Vector(((1.5-index%4)*1.35,0,(1-index//4)*2.25))
    for source in [body,bpy.data.objects[weapon]]:
        mesh=bpy.data.meshes.new_from_object(source.evaluated_get(depsgraph),depsgraph=depsgraph)
        obj=bpy.data.objects.new(f'Review_{index}_{source.name}',mesh);bpy.context.collection.objects.link(obj)
        obj.location=offset;obj.rotation_euler.z=-.28;snapshots.append(obj)
    bpy.ops.object.text_add(location=offset+Vector((0,.4,-.19)),rotation=(math.pi/2,0,math.pi))
    label=bpy.context.object;label.data.body=f'{name.upper()}  /  {frame:02}';label.data.align_x='CENTER';label.data.size=.095;label.data.materials.append(label_material);snapshots.append(label)
for name in ['scout_body','weapon_ar','weapon_shotgun','healing_item']:bpy.data.objects[name].hide_render=True
bpy.data.objects['StudioFloor'].hide_render=True
camera=scene.camera;camera.location=(.7,9,2.55);target=Vector((0,0,2.03));camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.ortho_scale=6.10
scene.render.resolution_x=1800;scene.render.resolution_y=1350;scene.cycles.samples=24
scene.render.filepath=str(SOURCE/'scout-motion-sheet.png');bpy.ops.render.render(write_still=True)
(SOURCE/'scout-animation-review.json').write_text(json.dumps({'weighted_vertices':len(body.data.vertices),'checks':checks,'gaitContacts':contacts},indent=2)+'\n')
print('SCOUT_ANIMATION_QA_COMPLETE '+json.dumps(checks))
