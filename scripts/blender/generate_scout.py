"""Original Kannon Scout geometry and rig, modeled and animated in Blender.

Run: blender --background --python scripts/blender/generate_scout.py
Units: metres. Blender +Y is forward; exported glTF -Z is forward, Y is up.
Walk/Run lower-body motion derives from the credited CMU 09_01 run capture.
Six other actions and weapon upper-body poses are original authored motion.
"""
import bpy
import math
import json
import sys
from pathlib import Path
from mathutils import Matrix, Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
from scout_locomotion import retarget_locomotion
from scout_export import export_scout

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public' / 'models'
SOURCE = ROOT / 'art' / 'source'
OUT.mkdir(parents=True, exist_ok=True)
SOURCE.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.context.preferences.filepaths.save_version=0
for data in bpy.data.materials: bpy.data.materials.remove(data)

def material(name, color, metallic=0.0, roughness=.5):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    shader = m.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Metallic'].default_value = metallic
    shader.inputs['Roughness'].default_value = roughness
    return m

armor = material('CeramicArmor', (.69, .665, .60), .18, .39)
accent = material('PlayerAccent', (.018, .12, .14), .28, .34)
pack_teal = material('PetrolTeal', (.014, .098, .109), .32, .39)
suit = material('WovenUndersuit', (.036, .045, .050), .02, .89)
rubber = material('FlexibleRubber', (.021, .027, .031), .05, .69)
gunmetal = material('Gunmetal', (.047, .055, .058), .7, .32)
steel = material('BrushedTitanium', (.29, .32, .33), .82, .3)
bronze = material('WarmBronze', (.39, .19, .053), .78, .31)
visor = material('Visor', (.012, .042, .047), .82, .105)
light = material('StatusLight', (.25, .83, .71), .2, .3)
light.node_tree.nodes.get('Principled BSDF').inputs['Emission Color'].default_value = (.1, .8, .55, 1)
light.node_tree.nodes.get('Principled BSDF').inputs['Emission Strength'].default_value = .5
white = material('Marking', (.86, .85, .74), .02, .55)
parts = []
weapon_parts = {'weapon_ar': [], 'weapon_shotgun': [], 'healing_item': []}
WEAPON_LIFT = .125

# Tactical rest pose: natural human limb lengths, both hands around the weapon.
bones = {
 'root': ((0,0,0), (0,0,.15), None),
 'pelvis': ((0,0,.91), (0,0,1.08), 'root'),
 'spine': ((0,0,1.08), (0,0,1.30), 'pelvis'),
 'chest': ((0,0,1.30), (0,0,1.49), 'spine'),
 'neck': ((0,0,1.49), (0,0,1.58), 'chest'),
 'head': ((0,0,1.58), (0,0,1.79), 'neck'),
 'upper_arm_r': ((.235,.015,1.46), (.285,.075,1.205), 'chest'),
 'forearm_r': ((.285,.075,1.205), (.145,.302,1.255), 'upper_arm_r'),
 'hand_r': ((.145,.302,1.255), (.135,.37,1.275), 'forearm_r'),
 'upper_arm_l': ((-.235,.015,1.46), (-.16,.25,1.25), 'chest'),
 'forearm_l': ((-.16,.25,1.25), (.095,.45,1.28), 'upper_arm_l'),
 'hand_l': ((.095,.45,1.28), (.135,.525,1.30), 'forearm_l'),
 'thigh_r': ((.105,0,.93), (.115,.015,.535), 'pelvis'),
 'shin_r': ((.115,.015,.535), (.12,0,.125), 'thigh_r'),
 'foot_r': ((.12,0,.125), (.12,.18,.065), 'shin_r'),
 'thigh_l': ((-.105,0,.93), (-.115,.015,.535), 'pelvis'),
 'shin_l': ((-.115,.015,.535), (-.12,0,.125), 'thigh_l'),
 'foot_l': ((-.12,0,.125), (-.12,.18,.065), 'shin_l'),
}
# Author the weapon at high ready, with equal human arm lengths and a visible
# elbow bend. The same 18 exported bones remain; Blender bakes the arm solve.
def elbow_for(shoulder, wrist, side, upper=.29, lower=.285):
    shoulder,wrist=Vector(shoulder),Vector(wrist)
    forward=wrist-shoulder;distance=forward.length;forward.normalize()
    bend=Vector((.65 if side=='r' else -.65,-.18,-1))
    bend=(bend-forward*bend.dot(forward)).normalized()
    along=(upper*upper-lower*lower+distance*distance)/(2*distance)
    return shoulder+forward*along+bend*math.sqrt(max(0,upper*upper-along*along))
