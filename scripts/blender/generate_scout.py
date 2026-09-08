"""Original Kannon Scout, modeled and animated in Blender. No downloaded assets.

Run: blender --background --python scripts/blender/generate_scout.py
Units: metres. Blender +Y is forward; exported glTF -Z is forward, Y is up.
The animation is authored keyframe motion, not motion capture.
"""
import bpy
import math
import os
import json
import random
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public' / 'models'
SOURCE = ROOT / 'art' / 'source'
OUT.mkdir(parents=True, exist_ok=True)
SOURCE.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.context.preferences.filepaths.save_version=0
for data in bpy.data.materials: bpy.data.materials.remove(data)
random.seed(17)

def material(name, color, metallic=0.0, roughness=.5, texture=False):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    shader = m.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Metallic'].default_value = metallic
    shader.inputs['Roughness'].default_value = roughness
    if texture:
        import numpy as np
        size = 512
        rng = np.random.default_rng(17)
        yy, xx = np.mgrid[0:size, 0:size]
        grain = rng.normal(0, .012, (size, size))
        if name == 'WovenUndersuit': grain += .11*np.sin(xx*1.8)*np.sin(yy*1.8)
        variation = .945 + grain + .038*np.sin(xx*.03)*np.sin(yy*.034)
        # Sparse fine abrasion remains subtle at game distance.
        scratches = (rng.random((size, size)) > .9990)
        variation[scratches] -= .11
        pixels = np.ones((size, size, 4), dtype=np.float32)
        # Blender image data is stored in scene-linear values; exporter writes sRGB.
        for c in range(3): pixels[:, :, c] = np.clip(color[c] * variation, 0, 1)
        image = bpy.data.images.new(name + '_surface', width=size, height=size, alpha=False)
        image.pixels.foreach_set(pixels.ravel())
        image.pack()
        node = m.node_tree.nodes.new('ShaderNodeTexImage')
        node.image = image
        m.node_tree.links.new(node.outputs['Color'], shader.inputs['Base Color'])
        normal_pixels = np.ones((size,size,4),dtype=np.float32)
        normal_pixels[:,:,0] = .5 + grain*.8
        normal_pixels[:,:,1] = .5 + np.roll(grain,1,axis=0)*.8
        normal_pixels[:,:,2] = .998
        normal_image = bpy.data.images.new(name+'_micro_normal',width=size,height=size,alpha=False)
        normal_image.colorspace_settings.name='Non-Color'
        normal_image.pixels.foreach_set(normal_pixels.ravel());normal_image.pack()
        normal_tex=m.node_tree.nodes.new('ShaderNodeTexImage');normal_tex.image=normal_image
        normal_node=m.node_tree.nodes.new('ShaderNodeNormalMap');normal_node.inputs['Strength'].default_value=.65 if name=='WovenUndersuit' else .35
        m.node_tree.links.new(normal_tex.outputs['Color'],normal_node.inputs['Color'])
        m.node_tree.links.new(normal_node.outputs['Normal'],shader.inputs['Normal'])
    return m

armor = material('CeramicArmor', (.63, .595, .50), .12, .74, True)
accent = material('PlayerAccent', (.58, .096, .024), .11, .65)
suit = material('WovenUndersuit', (.028, .043, .052), .02, .86, True)
rubber = material('FlexibleRubber', (.021, .027, .031), .05, .69)
gunmetal = material('Gunmetal', (.065, .075, .081), .7, .49, True)
steel = material('BrushedTitanium', (.29, .32, .33), .82, .3)
visor = material('Visor', (.016, .14, .155), .67, .17)
light = material('StatusLight', (.25, .83, .71), .2, .3)
light.node_tree.nodes.get('Principled BSDF').inputs['Emission Color'].default_value = (.1, .8, .55, 1)
light.node_tree.nodes.get('Principled BSDF').inputs['Emission Strength'].default_value = .5
white = material('Marking', (.86, .85, .74), .02, .55)
parts = []
weapon_parts = {'weapon_ar': [], 'weapon_shotgun': [], 'healing_item': []}

# Tactical rest pose: natural human limb lengths, both hands around the weapon.
bones = {
 'root': ((0,0,0), (0,0,.15), None),
 'pelvis': ((0,0,.91), (0,0,1.08), 'root'),
 'spine': ((0,0,1.08), (0,0,1.30), 'pelvis'),
 'chest': ((0,0,1.30), (0,0,1.49), 'spine'),
 'neck': ((0,0,1.49), (0,0,1.58), 'chest'),
 'head': ((0,0,1.58), (0,0,1.79), 'neck'),
 'upper_arm_r': ((.235,.015,1.46), (.28,.065,1.18), 'chest'),
 'forearm_r': ((.28,.065,1.18), (.155,.32,1.24), 'upper_arm_r'),
 'hand_r': ((.155,.32,1.24), (.14,.41,1.26), 'forearm_r'),
 'upper_arm_l': ((-.235,.015,1.46), (-.28,.12,1.19), 'chest'),
 'forearm_l': ((-.28,.12,1.19), (-.05,.30,1.20), 'upper_arm_l'),
 'hand_l': ((-.05,.30,1.20), (.015,.365,1.23), 'forearm_l'),
 'thigh_r': ((.105,0,.93), (.115,.015,.535), 'pelvis'),
 'shin_r': ((.115,.015,.535), (.12,0,.125), 'thigh_r'),
 'foot_r': ((.12,0,.125), (.12,.18,.065), 'shin_r'),
 'thigh_l': ((-.105,0,.93), (-.115,.015,.535), 'pelvis'),
 'shin_l': ((-.115,.015,.535), (-.12,0,.125), 'thigh_l'),
 'foot_l': ((-.12,0,.125), (-.12,.18,.065), 'shin_l'),
}
armdata = bpy.data.armatures.new('ScoutSkeleton')
rig = bpy.data.objects.new('ScoutRig', armdata)
bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
for name, (head, tail, parent) in bones.items():
    b = armdata.edit_bones.new(name); b.head = head; b.tail = tail
    if parent: b.parent = armdata.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT')
