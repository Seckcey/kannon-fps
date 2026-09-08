"""Inspect the saved Blender source and render three keyed motion review frames."""
import bpy
import json
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
(SOURCE/'scout-animation-review.json').write_text(json.dumps({'weighted_vertices':len(body.data.vertices),'checks':checks},indent=2)+'\n')
print('SCOUT_ANIMATION_QA_COMPLETE '+json.dumps(checks))