for side in ['r','l']:
    hand,tip,parent=bones['hand_'+side]
    hand=Vector(hand)+Vector((0,0,WEAPON_LIFT));tip=Vector(tip)+Vector((0,0,WEAPON_LIFT))
    shoulder=Vector(bones['upper_arm_'+side][0]);elbow=elbow_for(shoulder,hand,side)
    bones['upper_arm_'+side]=(tuple(shoulder),tuple(elbow),'chest')
    bones['forearm_'+side]=(tuple(elbow),tuple(hand),'upper_arm_'+side)
    bones['hand_'+side]=(tuple(hand),tuple(tip),parent)
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
    fractions=[0,.12,.27,.43,.58,.72,.80,.87,.94,1]
    for i,fraction in enumerate(fractions):
        sample=fraction*(len(widths)-1);index=min(len(widths)-2,int(sample));blend=sample-index
        radius=widths[index]*(1-blend)+widths[index+1]*blend
        # Compression folds remain part of the tailored surface instead of separate joint rings.
        fold=([0,0,0,0,0,.001,-.004,.003,-.002,0][i])
        c=a.lerp(b,fraction)
        for j in range(n):
            angle=2*math.pi*j/n
            shaped=radius+fold*(.65+.35*math.sin(angle*2+.6))
            verts.append(tuple(c+side*math.cos(angle)*shaped+front*math.sin(angle)*shaped*.84))
    for i in range(len(fractions)-1):
        for j in range(n): faces.append((i*n+j,i*n+(j+1)%n,(i+1)*n+(j+1)%n,(i+1)*n+j))
    faces.extend([tuple(range(n-1,-1,-1)),tuple((len(fractions)-1)*n+j for j in range(n))])
    mesh=bpy.data.meshes.new(name); mesh.from_pydata(verts,[],faces); mesh.update()
    uv=mesh.uv_layers.new(name='Surface UV')
    for poly in mesh.polygons:
        for idx in poly.loop_indices:
            vi=mesh.loops[idx].vertex_index; uv.data[idx].uv=(vi%n/n,vi//n/(len(fractions)-1))
    obj=bpy.data.objects.new(name,mesh); bpy.context.collection.objects.link(obj)
    return register(obj,mat,bone)

def panel(name, center, width, height, depth, mat, bone, reverse=False, group=None, outline=None):
    """Closed, fitted ceramic plate: tapered silhouette, rolled rim and compound crown."""
    outline=outline or [(-.32,-.50),(.31,-.50),(.48,-.32),(.50,.22),(.31,.47),(-.22,.50),(-.49,.29),(-.46,-.30)]
    cx,cy,cz=center; facing=-1 if reverse else 1
    vertices=[];faces=[]
    for scale,d in [(1,0),(1,depth*.72),(.79,depth)]:
        vertices.extend((cx+x*width*scale,cy+facing*d,cz+z*height*scale) for x,z in outline)
    for ring in range(2):
        for j in range(8):
            k=(j+1)%8;faces.append((ring*8+j,ring*8+k,(ring+1)*8+k,(ring+1)*8+j))
    vertices.append((cx,cy+facing*depth*1.14,cz)); faces.append(tuple(range(7,-1,-1)))
    for j in range(8):faces.append((16+j,16+(j+1)%8,24))
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],faces);mesh.update()
    import bmesh
    bm=bmesh.new();bm.from_mesh(mesh);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(mesh);bm.free()
    obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj)
    obj=register(obj,mat,bone,group)
    bpy.context.view_layer.objects.active=obj;obj.select_set(True)
    normal=obj.modifiers.new('Area weighted ceramic normals','WEIGHTED_NORMAL');normal.keep_sharp=False;normal.weight=50
    bpy.ops.object.modifier_apply(modifier=normal.name);obj.select_set(False)
    return obj

def deltoid_shell(name, center, bone):
    """A compact closed armor dome shaped over the deltoid, with an integrated dark rim."""
    cx,cy,cz=center;sign=1 if cx>0 else -1
    verts=[];faces=[];segments=24;rings=7
    for inside in [False,True]:
        for row in range(rings):
            polar=.10+row/(rings-1)*1.94
            for j in range(segments):
                a=j/segments*math.tau
                width=.082-(.005 if inside else 0)
                # A shallow deltoid wrap, with a swept lower edge and flatter crown.
                verts.append((cx+sign*(math.cos(polar)*.022+math.sin(polar)*math.cos(a)*width),cy+math.sin(polar)*math.sin(a)*.096,cz+math.cos(polar)*(.085-(.005 if inside else 0))-.016*max(0,math.sin(a))))
    count=rings*segments
    for inner in range(2):
        offset=inner*count
        for row in range(rings-1):
            for j in range(segments):
                k=(j+1)%segments;face=(offset+row*segments+j,offset+row*segments+k,offset+(row+1)*segments+k,offset+(row+1)*segments+j)
                faces.append(face if inner==0 else tuple(reversed(face)))
    for row in [0,rings-1]:
        for j in range(segments):
            k=(j+1)%segments;faces.append((row*segments+j,row*segments+k,count+row*segments+k,count+row*segments+j))
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
    import bmesh
    bm=bmesh.new();bm.from_mesh(mesh);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(mesh);bm.free()
    obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj);register(obj,armor,bone)
    panel(name+'_rear_inset',(cx,cy-.095,cz+.008),.067,.033,.005,rubber,bone,True)
    panel(name+'_rear_identifier',(cx,cy-.102,cz+.009),.052,.012,.003,accent,bone,True)
    box(name+'_edge_clasp',(cx+sign*.078,cy-.014,cz-.012),(.014,.053,.031),bronze,bone,.005)
    return obj