rig.select_set(False)
rig.show_in_front = True

def register(obj, mat, bone, group=None):
    obj.data.materials.append(mat)
    if hasattr(obj.data, 'polygons'):
        for poly in obj.data.polygons: poly.use_smooth = True
    # Apply transforms before binding, so every component shares the rig's coordinates.
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.select_set(False)
    weight = obj.vertex_groups.new(name=bone)
    weight.add(list(range(len(obj.data.vertices))), 1, 'REPLACE')
    modifier = obj.modifiers.new('Scout Skin', 'ARMATURE'); modifier.object = rig
    obj.parent = rig
    if group: weapon_parts[group].append(obj)
    else: parts.append(obj)
    return obj

def sphere(name, center, scale, mat, bone, segments=20, rings=12, group=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=center)
    obj = bpy.context.object; obj.name = name; obj.scale = scale
    obj=register(obj, mat, bone, group)
    return obj

def box(name, center, scale, mat, bone, bevel=.009, rotation=None, group=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.object; obj.name = name; obj.scale = scale
    if rotation: obj.rotation_euler = rotation
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new('Machined edges', 'BEVEL'); mod.width = bevel; mod.segments = 1 if max(scale)<.11 else 2
        bpy.ops.object.modifier_apply(modifier=mod.name)
        mod = obj.modifiers.new('Weighted normals', 'WEIGHTED_NORMAL')
        bpy.ops.object.modifier_apply(modifier=mod.name)
    obj=register(obj, mat, bone, group)
    # Flat broad machined faces plus beveled edges avoid inflated toy-like shading.
    for poly in obj.data.polygons: poly.use_smooth=False
    return obj

def tube(name, a, b, radius, mat, bone, vertices=12, radius2=None, group=None):
    a, b = Vector(a), Vector(b)
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius, radius2=radius2 if radius2 is not None else radius, depth=(b-a).length, location=(a+b)/2)
    obj = bpy.context.object; obj.name = name
    obj.rotation_euler = (b-a).to_track_quat('Z','Y').to_euler()
    return register(obj, mat, bone, group)

def section_mesh(name, sections, mat, bone, segments=20):
    """Anatomical elliptical cross sections: (x,y,z, width, depth)."""
    verts, faces, uvs = [], [], []
    for ring, (x,y,z,rx,ry) in enumerate(sections):
        for j in range(segments):
            a=2*math.pi*j/segments
            verts.append((x+rx*math.cos(a), y+ry*math.sin(a), z))
            uvs.append((j/segments,ring/max(1,len(sections)-1)))
    for ring in range(len(sections)-1):
        for j in range(segments):
            n=ring*segments+j; nxt=ring*segments+(j+1)%segments
            faces.append((n,nxt,nxt+segments,n+segments))
    faces.append(tuple(range(segments-1,-1,-1)))
    faces.append(tuple((len(sections)-1)*segments+j for j in range(segments)))
    mesh=bpy.data.meshes.new(name); mesh.from_pydata(verts,[],faces); mesh.update()
    uv=mesh.uv_layers.new(name='Surface UV')
    for poly in mesh.polygons:
        for idx in poly.loop_indices: uv.data[idx].uv=uvs[mesh.loops[idx].vertex_index]
    obj=bpy.data.objects.new(name,mesh); bpy.context.collection.objects.link(obj)
    return register(obj,mat,bone)