# Flexible anatomically shaped base; no sphere mannequin joints.
torso=section_mesh('tailored_torso',[(0,-.008,1.01,.158,.107),(0,-.009,1.10,.162,.117),(0,-.005,1.20,.191,.137),(0,0,1.33,.222,.146),(0,-.004,1.43,.226,.132),(0,-.008,1.49,.156,.103)],suit,'spine',24)
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
    panel('knee_plate_'+side,(sign*.115,.048,.538),.112,.147,.042,armor,'shin_'+side)
    panel('knee_accent_'+side,(sign*.115,.098,.548),.048,.036,.004,bronze,'shin_'+side)
    shin=panel('shin_guard_'+side,(sign*.12,.046,.309),.133,.293,.054,armor,'shin_'+side)
    panel('shin_inset_'+side,(sign*.12,.109,.319),.036,.171,.004,rubber,'shin_'+side)
    for z,rx,ry in [(.195,.059,.064),(.45,.073,.076)]: section_mesh('shin_strap_'+side,[(sign*.12,0,z-.008,rx,ry),(sign*.12,0,z+.008,rx,ry)],rubber,'shin_'+side,20)
    # Shaped realistic combat boot with extended toe and layered sole.
    sole=box('boot_sole_'+side,(sign*.12,.057,.032),(.127,.273,.047),rubber,'foot_'+side,.011)
    for vertex in sole.data.vertices:
        y=vertex.co.y; taper=.86 if y<-.028 else 1-.08*max(0,(y-.12)/.075)
        vertex.co.x=sign*.12+(vertex.co.x-sign*.12)*taper
        vertex.co.z+=.008*max(0,(y-.13)/.065)
    section_mesh('boot_heel_'+side,[(sign*.12,-.031,.043,.054,.056),(sign*.12,-.035,.09,.057,.061),(sign*.12,-.022,.128,.049,.051)],rubber,'foot_'+side,20)
    section_mesh('boot_upper_'+side,[(sign*.12,.058,.044,.064,.126),(sign*.12,.061,.08,.063,.121),(sign*.12,.035,.115,.059,.094),(sign*.12,-.005,.158,.048,.056)],rubber,'foot_'+side,20)
    box('toe_cap_'+side,(sign*.12,.137,.093),(.110,.090,.027),armor,'foot_'+side,.013)
    section_mesh('boot_ankle_'+side,[(sign*.12,0,.07,.062,.070),(sign*.12,-.008,.13,.057,.06),(sign*.12,-.003,.20,.046,.05)],suit,'foot_'+side,16)
    for z,y in [(.116,.080),(.139,.051),(.161,.025)]: box('boot_lace_'+side,(sign*.12,y,z),(.071,.014,.009),rubber,'foot_'+side,.003)
    for yy in [-.05,.0,.055,.11,.175]: box('sole_tread_'+side,(sign*.12,yy,.014),(.137,.018,.014),gunmetal,'foot_'+side,.003)
    # Thigh armor occupies the outer/front face; cloth remains visible around it.
    thigh_outline=[(-.29,-.5),(.20,-.47),(.37,-.25),(.49,.30),(.31,.49),(-.37,.46),(-.48,.21),(-.42,-.21)]
    panel('thigh_shell_'+side,(sign*.144,.075,.749),.187,.321,.037,armor,'thigh_'+side,outline=thigh_outline)
    panel('thigh_insert_'+side,(sign*.164,.124,.813),.041,.038,.004,rubber,'thigh_'+side)
    panel('thigh_identifier_'+side,(sign*.127,.137,.705),.033,.045,.003,accent,'thigh_'+side)
    for z,rx,ry in [(.662,.097,.091),(.842,.105,.096)]: section_mesh('thigh_band_'+side,[(sign*.111,0,z-.008,rx,ry),(sign*.111,0,z+.008,rx,ry)],rubber,'thigh_'+side,20)
    box('outer_thigh_marker_'+side,(sign*.218,.039,.79),(.008,.071,.022),accent,'thigh_'+side,.003)
    # Anatomical upper arm armor and forearm hard shell align to skeleton.
    shoulder=Vector(bones['upper_arm_'+side][0])
    deltoid_shell('pauldron_'+side,shoulder+Vector((sign*.004,0,-.018)),'upper_arm_'+side)
    # Wrist guard follows forearm vector.
    a,b=Vector(bones['forearm_'+side][0]),Vector(bones['forearm_'+side][1]); center=a.lerp(b,.52)
    obj=panel('forearm_guard_'+side,center+Vector((0,.038,0)),.105,(b-a).length*.81,.032,armor,'forearm_'+side)
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
        middle=start+Vector((0,.025,.012 if side=='l' else -.015)); end=middle+Vector((0,-.002,.020 if side=='l' else -.027))
        tube('finger_'+side+str(f),start,middle,.010,suit,'hand_'+side,8,radius2=.009)
        tube('finger_tip_'+side+str(f),middle,end,.009,rubber,'hand_'+side,8,radius2=.007)
    tube('thumb_'+side,palm+Vector((-sign*.035,.003,0)),palm+Vector((-sign*.025,.036,-.027)),.013,suit,'hand_'+side,10,radius2=.010)