def limb(name, bone, widths, mat=suit):
    a,b=Vector(bones[bone][0]),Vector(bones[bone][1]); axis=(b-a).normalized()
    side=Vector((1,0,0)); side=(side-axis*side.dot(axis)).normalized(); front=axis.cross(side)
    verts,faces=[],[]; n=16
    for i,radius in enumerate(widths):
        c=a.lerp(b,i/(len(widths)-1))
        for j in range(n):
            angle=2*math.pi*j/n
            verts.append(tuple(c+side*math.cos(angle)*radius+front*math.sin(angle)*radius*.84))
    for i in range(len(widths)-1):
        for j in range(n): faces.append((i*n+j,i*n+(j+1)%n,(i+1)*n+(j+1)%n,(i+1)*n+j))
    faces.extend([tuple(range(n-1,-1,-1)),tuple((len(widths)-1)*n+j for j in range(n))])
    mesh=bpy.data.meshes.new(name); mesh.from_pydata(verts,[],faces); mesh.update()
    uv=mesh.uv_layers.new(name='Surface UV')
    for poly in mesh.polygons:
        for idx in poly.loop_indices:
            vi=mesh.loops[idx].vertex_index; uv.data[idx].uv=(vi%n/n,vi//n/(len(widths)-1))
    obj=bpy.data.objects.new(name,mesh); bpy.context.collection.objects.link(obj)
    return register(obj,mat,bone)

def shoulder_cap(name, center, mat, bone):
    # Three independent machined shell plates follow the deltoid. Visible gaps are flex seams.
    cx,cy,cz=center;sign=1 if cx>0 else -1
    profile=[(-.087,.028),(-.059,.075),(.044,.072),(.088,.038),(.096,-.041),(.067,-.085)]
    result=None
    for index,(ya,yb,plate_mat) in enumerate([(-.113,-.061,armor),(-.055,.054,mat),(.060,.109,armor)]):
        verts=[];faces=[]
        for depth in [0,-.008]:
            for yy in [ya,yb]:
                for x,z in profile:verts.append((cx+sign*x,cy+yy,cz+z+depth))
        n=len(profile)
        for i in range(n-1):
            faces.append((i,i+1,n+i+1,n+i))
            faces.append((2*n+i,3*n+i,3*n+i+1,2*n+i+1))
            faces.append((i,2*n+i,2*n+i+1,i+1))
            faces.append((n+i,n+i+1,3*n+i+1,3*n+i))
        faces.extend([(0,n,3*n,2*n),(n-1,2*n-1,4*n-1,3*n-1)])
        if sign<0:faces=[tuple(reversed(f)) for f in faces]
        mesh=bpy.data.meshes.new(name+str(index));mesh.from_pydata(verts,[],faces);mesh.update()
        obj=bpy.data.objects.new(name+str(index),mesh);bpy.context.collection.objects.link(obj)
        bpy.context.view_layer.objects.active=obj;obj.select_set(True)
        bevel=obj.modifiers.new('Pauldron edge bevel','BEVEL');bevel.width=.002;bevel.segments=1
        bpy.ops.object.modifier_apply(modifier=bevel.name);obj.select_set(False)
        register(obj,plate_mat,bone)
        for face in obj.data.polygons:face.use_smooth=False
        result=obj
    # The player's camera sees this rear face. Close the shell with a contoured
    # pauldron plate instead of exposing the open cross-section of its roof strips.
    outline=profile+[(-.014,-.085),(-.058,-.036)]
    vertices=[]
    for yy in [-.108,-.120]:
        vertices.extend((cx+sign*x,cy+yy,cz+z) for x,z in outline)
    n=len(outline);vertices.append((cx+sign*.008,cy-.131,cz-.003))
    faces=[tuple(range(n-1,-1,-1))]
    for i in range(n):
        j=(i+1)%n;faces.extend([(i,j,j+n,i+n),(i+n,j+n,2*n)])
    mesh=bpy.data.meshes.new(name+'_rear_closed');mesh.from_pydata(vertices,[],faces);mesh.update()
    import bmesh
    bm=bmesh.new();bm.from_mesh(mesh);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(mesh);bm.free()
    obj=bpy.data.objects.new(name+'_rear_closed',mesh);bpy.context.collection.objects.link(obj)
    register(obj,armor,bone)
    for face in mesh.polygons:face.use_smooth=False
    box(name+'_rear_accent',(cx+sign*.019,cy-.134,cz+.016),(.072,.008,.041),mat,bone,.006)
    tube(name+'_rear_fastener',(cx+sign*.066,cy-.125,cz-.048),(cx+sign*.066,cy-.130,cz-.048),.006,steel,bone,10)
    return result

def chest_plate():
    # Separate fitted pectoral shells; the sternum remains an articulated dark seam.
    points=[(.014,1.445),(.062,1.470),(.153,1.461),(.192,1.413),(.175,1.324),(.090,1.299),(.014,1.326)]
    for sign in [-1,1]:
        front=[(sign*x,.172-max(0,x-.07)*.25,z) for x,z in points]
        verts=[(x,y-.013,z) for x,y,z in front]+front+[(sign*.093,.178,1.392)]
        n=len(points);faces=[]
        for i in range(n):
            j=(i+1)%n;faces.extend([(i,j,j+n,i+n),(i+n,j+n,2*n)])
        faces.append(tuple(range(n-1,-1,-1)))
        if sign<0:faces=[tuple(reversed(f)) for f in faces]
        mesh=bpy.data.meshes.new('pectoral_shell');mesh.from_pydata(verts,[],faces);mesh.update()
        obj=bpy.data.objects.new('pectoral_shell',mesh);bpy.context.collection.objects.link(obj)
        register(obj,armor,'chest')
        for face in mesh.polygons:face.use_smooth=False
        box('pectoral_seam',(sign*.114,.172,1.331),(.091,.008,.010),rubber,'chest',.002,rotation=(0,sign*.14,0))
        tube('chest_fastener',(sign*.162,.153,1.427),(sign*.162,.16,1.427),.006,steel,'chest',10)

# Flexible anatomically shaped base; no sphere mannequin joints.
torso=section_mesh('tailored_torso',[(0,0,1.01,.164,.107),(0,0,1.10,.174,.116),(0,0,1.20,.202,.128),(0,0,1.33,.227,.133),(0,0,1.43,.239,.122),(0,0,1.49,.17,.099)],suit,'spine')
torso.vertex_groups.clear()
spine_weights=torso.vertex_groups.new(name='spine');chest_weights=torso.vertex_groups.new(name='chest');pelvis_weights=torso.vertex_groups.new(name='pelvis')
for vertex in torso.data.vertices:
    z=vertex.co.z;cw=max(0,min(1,(z-1.22)/.22));pw=max(0,min(.6,(1.13-z)/.17));sw=1-cw-pw
    for g,w in [(spine_weights,sw),(chest_weights,cw),(pelvis_weights,pw)]:
        if w>0:g.add([vertex.index],w,'REPLACE')
section_mesh('pelvis_suit',[(0,0,.82,.15,.106),(0,0,.90,.179,.119),(0,0,.99,.173,.116),(0,0,1.065,.164,.108)],suit,'pelvis')
for side,sign in [('r',1),('l',-1)]:
    limb('upper_sleeve_'+side,'upper_arm_'+side,[.080,.088,.079,.063,.051])
    limb('forearm_fabric_'+side,'forearm_'+side,[.052,.055,.052,.043,.038])
    limb('tailored_thigh_'+side,'thigh_'+side,[.10,.113,.105,.089,.072])
    limb('calf_suit_'+side,'shin_'+side,[.068,.076,.082,.063,.046])
    # Woven flex zones, kneecaps, and layered ankle construction.
    knee=Vector(bones['shin_'+side][0])
    sphere('knee_flex_'+side,knee,(.065,.058,.061),rubber,'shin_'+side,16,10)
    box('knee_plate_'+side,(sign*.115,.067,.536),(.102,.044,.137),armor,'shin_'+side,.019)
    box('knee_accent_'+side,(sign*.115,.092,.554),(.070,.007,.028),accent,'shin_'+side,.004)
    shin=section_mesh('shin_guard_'+side,[(sign*.12,.035,.16,.05,.058),(sign*.12,.035,.25,.073,.073),(sign*.118,.037,.38,.086,.077),(sign*.117,.035,.46,.071,.065)],armor,'shin_'+side,20)
    box('shin_ridge_'+side,(sign*.12,.089,.325),(.017,.008,.224),steel,'shin_'+side,.004)
    for z in [.195,.45]: section_mesh('shin_strap_'+side,[(sign*.12,0,z-.012,.074,.079),(sign*.12,0,z+.012,.074,.079)],rubber,'shin_'+side,20)
    # Shaped realistic combat boot with extended toe and layered sole.
    box('boot_sole_'+side,(sign*.12,.057,.032),(.127,.273,.054),rubber,'foot_'+side,.014)
    box('boot_heel_'+side,(sign*.12,-.025,.074),(.126,.128,.087),rubber,'foot_'+side,.018)
    box('boot_toe_'+side,(sign*.12,.122,.078),(.124,.158,.073),armor,'foot_'+side,.014)
    section_mesh('boot_ankle_'+side,[(sign*.12,0,.07,.062,.070),(sign*.12,-.008,.13,.057,.06),(sign*.12,-.003,.20,.046,.05)],suit,'foot_'+side,16)
    for z,y in [(.116,.080),(.139,.051),(.161,.025)]: box('boot_lace_'+side,(sign*.12,y,z),(.071,.014,.009),rubber,'foot_'+side,.003)
    for yy in [-.05,.0,.055,.11,.175]: box('sole_tread_'+side,(sign*.12,yy,.014),(.137,.018,.014),gunmetal,'foot_'+side,.003)
    # Thigh armor occupies the outer/front face; cloth remains visible around it.
    box('thigh_shell_'+side,(sign*.147,.081,.749),(.14,.079,.253),armor,'thigh_'+side,.026,rotation=(0,sign*.06,0))
    box('thigh_insert_'+side,(sign*.147,.126,.777),(.092,.009,.116),rubber,'thigh_'+side,.009)
    for z in [.662,.842]: section_mesh('thigh_band_'+side,[(sign*.111,0,z-.013,.106,.10),(sign*.111,0,z+.013,.106,.10)],rubber,'thigh_'+side,20)
    box('outer_thigh_marker_'+side,(sign*.218,.039,.79),(.011,.071,.083),accent,'thigh_'+side,.004)
    # Anatomical upper arm armor and forearm hard shell align to skeleton.
    shoulder=Vector(bones['upper_arm_'+side][0])
    shoulder_cap('pauldron_'+side,shoulder+Vector((sign*.009,.001,-.004)),accent,'upper_arm_'+side)
    box('shoulder_edge_'+side,(sign*.31,.001,1.465),(.035,.181,.014),armor,'upper_arm_'+side,.005)
    box('bicep_plate_'+side,(sign*.319,.033,1.344),(.035,.093,.105),armor,'upper_arm_'+side,.008)
    # Wrist guard follows forearm vector.
    a,b=Vector(bones['forearm_'+side][0]),Vector(bones['forearm_'+side][1]); center=a.lerp(b,.52)
    obj=box('forearm_guard_'+side,center,(.125,.113,(b-a).length*.73),armor,'forearm_'+side,.017)
    # The box was bound in world coordinates; rotate its vertices around center.
    q=(b-a).to_track_quat('Z','Y')
    for vertex in obj.data.vertices: vertex.co = center + q @ (vertex.co-center)
    for p in [.18,.83]:
        ringcenter=a.lerp(b,p)
        tube('forearm_cuff_'+side,ringcenter-(b-a).normalized()*.012,ringcenter+(b-a).normalized()*.012,.061 if p<.5 else .047,rubber,'forearm_'+side,16)
    wrist=Vector(bones['hand_'+side][0]); tip=Vector(bones['hand_'+side][1])
    palm=(wrist+tip)/2
    sphere('glove_palm_'+side,palm,(.047,.057,.033),suit,'hand_'+side,16,10)
    box('glove_knuckles_'+side,tuple(palm+Vector((0,.015,.027))),(.072,.047,.018),gunmetal,'hand_'+side,.007)
    for knuckle in range(4):box('individual_knuckle_'+side,tuple(palm+Vector(((knuckle-1.5)*.017,.027,.035))),(.012,.018,.009),rubber,'hand_'+side,.004)
    # Four individually modeled curved glove fingers and a thumb.
    for f in range(4):
        start=tip+Vector(((f-1.5)*.017,-.012,.002))
        middle=start+Vector((0,.030,-.015)); end=middle+Vector((0,-.002,-.027))
        tube('finger_'+side+str(f),start,middle,.010,suit,'hand_'+side,8,radius2=.009)
        tube('finger_tip_'+side+str(f),middle,end,.009,rubber,'hand_'+side,8,radius2=.007)
    tube('thumb_'+side,palm+Vector((-sign*.035,.003,0)),palm+Vector((-sign*.025,.036,-.027)),.013,suit,'hand_'+side,10,radius2=.010)

# Front cuirass is cut into sternum and lateral plates, with a clear dark collar.
chest_plate()
box('sternum_inset',(0,.154,1.365),(.015,.009,.139),rubber,'chest',.003)
box('sternum_badge',(.083,.184,1.406),(.048,.005,.011),accent,'chest',.003)
for z,width in [(1.262,.284),(1.216,.265),(1.170,.241)]:
    box('abdominal_armor',(0,.135,z),(width,.032,.039),armor,'spine',.008)
    box('abdominal_recess',(0,.154,z-.015),(width*.76,.004,.005),rubber,'spine',.002)
for s in [-1,1]:
    box('pectoral_plate', (s*.181,.081,1.385),(.059,.070,.173),armor,'chest',.014,rotation=(0,s*.14,s*.18))
    box('lower_rib_plate',(s*.112,.108,1.19),(.103,.043,.105),armor,'spine',.019,rotation=(0,s*.08,s*.12))
    # Back shoulder harness and pack mounting straps.
    box('shoulder_harness',(s*.152,-.059,1.414),(.055,.203,.056),rubber,'chest',.014,rotation=(0,s*.16,0))
    box('pack_clip',(s*.143,-.148,1.42),(.052,.031,.059),steel,'chest',.008)
    box('abdominal_flex',(s*.063,.108,1.105),(.105,.028,.036),rubber,'spine',.008)
    box('belt_pouch',(s*.143,.101,1.005),(.092,.060,.115),armor,'pelvis',.011,rotation=(0,0,s*.15))
    box('pouch_lid',(s*.143,.14,1.037),(.095,.016,.033),rubber,'pelvis',.007)
    box('hip_plate',(s*.203,.015,.962),(.048,.130,.106),armor,'pelvis',.011)
box('belt_front',(0,.099,1.047),(.291,.041,.044),rubber,'pelvis',.008)
box('belt_buckle',(0,.131,1.047),(.063,.022,.043),steel,'pelvis',.006)
box('belt_buckle_insert',(0,.145,1.047),(.027,.004,.018),accent,'pelvis',.002)
box('rear_belt',(0,-.114,1.021),(.306,.04,.047),rubber,'pelvis',.009)
for side in [-1,1]:
    box('rear_utility_pouch',(side*.118,-.126,.978),(.093,.043,.105),suit,'pelvis',.010)
    box('rear_pouch_flap',(side*.118,-.151,1.014),(.097,.012,.03),rubber,'pelvis',.005)
    box('rear_pouch_clasp',(side*.118,-.16,.991),(.027,.005,.04),steel,'pelvis',.003)
for i in range(3):
    box('lumbar_segment',(0,-.119,1.095+i*.055),(.225,.048,.043),armor,'spine',.009)
# Pack is the key silhouette seen by the over-shoulder camera.
box('pack_mount',(0,-.122,1.345),(.285,.061,.307),rubber,'chest',.026)
box('backpack_frame',(0,-.164,1.348),(.249,.089,.302),armor,'chest',.025)
box('backpack_center',(0,-.219,1.363),(.144,.037,.205),gunmetal,'chest',.016)
box('backpack_top',(0,-.219,1.488),(.148,.037,.023),accent,'chest',.006)
box('backpack_lower',(0,-.221,1.225),(.132,.025,.039),accent,'chest',.006)
for s in [-1,1]:
    box('pack_rail',(s*.106,-.208,1.345),(.025,.036,.225),steel,'chest',.008)
    tube('pack_service_line',(s*.097,-.205,1.21),(s*.097,-.21,1.477),.006,rubber,'chest',8)
for i in range(5):
    box('pack_cooling_fin',(0,-.242,1.292+i*.021),(.108,.010,.006),rubber,'chest',.001)
box('pack_indicator',(0,-.243,1.454),(.053,.004,.009),light,'chest',.002)
# Neck and original full helmet with several shell layers.
tube('neck_gaiter',(0,0,1.475),(0,0,1.6),.074,suit,'neck',20,radius2=.064)
section_mesh('raised_armored_collar',[(0,0,1.468,.118,.104),(0,0,1.519,.110,.098),(0,0,1.543,.094,.085)],armor,'chest',24)
for z in [1.509,1.529,1.549]:
    bpy.ops.mesh.primitive_torus_add(major_radius=.071,minor_radius=.005,major_segments=24,minor_segments=6,location=(0,0,z))
    register(bpy.context.object,rubber,'neck')
sphere('helmet_inner',(0,0,1.69),(.106,.113,.137),rubber,'head',24,16)
section_mesh('helmet_shell',[(0,-.015,1.601,.076,.078),(0,-.016,1.635,.102,.103),(0,-.014,1.713,.112,.118),(0,-.019,1.778,.102,.111),(0,-.021,1.82,.072,.079),(0,-.022,1.839,.022,.031)],armor,'head',28)
# Curved visor patch follows the helmet instead of a flat block.
verts=[]; faces=[]; cols=20; rows=5
for i in range(rows):
    v=i/(rows-1); z=1.653+v*.077
    for j in range(cols+1):
        angle=-1.16+2.32*j/cols
        verts.append((math.sin(angle)*.108, .015+math.cos(angle)*.111, z+.010*math.cos(angle)))
for i in range(rows-1):
    for j in range(cols):
        n=i*(cols+1)+j; faces.append((n,n+1,n+cols+2,n+cols+1))
mesh=bpy.data.meshes.new('visor_curved');mesh.from_pydata(verts,[],faces);mesh.update()
obj=bpy.data.objects.new('visor_curved',mesh);bpy.context.collection.objects.link(obj);register(obj,visor,'head')
box('visor_brow',(0,.098,1.741),(.17,.049,.019),rubber,'head',.010)
box('helmet_chin',(0,.087,1.614),(.139,.064,.049),armor,'head',.017)
box('chin_vent',(0,.124,1.623),(.075,.011,.020),gunmetal,'head',.006)
for s in [-1,1]:
    box('helmet_cheek',(s*.087,.046,1.635),(.045,.104,.091),armor,'head',.017,rotation=(0,s*.20,s*.28))
    tube('helmet_comms',(s*.098,-.005,1.674),(s*.121,-.005,1.674),.044,gunmetal,'head',18)
    tube('helmet_comms_shell',(s*.12,-.005,1.674),(s*.126,-.005,1.674),.032,armor,'head',18)
    box('helmet_side_marker',(s*.110,-.028,1.751),(.013,.062,.032),accent,'head',.006)
box('helmet_rear_panel',(0,-.125,1.691),(.10,.018,.067),rubber,'head',.009)
box('helmet_rear_light',(0,-.136,1.706),(.050,.005,.010),light,'head',.002)
for x in [-.033,.033]: box('helmet_top_inset',(x,-.032,1.831),(.008,.050,.006),rubber,'head',.002)
# Recessed fasteners, suit seam piping, and equipment clasps give close views scale.
for s in [-1,1]:
    for z in [1.25,1.455]:
        tube('pack_recess',(s*.096,-.223,z),(s*.096,-.228,z),.008,rubber,'chest',10)
        tube('pack_fastener',(s*.096,-.228,z),(s*.096,-.231,z),.004,steel,'chest',8)
    for z in [.675,.826]:
        tube('thigh_screw',(s*.15,.123,z),(s*.15,.127,z),.005,gunmetal,'thigh_'+('r' if s==1 else 'l'),8)
    tube('tailored_seam',(s*.180,-.030,.845),(s*.183,-.022,.609),.0025,gunmetal,'thigh_'+('r' if s==1 else 'l'),6)
    box('shoulder_identification',(s*.298,.082,1.49),(.031,.007,.025),rubber,'upper_arm_'+('r' if s==1 else 'l'),.003)

# Weapons are proper modeled attachments bound to the right hand; not lines or boxes alone.
# Shared stock and receiver axis: forward +Y; weapon lower grip meets hand_r.
def weapon(group, shotgun=False):
    b='hand_r'; x=.135; z=1.307
    box(group+'_receiver',(x,.356,z),(.055,.210,.067),gunmetal,b,.010,group=group)
    box(group+'_upper',(x,.381,z+.044),(.044,.235,.026),steel,b,.006,group=group)
    box(group+'_stock',(x,.146,z+.004),(.061,.130,.084),rubber,b,.016,group=group)
    tube(group+'_stocktube',(x,.185,z+.017),(x,.255,z+.017),.015,gunmetal,b,12,group=group)
    box(group+'_buttpad',(x,.076,z+.003),(.069,.021,.094),rubber,b,.005,group=group)
    box(group+'_grip',(x,.327,z-.070),(.044,.051,.101),rubber,b,.010,rotation=(-.20,0,0),group=group)
    tube(group+'_trigger_guard',(x,.351,z-.041),(x,.401,z-.047),.006,gunmetal,b,8,group=group)
    tube(group+'_trigger_front',(x,.402,z-.048),(x,.396,z-.005),.006,gunmetal,b,8,group=group)
    box(group+'_ejection',(x+.029,.382,z+.008),(.007,.047,.023),rubber,b,.003,group=group)
    box(group+'_safety',(x+.033,.329,z+.012),(.007,.015,.007),accent,b,.002,group=group)
    barrel_end=.902 if shotgun else .825
    tube(group+'_barrel',(x,.466,z+.025),(x,barrel_end,z+.025),.017 if shotgun else .012,gunmetal,b,16,group=group)
    tube(group+'_muzzle',(x,barrel_end-.035,z+.025),(x,barrel_end+.020,z+.025),.021 if shotgun else .018,steel,b,16,group=group)
    tube(group+'_bore',(x,barrel_end+.0205,z+.025),(x,barrel_end+.022,z+.025),.011,rubber,b,12,group=group)
    if shotgun:
        tube(group+'_magazine_tube',(x,.437,z-.018),(x,.803,z-.018),.019,steel,b,12,group=group)
        box(group+'_pump',(x,.578,z-.006),(.066,.158,.069),accent,b,.014,group=group)
        for yy in [.520,.54,.56,.58,.6,.62,.64]: box(group+'_pump_rib',(x,yy,z-.004),(.068,.010,.072),rubber,b,.004,group=group)
    else:
        box(group+'_handguard',(x,.555,z+.023),(.061,.206,.065),armor,b,.012,group=group)
        for yy in [.485,.515,.545,.575,.605,.635]:
            box(group+'_vent',(x+.033,yy,z+.024),(.005,.017,.031),rubber,b,.004,group=group)
            box(group+'_rail',(x,yy,z+.061),(.055,.011,.011),gunmetal,b,.003,group=group)
        box(group+'_magazine',(x,.431,z-.082),(.044,.073,.13),rubber,b,.011,rotation=(-.14,0,0),group=group)
        for zz in [1.21,1.235,1.26]: box(group+'_mag_rib',(x+.024,.43,zz),(.005,.052,.009),steel,b,.002,group=group)
        box(group+'_sight_base',(x,.356,z+.072),(.054,.078,.012),gunmetal,b,.004,group=group)
        box(group+'_sight_left',(x-.026,.357,z+.098),(.009,.046,.049),gunmetal,b,.004,group=group)
        box(group+'_sight_right',(x+.026,.357,z+.098),(.009,.046,.049),gunmetal,b,.004,group=group)
        box(group+'_sight_top',(x,.357,z+.121),(.054,.046,.009),gunmetal,b,.004,group=group)
        box(group+'_sight_glass',(x,.367,z+.099),(.041,.006,.033),visor,b,.002,group=group)
weapon('weapon_ar')
weapon('weapon_shotgun',True)
box('healing_case',(.135,.38,1.275),(.119,.068,.174),armor,'hand_r',.017,group='healing_item')
box('healing_band',(.135,.417,1.275),(.124,.009,.041),accent,'hand_r',.006,group='healing_item')
box('healing_cross_h',(.135,.424,1.29),(.063,.005,.017),white,'hand_r',.003,group='healing_item')
box('healing_cross_v',(.135,.424,1.29),(.017,.005,.061),white,'hand_r',.003,group='healing_item')
box('healing_lid',(.135,.38,1.374),(.094,.054,.025),gunmetal,'hand_r',.007,group='healing_item')

def join_meshes(objects,name):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects: obj.select_set(True)
    bpy.context.view_layer.objects.active=objects[0]
    bpy.ops.object.join()
    obj=bpy.context.object;obj.name=name
    obj.select_set(False)
    return obj
body=join_meshes(parts,'scout_body')
weapons={name:join_meshes(objects,name) for name,objects in weapon_parts.items()}
for name,obj in weapons.items(): obj.hide_render=name!='weapon_ar'
# Bone-parented muzzle attachment. Local matrix is computed to retain rest transform.
bpy.context.view_layer.update()
muzzle=bpy.data.objects.new('muzzle',None);bpy.context.collection.objects.link(muzzle)
muzzle.parent=rig;muzzle.parent_type='BONE';muzzle.parent_bone='hand_r'
muzzle.matrix_world.translation=(.135,.847,1.332)
muzzle.empty_display_size=.025

# Keyed combat poses preserve the feet at the origin. Locomotion is driven by game physics.
rig.animation_data_create()
fps=30
clips={}
def begin(name,frames):
    action=bpy.data.actions.new(name)
    rig.animation_data.action=action
    for p in rig.pose.bones:
        p.rotation_mode='XYZ';p.rotation_euler=(0,0,0);p.location=(0,0,0);p.scale=(1,1,1)
    clips[name]=(action,frames)
    return action
def key(frame,rotations={},locations={}):
    for name,p in rig.pose.bones.items():
        p.rotation_euler=tuple(math.radians(v) for v in rotations.get(name,(0,0,0)))
        p.location=locations.get(name,(0,0,0))
        p.keyframe_insert('rotation_euler',frame=frame,group=name)
        p.keyframe_insert('location',frame=frame,group=name)

foot_vertices={}
for name in ['foot_l','foot_r']:
    group=body.vertex_groups.get(name)
    foot_vertices[name]=[v.co.copy() for v in body.data.vertices if any(g.group==group.index and g.weight>.9 for g in v.groups)]
def ground_feet(frame,clearance=.008):
    # Keep a planted boot on the floor in authored locomotion. World movement remains external.
    bpy.context.view_layer.update()
    minimum=100
    for name,vertices in foot_vertices.items():
        deform=rig.pose.bones[name].matrix @ rig.data.bones[name].matrix_local.inverted()
        minimum=min(minimum,min((deform@v).z for v in vertices))
    rig.pose.bones['pelvis'].location.y -= minimum-clearance
    rig.pose.bones['pelvis'].keyframe_insert('location',frame=frame,group='pelvis')

begin('Idle',90)
for frame,phase in [(1,0),(23,1),(46,0),(68,-1),(91,0)]:
    key(frame,{'spine':(phase*.55,0,phase*.35),'chest':(-phase*.3,0,0),'head':(0,phase*.8,phase*.35),'upper_arm_r':(phase*.2,0,0),'upper_arm_l':(-phase*.2,0,0)}, {'chest':(0,phase*.002,0)})
for name,frames,angle,knee,bob in [('Walk',32,20,30,.014),('Run',22,31,58,.024)]:
    begin(name,frames)
    for index in range(9):
        phase=index/8*math.tau;s=math.sin(phase);c=math.cos(phase)
        rots={'thigh_r':(angle*s,0,-2),'thigh_l':(-angle*s,0,2),
              'shin_r':(-max(0,-s)*knee,0,0),'shin_l':(-max(0,s)*knee,0,0),
              'foot_r':(max(0,-s)*knee*.42-angle*s*.22,0,0),'foot_l':(max(0,s)*knee*.42+angle*s*.22,0,0),
              'pelvis':(0,0,2.3*s),'spine':(-3 if name=='Run' else -1,0,-1.7*s),
              'chest':(0,1.2*s,-.7*s),'head':(0,-1.1*s,0),
              'upper_arm_r':(1.0*s,0,.6*s),'upper_arm_l':(-.7*s,0,.5*s)}
        frame=1+frames*index/8
        key(frame,rots,{'pelvis':(0,abs(math.cos(phase))*bob,0)})
        ground_feet(frame,.008 if name=='Walk' else .008+.018*abs(s)**4)
begin('Jump',30)
for frame,amount in [(1,0),(6,1),(14,.5),(23,.8),(31,0)]:
    key(frame,{'thigh_r':(22*amount,0,-4*amount),'thigh_l':(16*amount,0,4*amount),'shin_r':(-42*amount,0,0),'shin_l':(-33*amount,0,0),'foot_r':(12*amount,0,0),'foot_l':(10*amount,0,0),'spine':(-5*amount,0,0),'head':(4*amount,0,0)})
begin('Aim',60)
for frame,breath in [(1,0),(31,1),(61,0)]:
    key(frame,{'chest':(-3+breath*.2,0,0),'neck':(2,0,0),'head':(2,0,0),'upper_arm_r':(-3,0,0),'upper_arm_l':(-2,0,0)})
begin('Fire',8)
for frame,kick in [(1,0),(2,1),(4,.25),(9,0)]:
    key(frame,{'chest':(kick*1.6,0,0),'upper_arm_r':(-kick*3.5,0,0),'forearm_r':(kick*2,0,0),'upper_arm_l':(-kick*2,0,0),'head':(-kick*.6,0,0)})
begin('Reload',54)
for frame,amount,reach in [(1,0,0),(10,1,0),(23,1,1),(36,.8,.2),(47,.3,0),(55,0,0)]:
    key(frame,{'upper_arm_r':(amount*8,amount*-10,amount*9),'forearm_r':(amount*-8,0,0),'hand_r':(0,amount*9,amount*-6),'upper_arm_l':(amount*10,amount*6,-amount*9),'forearm_l':(-amount*17,reach*14,amount*15),'hand_l':(reach*22,0,reach*-12),'head':(amount*5,0,amount*-3)})
begin('Heal',90)
for frame,amount,pulse in [(1,0,0),(16,1,0),(31,1,1),(46,1,0),(61,1,1),(76,.8,0),(91,0,0)]:
    key(frame,{'upper_arm_r':(amount*6,amount*-4,amount*-7),'forearm_r':(amount*-12,0,0),'hand_r':(amount*10,0,0),'upper_arm_l':(amount*8,amount*6,amount*5),'forearm_l':(amount*-10,pulse*5,amount*8),'hand_l':(pulse*8,0,0),'head':(amount*8,0,0)})

# Each action gets a separate named NLA track; exporter emits all eight clips.
rig.animation_data.action=None
for name,(action,frames) in clips.items():
    track=rig.animation_data.nla_tracks.new();track.name=name
    strip=track.strips.new(name,1,action);strip.action_frame_start=1;strip.action_frame_end=frames+1
    track.mute=True

scene=bpy.context.scene
scene.render.fps=fps
scene.frame_set(1)
for p in rig.pose.bones:p.rotation_euler=(0,0,0);p.location=(0,0,0)
# A clean studio scene is saved with the source for review and future art iteration.
floor_mat=material('StudioGround',(.08,.11,.12),0,.85)
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.017))
floor=bpy.context.object;floor.name='StudioFloor';floor.data.materials.append(floor_mat)
def point_at(obj,point):obj.rotation_euler=(Vector(point)-obj.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(2.4,3.1,1.8))
camera=bpy.context.object;camera.name='StudioCamera';point_at(camera,(0,.02,.95));scene.camera=camera
camera.data.type='ORTHO';camera.data.ortho_scale=2.42;camera.data.lens=55
for name,loc,power,size,color in [('Key',(3,3,4),650,4,(1,.87,.72)),('Fill',(-3,2,2.7),470,3,(.65,.8,1)),('Rim',(0,-3,3.2),800,3,(.65,1,.93))]:
    bpy.ops.object.light_add(type='AREA',location=loc)
    obj=bpy.context.object;obj.name='Studio'+name;obj.data.energy=power;obj.data.shape='DISK';obj.data.size=size;obj.data.color=color;point_at(obj,(0,0,1))