# Front cuirass is cut into sternum and lateral plates, with a clear dark collar.
for s in [-1,1]:
    panel('pectoral_shell',(s*.098,.130,1.388),.207,.207,.042,armor,'chest',outline=[(-.36,-.45),(.22,-.50),(.45,-.29),(.49,.14),(.28,.46),(-.24,.50),(-.49,.29),(-.43,-.22)])
    tube('pectoral_fastener',(s*.16,.162,1.436),(s*.16,.17,1.436),.005,gunmetal,'chest',8)
box('sternum_inset',(0,.154,1.365),(.015,.009,.139),rubber,'chest',.003)
box('sternum_badge',(.083,.184,1.406),(.048,.005,.011),accent,'chest',.003)
for z,width in [(1.262,.284),(1.216,.265),(1.170,.241)]:
    box('abdominal_armor',(0,.135,z),(width,.032,.039),armor,'spine',.008)
    box('abdominal_recess',(0,.154,z-.015),(width*.76,.004,.005),rubber,'spine',.002)
for s in [-1,1]:
    panel('lower_rib_plate',(s*.122,.094,1.205),.121,.122,.040,armor,'spine')
    # Back shoulder harness and pack mounting straps.
    box('shoulder_harness',(s*.152,-.059,1.414),(.055,.203,.056),rubber,'chest',.014,rotation=(0,s*.16,0))
    box('pack_clip',(s*.143,-.148,1.42),(.052,.031,.059),steel,'chest',.008)
    box('abdominal_flex',(s*.063,.108,1.105),(.105,.028,.036),rubber,'spine',.008)
    box('belt_pouch',(s*.143,.101,1.005),(.083,.055,.103),suit,'pelvis',.013,rotation=(0,0,s*.15))
    box('pouch_lid',(s*.143,.134,1.037),(.085,.012,.023),rubber,'pelvis',.006)
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
    panel('lumbar_segment',(0,-.107,1.095+i*.051),.251-i*.013,.044,.021,armor,'spine',True)
# Pack is the key silhouette seen by the over-shoulder camera.
panel('pack_mount',(0,-.12,1.334),.29,.351,.045,rubber,'chest',True)
panel('backpack_frame',(0,-.162,1.335),.258,.346,.059,armor,'chest',True)
panel('backpack_center',(-.012,-.229,1.35),.168,.280,.020,pack_teal,'chest',True)
panel('backpack_upper_latch',(-.012,-.252,1.46),.057,.030,.009,bronze,'chest',True)
panel('backpack_lower',(-.012,-.252,1.232),.102,.023,.006,gunmetal,'chest',True)
for s in [-1,1]:
    panel('pack_rail',(s*.107,-.220,1.334),.034,.252,.021,armor,'chest',True)
    panel('pack_player_identifier',(s*.107,-.246,1.371),.013,.079,.004,accent,'chest',True)
    tube('pack_service_line',(s*.097,-.205,1.21),(s*.097,-.21,1.477),.006,rubber,'chest',8)
for i in range(4):
    box('pack_cooling_fin',(.088,-.247,1.267+i*.023),(.022,.006,.008),gunmetal,'chest',.001)
box('pack_indicator',(-.026,-.257,1.411),(.073,.004,.006),light,'chest',.001)
for z in [1.244,1.434]:
    tube('pack_service_recess',(.09,-.242,z),(.09,-.252,z),.014,gunmetal,'chest',14)
    tube('pack_service_socket',(.09,-.252,z),(.09,-.255,z),.009,bronze,'chest',12)
for text,z,size in [('KANNON',1.378,.016),('S / 07',1.335,.021)]:
    bpy.ops.object.text_add(location=(-.016,-.255,z),rotation=(math.pi/2,0,0))
    obj=bpy.context.object;obj.name='pack_stencil';obj.data.body=text;obj.data.align_x='CENTER';obj.data.size=size;obj.data.extrude=.0001;obj.data.resolution_u=2
    bpy.ops.object.convert(target='MESH');register(bpy.context.object,white,'chest')
# Neck and original full helmet with several shell layers.
tube('neck_gaiter',(0,0,1.475),(0,0,1.603),.073,suit,'neck',20,radius2=.063)
collar=section_mesh('raised_armored_collar',[(0,0,1.468,.132,.106),(0,-.010,1.505,.123,.106),(0,-.017,1.542,.099,.087)],rubber,'chest',24)
for vertex in collar.data.vertices:
    vertex.co.z+=max(-.015,min(.019,-vertex.co.y*.20))
sphere('helmet_inner',(0,0,1.69),(.106,.113,.137),rubber,'head',24,16)
section_mesh('helmet_shell',[(0,-.015,1.601,.076,.078),(0,-.016,1.635,.103,.104),(0,-.014,1.713,.113,.118),(0,-.018,1.764,.107,.117),(0,-.021,1.805,.087,.096),(0,-.022,1.831,.049,.061),(0,-.022,1.839,.012,.018)],armor,'head',28)
# Curved visor patch follows the helmet instead of a flat block.
verts=[]; faces=[]; cols=20; rows=5
for i in range(rows):
    v=i/(rows-1); z=1.643+v*.090
    for j in range(cols+1):
        angle=-1.16+2.32*j/cols
        verts.append((math.sin(angle)*.108, .014+math.cos(angle)*(.116+.008*math.sin(v*math.pi)), z+.009*math.cos(angle)))
for i in range(rows-1):
    for j in range(cols):
        n=i*(cols+1)+j; faces.append((n,n+1,n+cols+2,n+cols+1))
mesh=bpy.data.meshes.new('visor_curved');mesh.from_pydata(verts,[],faces);mesh.update()
obj=bpy.data.objects.new('visor_curved',mesh);bpy.context.collection.objects.link(obj);register(obj,visor,'head')
for s in [-1,1]:
    tube('visor_integrated_brow',(0,.134,1.745),(s*.088,.082,1.736),.009,gunmetal,'head',8,radius2=.005)
panel('helmet_chin',(0,.089,1.614),.147,.053,.037,armor,'head')
for s in [-1,1]:
    box('helmet_cheek',(s*.087,.046,1.635),(.045,.104,.091),armor,'head',.017,rotation=(0,s*.20,s*.28))
    box('helmet_comms',(s*.110,-.005,1.674),(.026,.058,.070),gunmetal,'head',.011)
    box('helmet_comms_shell',(s*.125,-.005,1.674),(.012,.049,.059),armor,'head',.008)
    box('helmet_side_marker',(s*.110,-.028,1.751),(.013,.062,.032),accent,'head',.006)
for z in [1.643,1.654,1.665]:
    box('helmet_rear_vent',(0,-.115,z),(.075,.004,.004),rubber,'head',.001)
box('helmet_rear_light',(0,-.125,1.695),(.056,.003,.004),light,'head',.001)
for s in [-1,1]:
    points=[(s*.081,-.078,1.76),(s*.069,-.059,1.807),(s*.048,-.023,1.833),(s*.044,.026,1.826),(s*.068,.071,1.799)]
    for a,b in zip(points,points[1:]):tube('helmet_panel_seam',a,b,.0022,rubber,'head',6)
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
for objects in weapon_parts.values():
    for obj in objects:
        for vertex in obj.data.vertices: vertex.co.z+=WEAPON_LIFT