scene.world.color=(.12,.12,.12)
scene.render.engine='CYCLES';scene.cycles.samples=32
scene.render.resolution_x=1000;scene.render.resolution_y=1200;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.view_settings.view_transform='AgX'
scene.render.film_transparent=False
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'scout.blend'))

# Export only gameplay objects; studio lights/floor/camera never ship.
bpy.ops.object.select_all(action='DESELECT')
for obj in [rig,body,muzzle,*weapons.values()]: obj.select_set(True)
bpy.context.view_layer.objects.active=rig
for obj in weapons.values(): obj.hide_render=False
bpy.ops.export_scene.gltf(filepath=str(OUT/'scout.glb'),export_format='GLB',use_selection=True,export_yup=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_nla_strips=True,export_skins=True,export_all_influences=False,export_apply=False,export_lights=False,export_cameras=False,export_morph=False)
for name,obj in weapons.items(): obj.hide_render=name!='weapon_ar'
scene.render.filepath=str(SOURCE/'scout-front.png');bpy.ops.render.render(write_still=True)
camera.location=(2.5,-3.2,1.9);point_at(camera,(0,.01,.97))
scene.render.filepath=str(SOURCE/'scout-back.png');bpy.ops.render.render(write_still=True)
stats={'vertex_count':sum(len(o.data.vertices) for o in [body,*weapons.values()]),'triangles':sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in [body,*weapons.values()]),'bones':len(bones),'animations':list(clips),'units':'metres','forward':'glTF -Z','up':'glTF +Y','source':'Original Blender geometry and hand-authored keyframe animations; no external assets or motion capture.'}
(SOURCE/'scout-manifest.json').write_text(json.dumps(stats,indent=2)+'\n')
print('KANNON_ASSET_COMPLETE '+json.dumps(stats))