def consolidate_surfaces(objects):
    """Share one 1024x512 PBR atlas across cloth, ceramic, rubber and machined metals.

    Eight material tiles preserve their physical responses while removing per-material draws.
    Player identification, reflective visor and status emission remain independent materials.
    """
    import numpy as np
    materials=[armor,suit,rubber,gunmetal,steel,bronze,white,pack_teal]
    width,height,tile=1024,512,256
    base=np.ones((height,width,4),dtype=np.float32)
    normal=np.ones((height,width,4),dtype=np.float32);normal[:,:,:3]=(.5,.5,1)
    orm=np.ones((height,width,4),dtype=np.float32)
    yy,xx=np.mgrid[0:tile,0:tile];rng=np.random.default_rng(77)
    for index,mat in enumerate(materials):
        shader=mat.node_tree.nodes.get('Principled BSDF');color=shader.inputs['Base Color'].default_value[:3]
        rough=shader.inputs['Roughness'].default_value;metal=shader.inputs['Metallic'].default_value
        # Broad coating variation and fine directional grain. No baked lighting or shadows.
        wave=np.sin(xx*.072)*np.sin(yy*.089)*.012
        grain=rng.normal(0,.003,(tile,tile))
        woven=(np.sin(xx*math.pi/2)*np.sin(yy*math.pi/2)) if mat==suit else np.zeros_like(wave)
        wear=(np.minimum.reduce([xx,yy,tile-1-xx,tile-1-yy])<5)*(.02+.02*np.sin(xx*.7+yy*.9)) if mat==armor else 0
        y,x=(index//4)*tile,(index%4)*tile
        for channel in range(3):base[y:y+tile,x:x+tile,channel]=np.clip(color[channel]*(1+wave+grain+woven*.10)+wear,0,1)
        orm[y:y+tile,x:x+tile,1]=np.clip(rough+wave*3+grain*2-wear,0,1)
        orm[y:y+tile,x:x+tile,2]=metal
        heightfield=grain+wave*.15+woven*.013
        normal[y:y+tile,x:x+tile,0]=.5+heightfield
        normal[y:y+tile,x:x+tile,1]=.5+np.roll(heightfield,1,axis=0)
    atlas=material('ScoutSurface',(1,1,1),1,1)
    shader=atlas.node_tree.nodes.get('Principled BSDF')
    nodes={}
    for name,pixels,space in [('Coating',base,'sRGB'),('MicroNormal',normal,'Non-Color'),('MetalRoughness',orm,'Non-Color')]:
        img=bpy.data.images.new('Scout_'+name,width=width,height=height,alpha=False)
        img.colorspace_settings.name=space;img.pixels.foreach_set(pixels.ravel());img.pack()
        node=atlas.node_tree.nodes.new('ShaderNodeTexImage');node.image=img;nodes[name]=node
    atlas.node_tree.links.new(nodes['Coating'].outputs['Color'],shader.inputs['Base Color'])
    separate=atlas.node_tree.nodes.new('ShaderNodeSeparateColor')
    atlas.node_tree.links.new(nodes['MetalRoughness'].outputs['Color'],separate.inputs['Color'])
    atlas.node_tree.links.new(separate.outputs['Green'],shader.inputs['Roughness'])
    atlas.node_tree.links.new(separate.outputs['Blue'],shader.inputs['Metallic'])
    normalmap=atlas.node_tree.nodes.new('ShaderNodeNormalMap');normalmap.inputs['Strength'].default_value=.55
    atlas.node_tree.links.new(nodes['MicroNormal'].outputs['Color'],normalmap.inputs['Color'])
    atlas.node_tree.links.new(normalmap.outputs['Normal'],shader.inputs['Normal'])
    for obj in objects:
        original=obj.data.materials[0]
        uv=obj.data.uv_layers.active
        if original not in materials:
            if uv is None:uv=obj.data.uv_layers.new(name='Surface UV')
            uv.name='Surface UV'
            continue
        index=materials.index(original)
        if uv is None:
            uv=obj.data.uv_layers.new(name='Surface UV')
            for poly in obj.data.polygons:
                axes=sorted(range(3),key=lambda axis:abs(poly.normal[axis]))[:2]
                for loop_index in poly.loop_indices:
                    co=obj.data.vertices[obj.data.loops[loop_index].vertex_index].co
                    uv.data[loop_index].uv=(co[axes[0]]*3%1,co[axes[1]]*3%1)
        # Joined primitives must share one UV-layer name; otherwise Blender silently
        # creates separate layers and untextured components sample the ivory tile.
        uv.name='Surface UV'
        for loop in uv.data:
            u,v=loop.uv;loop.uv=((index%4+(6+min(1,max(0,u))*244)/tile)/4,(index//4+(6+min(1,max(0,v))*244)/tile)/2)
        obj.data.materials[0]=atlas
    return atlas

consolidate_surfaces(parts+[part for items in weapon_parts.values() for part in items])

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
muzzle.matrix_world.translation=(.135,.847,1.332+WEAPON_LIFT)
muzzle.empty_display_size=.025
muzzle_shotgun=bpy.data.objects.new('muzzle_shotgun',None);bpy.context.collection.objects.link(muzzle_shotgun)
muzzle_shotgun.parent=rig;muzzle_shotgun.parent_type='BONE';muzzle_shotgun.parent_bone='hand_r'
muzzle_shotgun.matrix_world.translation=(.135,.924,1.332+WEAPON_LIFT)
muzzle_shotgun.empty_display_size=.025

# Keyed combat poses preserve the feet at the origin. Locomotion is driven by game physics.
rig.animation_data_create()
fps=30
clips={}
READY_ROTATIONS={'pelvis':(0,13,0),'spine':(-9,4,0),'chest':(-2,0,0),'neck':(3,0,0),'head':(4,-12,0)}
READY_LOCATIONS={'pelvis':(0,-.050,-.012)}
def begin(name,frames):
    action=bpy.data.actions.new(name)
    rig.animation_data.action=action
    for p in rig.pose.bones:
        p.rotation_mode='XYZ';p.rotation_euler=(0,0,0);p.location=(0,0,0);p.scale=(1,1,1)
    clips[name]=(action,frames)
    return action
def key(frame,rotations={},locations={}):
    for name,p in rig.pose.bones.items():
        base=READY_ROTATIONS.get(name,(0,0,0));extra=rotations.get(name,(0,0,0))
        p.rotation_euler=tuple(math.radians(base[i]+extra[i]) for i in range(3))
        base=READY_LOCATIONS.get(name,(0,0,0));extra=locations.get(name,(0,0,0))
        p.location=tuple(base[i]+extra[i] for i in range(3))
        p.keyframe_insert('rotation_euler',frame=frame,group=name)
        p.keyframe_insert('location',frame=frame,group=name)

def pose_chain(frame, upper_name, lower_name, end_name, target, bend, orientation=None):
    """World-space two-bone solve baked into the original skeleton, with explicit end orientation."""
    bpy.context.view_layer.update()
    upper=rig.pose.bones[upper_name];lower=rig.pose.bones[lower_name];end_bone=rig.pose.bones[end_name]
    origin=upper.head.copy();target=Vector(target);direction=target-origin
    distance=min(direction.length,upper.length+lower.length-.0005);direction.normalize()
    bend=Vector(bend);bend=(bend-direction*bend.dot(direction)).normalized()
    along=(upper.length**2-lower.length**2+distance**2)/(2*distance)
    joint=origin+direction*along+bend*math.sqrt(max(0,upper.length**2-along**2))
    target=origin+direction*distance
    for pose,start,finish in [(upper,origin,joint),(lower,joint,target)]:
        rest=rig.data.bones[pose.name]
        rotation=(rest.tail_local-rest.head_local).rotation_difference(finish-start)@rest.matrix_local.to_quaternion()
        pose.matrix=Matrix.Translation(start)@rotation.to_matrix().to_4x4();bpy.context.view_layer.update()
    rotation=orientation or rig.data.bones[end_name].matrix_local.to_quaternion()
    end_bone.matrix=Matrix.Translation(target)@rotation.to_matrix().to_4x4()
    for pose in [upper,lower,end_bone]:
        pose.keyframe_insert('rotation_euler',frame=frame,group=pose.name)
        pose.keyframe_insert('location',frame=frame,group=pose.name)

def grip_weapon(frame, lift=0, kick=0, roll=0):
    # The body can turn and compress while the trigger hand, supporting hand and
    # rifle remain a connected assembly. Both hands retain their authored wrist angle.
    target=Vector(bones['hand_r'][0])+Vector((0,-kick*.024,lift+kick*.011))
    rotation=Matrix.Rotation(math.radians(kick*2.8),4,'X').to_quaternion()@Matrix.Rotation(math.radians(roll),4,'Y').to_quaternion()@rig.data.bones['hand_r'].matrix_local.to_quaternion()
    pose_chain(frame,'upper_arm_r','forearm_r','hand_r',target,(.7,-.2,-1),rotation)
    bpy.context.view_layer.update()
    transform=rig.pose.bones['hand_r'].matrix@rig.data.bones['hand_r'].matrix_local.inverted()
    target=transform@Vector(bones['hand_l'][0])
    rotation=transform.to_quaternion()@rig.data.bones['hand_l'].matrix_local.to_quaternion()
    pose_chain(frame,'upper_arm_l','forearm_l','hand_l',target,(-.65,.1,-1),rotation)

def planted_stance(frame, spread=.175, stagger=.080):
    for side,sign in [('r',1),('l',-1)]:
        orientation=Matrix.Rotation(math.radians(-sign*5),4,'Z').to_quaternion()@rig.data.bones['foot_'+side].matrix_local.to_quaternion()
        pose_chain(frame,'thigh_'+side,'shin_'+side,'foot_'+side,(sign*spread,-sign*stagger,.125),(0,1,0),orientation)

def place_support_hand(frame, target, blend=1):
    """Bake a two-bone reach into the existing rig; no runtime IK or extra bones."""
    bpy.context.view_layer.update()
    upper=rig.pose.bones['upper_arm_l'];fore=rig.pose.bones['forearm_l'];hand=rig.pose.bones['hand_l']
    origin=upper.head.copy();target=hand.head.lerp(Vector(target),blend)
    direction=target-origin;distance=min(direction.length,upper.length+fore.length-.003);direction.normalize()
    bend=Vector((-.2,.10,-.35));bend=(bend-direction*bend.dot(direction)).normalized()
    along=(upper.length**2-fore.length**2+distance**2)/(2*distance)
    elbow=origin+direction*along+bend*math.sqrt(max(0,upper.length**2-along**2))
    target=origin+direction*distance;hand_rotation=hand.matrix.to_quaternion()
    for pose,start,end in [(upper,origin,elbow),(fore,elbow,target)]:
        rest=rig.data.bones[pose.name]
        rotation=(rest.tail_local-rest.head_local).rotation_difference(end-start)@rest.matrix_local.to_quaternion()
        pose.matrix=Matrix.Translation(start)@rotation.to_matrix().to_4x4();bpy.context.view_layer.update()
    hand.matrix=Matrix.Translation(target)@hand_rotation.to_matrix().to_4x4()
    for pose in [upper,fore,hand]:
        pose.keyframe_insert('rotation_euler',frame=frame,group=pose.name)
        pose.keyframe_insert('location',frame=frame,group=pose.name)

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
    key(frame,{'spine':(phase*.55,0,phase*.35),'chest':(-phase*.3,0,0),'head':(0,phase*.8,phase*.35)}, {'chest':(0,phase*.002,0)})
    planted_stance(frame);grip_weapon(frame,lift=phase*.0015)
for name,frames,magnitude,bob in [('Walk',22,.78,.010),('Run',18,1,.019)]:
    begin(name,frames)
    # Contact, compression, support, toe-off, recovery, passing, swing and heel strike.
    # The asymmetric knee/ankle arcs avoid the old synchronized sine-wave mannequin gait.
    leg=[(28,-8,-16),(15,-26,9),(-8,-25,20),(-27,-38,27),(-24,-78,34),(10,-88,35),(35,-52,7),(36,-20,-13)]
    for index in range(17):
        phase=index/16*math.tau;s=math.sin(phase)
        rots={}
        for side,offset in [('r',0),('l',4)]:
            position=(index/2+offset)%8;i=int(position);blend=position-i
            angles=[leg[i][a]*(1-blend)+leg[(i+1)%8][a]*blend for a in range(3)]
            for bone,angle in zip(['thigh','shin','foot'],angles):rots[bone+'_'+side]=(angle*magnitude,0,(-2 if side=='r' else 2) if bone=='thigh' else 0)
        rots.update({'pelvis':(0,-8+3*s,2.6*s),'spine':(-6 if name=='Run' else -3,-1.4*s,-1.6*s),
                     'chest':(2,.5*s,-.6*s),'head':(3,-.5*s,0)})
        frame=1+frames*index/16
        key(frame,rots,{'pelvis':(0,abs(math.sin(phase*2))*bob,0)})
        ground_feet(frame,.006 if name=='Walk' else .006+.055*max(0,math.sin(phase*2))**4)
        grip_weapon(frame,lift=(-.035 if name=='Run' else -.008)+.007*math.sin(phase*2))
begin('Jump',30)
for frame,amount in [(1,0),(6,1),(14,.5),(23,.8),(31,0)]:
    key(frame,{'thigh_r':(22*amount,0,-4*amount),'thigh_l':(16*amount,0,4*amount),'shin_r':(-42*amount,0,0),'shin_l':(-33*amount,0,0),'foot_r':(12*amount,0,0),'foot_l':(10*amount,0,0),'spine':(-5*amount,0,0),'head':(4*amount,0,0)})
    grip_weapon(frame,lift=-.025*amount)
begin('Aim',60)
for frame,breath in [(1,0),(31,1),(61,0)]:
    key(frame,{'chest':(-2+breath*.2,0,0),'neck':(2,0,0),'head':(3,0,-2)}, {'pelvis':(0,-.008,-.004)})
    planted_stance(frame,.18,.085);grip_weapon(frame,lift=.038+breath*.001)
begin('Fire',6)
for frame,kick in [(1,0),(2,1),(3,.42),(5,.08),(7,0)]:
    key(frame,{'chest':(kick*2,0,0),'upper_arm_r':(-kick*2.8,0,0),'forearm_r':(kick*1.2,0,0),'upper_arm_l':(-kick*1.8,0,0),'head':(-kick*.6,0,0)}, {'chest':(0,0,kick*.007)})
    planted_stance(frame);grip_weapon(frame,kick=kick)
begin('Reload',54)
for frame,amount,target in [(1,0,None),(9,.65,(.095,.43,1.20)),(17,1,(.085,.40,1.125)),(25,1,(-.10,.18,1.045)),(33,1,(.065,.35,1.12)),(40,.9,(.10,.41,1.225)),(48,.3,(.095,.45,1.28)),(55,0,None)]:
    key(frame,{'upper_arm_r':(amount*6,amount*-5,amount*5),'forearm_r':(amount*-5,0,0),'hand_r':(0,amount*5,amount*-4),'head':(amount*7,0,amount*-2)})
    planted_stance(frame);grip_weapon(frame,lift=-amount*.035,roll=amount*-7)
    if target is not None:
        if frame!=25:target=Vector(target)+Vector((0,0,WEAPON_LIFT))
        place_support_hand(frame,target)
begin('Heal',90)
for frame,amount,pulse in [(1,0,0),(16,1,0),(31,1,1),(46,1,0),(61,1,1),(76,.8,0),(91,0,0)]:
    key(frame,{'upper_arm_r':(amount*6,amount*-4,amount*-7),'forearm_r':(amount*-12,0,0),'hand_r':(amount*10,0,0),'head':(amount*8,0,0)})
    planted_stance(frame);grip_weapon(frame,lift=-amount*.16,roll=amount*-8)
    if amount:
        bpy.context.view_layer.update();deform=rig.pose.bones['hand_r'].matrix@rig.data.bones['hand_r'].matrix_local.inverted()
        place_support_hand(frame,deform@Vector((.082,.316,1.352+WEAPON_LIFT-pulse*.012)),amount)

locomotion=retarget_locomotion(rig,body,clips,SOURCE/'motion'/'cmu-09')
(SOURCE/'scout-locomotion-review.json').write_text(json.dumps(locomotion,indent=2)+'\n')

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
for obj in [rig,body,muzzle,muzzle_shotgun,*weapons.values()]: obj.select_set(True)
bpy.context.view_layer.objects.active=rig
for obj in weapons.values(): obj.hide_render=False
export_review=export_scout(OUT/'scout.glb',rig,clips,dict(export_format='GLB',use_selection=True,export_yup=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_nla_strips=True,export_skins=True,export_all_influences=False,export_apply=False,export_lights=False,export_cameras=False,export_morph=False))
for name,obj in weapons.items(): obj.hide_render=name!='weapon_ar'
rig.animation_data.action=clips['Idle'][0]
if clips['Idle'][0].slots:rig.animation_data.action_slot=clips['Idle'][0].slots[0]
scene.frame_set(1);bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'scout.blend'))
scene.render.filepath=str(SOURCE/'scout-front.png');bpy.ops.render.render(write_still=True)
camera.location=(2.5,-3.2,1.9);point_at(camera,(0,.01,.97))
scene.render.filepath=str(SOURCE/'scout-back.png');bpy.ops.render.render(write_still=True)
stats={'vertex_count':sum(len(o.data.vertices) for o in [body,*weapons.values()]),'triangles':sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in [body,*weapons.values()]),'bones':len(bones),'animations':list(clips),'units':'metres','forward':'glTF -Z','up':'glTF +Y','source':'Original Blender geometry, rig, surfaces and six authored actions. Walk/Run lower-body motion derives from CMU 09_01, frames 15–103; see motion/cmu-09/CMU-USAGE-NOTICE.md.','animation_export':export_review}
(SOURCE/'scout-manifest.json').write_text(json.dumps(stats,indent=2)+'\n')
print('KANNON_ASSET_COMPLETE '+json.dumps(stats))
