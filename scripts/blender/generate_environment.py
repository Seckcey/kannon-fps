"""Author the original Sunbreak Relay environment and export its game-ready GLB.

Run from any directory with Blender 5.2: blender -b --python this_file.py
Coordinates in this script are game coordinates: metres, Y up, floor Y=0.
Only the conversion into Blender uses Z up. Existing authoritative map solids
are retained; relief is confined to a 4 cm surface envelope around those solids.
"""
import bpy
import bmesh
import json
import math
import random
import re
import tempfile
import time
from collections import defaultdict
from pathlib import Path
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'art' / 'source'
OUT = ROOT / 'public' / 'models'
MATERIALS = SOURCE / 'environment-materials'
for directory in [SOURCE, OUT, MATERIALS]: directory.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for material in list(bpy.data.materials):bpy.data.materials.remove(material)
bpy.context.preferences.filepaths.save_version = 0
random.seed(2407)
RNG = np.random.default_rng(2407)

def bv(point): return (point[0], -point[2], point[1])
def game(point): return (point[0], point[2], -point[1])
def mix(a,b,t): return tuple(a[i]*(1-t)+b[i]*t for i in range(len(a)))

def image(name, values, color=True):
    h,w = values.shape[:2]
    rgba = np.ones((h,w,4), np.float32)
    rgba[:,:,:values.shape[2]] = values
    result = bpy.data.images.new(name,width=w,height=h,alpha=values.shape[2]==4)
    result.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
    result.pixels.foreach_set(rgba.ravel())
    result.file_format = 'PNG'; result.filepath_raw = str(MATERIALS/(name+'.png'))
    result.save(); result.pack()
    return result

def surface(name, color, roughness=.8, metal=0, scale=3.0, kind='stone'):
    material = bpy.data.materials.new(name); material.use_nodes = True
    material.use_backface_culling = True
    material.diffuse_color = (*color,1)
    shader = material.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value=(*color,1)
    shader.inputs['Metallic'].default_value=metal; shader.inputs['Roughness'].default_value=roughness
    material['textureMetres']=scale
    return material

stone = surface('EnvLimestone',(.67,.59,.46),.86)
ground = surface('EnvGround',(.56,.49,.39),.89,scale=6.0)
petrol = surface('EnvPetrol',(.025,.105,.115),.45,.67,kind='metal')
bronze = surface('EnvBronze',(.38,.205,.085),.39,.8,kind='metal')
cliff = surface('EnvCliff',(.48,.46,.39),.95,scale=5.0)
bark = surface('EnvBark',(.16,.13,.085),.96,scale=1.2)
leaves = surface('EnvLeaves',(.14,.24,.065),.74,scale=1)
flower = surface('EnvFlower',(.40,.065,.18),.82,scale=1)
flower.use_backface_culling = False

def add_texture(material, base_image, normal_image=None, orm_image=None):
    tree=material.node_tree; shader=tree.nodes.get('Principled BSDF')
    tex=tree.nodes.new('ShaderNodeTexImage');tex.image=base_image
    tree.links.new(tex.outputs['Color'],shader.inputs['Base Color'])
    # Vertex tint supplies architectural grime/material variation without extra draws.
    attr=tree.nodes.new('ShaderNodeVertexColor');attr.layer_name='Color'
    multiply=tree.nodes.new('ShaderNodeMixRGB');multiply.blend_type='MULTIPLY';multiply.inputs[0].default_value=1
    tree.links.new(tex.outputs['Color'],multiply.inputs[1]);tree.links.new(attr.outputs['Color'],multiply.inputs[2]);tree.links.new(multiply.outputs[0],shader.inputs['Base Color'])
    if normal_image:
        normal_tex=tree.nodes.new('ShaderNodeTexImage');normal_tex.image=normal_image
        normal=tree.nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.55
        tree.links.new(normal_tex.outputs['Color'],normal.inputs['Color']);tree.links.new(normal.outputs['Normal'],shader.inputs['Normal'])
    if orm_image:
        packed=tree.nodes.new('ShaderNodeTexImage');packed.image=orm_image
        separate=tree.nodes.new('ShaderNodeSeparateColor');tree.links.new(packed.outputs['Color'],separate.inputs['Color'])
        tree.links.new(separate.outputs['Green'],shader.inputs['Roughness']);tree.links.new(separate.outputs['Blue'],shader.inputs['Metallic'])

def pbr_images(name, base, kind='stone', size=1024):
    yy,xx=np.mgrid[:size,:size]/size
    height=np.zeros((size,size),np.float32)
    for frequency,amplitude in [(2,.32),(5,.16),(11,.085),(31,.035),(79,.012),(191,.003)]:
        phase=RNG.uniform(0,6.28,4)
        height+=amplitude*np.sin(2*math.pi*(xx*frequency+yy*(frequency//2+1))+phase[0])*np.cos(2*math.pi*(yy*frequency-xx*(frequency//3+1))+phase[1])
    grain=RNG.normal(0,.008,(size,size)).astype(np.float32)
    height+=grain
    variation=np.clip(.93+height*.32,.65,1.16)
    if kind=='ground':
        # Three courses across a6m tile, staggered joints at human masonry scale.
        row=np.floor(yy*4); u=(xx*4+(row%2)*.5)%1; v=(yy*4)%1
        joint=np.minimum(np.minimum(u,1-u),np.minimum(v,1-v))
        grout=np.clip(joint/.014,0,1)
        variation*=.55+.45*grout; height-=.07*(1-grout)
    if kind=='metal': variation=np.clip(.97+height*.15,.77,1.12)
    color=np.stack([np.clip(base[c]*variation,0,1) for c in range(3)],axis=-1)
    # Finite differences are periodic, so the original authored normal tile is seamless.
    dx=(np.roll(height,-1,axis=1)-np.roll(height,1,axis=1))*2.5
    dy=(np.roll(height,-1,axis=0)-np.roll(height,1,axis=0))*2.5
    normal=np.stack([-dx,-dy,np.ones_like(dx)],axis=-1)
    normal/=np.linalg.norm(normal,axis=2,keepdims=True);normal=normal*.5+.5
    rough=np.clip((.46 if kind=='metal' else .84)+height*.14,.28,.98)
    orm=np.stack([np.ones_like(rough),rough,np.full_like(rough,.7 if kind=='metal' else 0)],axis=-1)
    return image(name+'_base',color),image(name+'_normal',normal,False),image(name+'_orm',orm,False)

metal_images=pbr_images('petrol',(.09,.25,.265),'metal',256)
def concept_surface(filename,name):
    path=SOURCE/'materials'/filename
    assert path.exists(),'Required generated source artwork is missing: '+str(path)
    artwork=bpy.data.images.load(str(path),check_existing=False)
    artwork.name=name+'_concept_base';artwork.scale(1024,1024)
    pixels=np.asarray(artwork.pixels[:],dtype=np.float32).reshape(1024,1024,4)
    luminance=pixels[:,:,:3] @ np.array([.2126,.7152,.0722],np.float32)
    dx=(np.roll(luminance,-1,axis=1)-np.roll(luminance,1,axis=1))*.65
    dy=(np.roll(luminance,-1,axis=0)-np.roll(luminance,1,axis=0))*.65
    normal=np.stack([-dx,-dy,np.ones_like(dx)],axis=-1)
    normal/=np.linalg.norm(normal,axis=2,keepdims=True)
    rough=np.clip(.88-(luminance-luminance.mean())*.12,.74,.97)
    orm=np.stack([np.ones_like(rough),rough,np.zeros_like(rough)],axis=-1)
    artwork.filepath_raw=str(MATERIALS/(name+'_concept_base.jpg'));artwork.file_format='JPEG';artwork.save();artwork.pack()
    normal_low=normal.reshape(512,2,512,2,3).mean(axis=(1,3));normal_low/=np.linalg.norm(normal_low,axis=2,keepdims=True)
    normal_image=image(name+'_concept_normal',normal_low*.5+.5,False)
    orm_image=image(name+'_concept_orm',orm.reshape(256,4,256,4,3).mean(axis=(1,3)),False)
    return artwork,normal_image,orm_image
stone_images=concept_surface('sunbreak-limestone-v2.png','limestone')
ground_images=concept_surface('sunbreak-paving-v2.png','courtyard')
add_texture(stone,*stone_images);add_texture(ground,*ground_images);add_texture(petrol,*metal_images)
add_texture(cliff,*stone_images)
cliff.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.96

# Leaf atlas is original procedural botanical artwork: one olive-like branching
# sprig, individual pointed leaves and pale midribs. It is not a solid canopy blob.
size=512; yy,xx=np.mgrid[:size,:size]/(size-1)
leaf_pixels=np.zeros((size,size,4),np.float32)
def ellipse_leaf(cx,cy,length,width,angle,tint):
    dx=xx-cx;dy=yy-cy;u=dx*math.cos(angle)+dy*math.sin(angle);v=-dx*math.sin(angle)+dy*math.cos(angle)
    shape=(np.abs(u/(length/2))**1.35+(v/(width/2))**2)<1
    rib=np.exp(-np.square(v/(width*.045)))*.09
    light=np.clip(.8+.23*u/length+rib+RNG.normal(0,.012,xx.shape),.55,1.15)
    for c in range(3):leaf_pixels[:,:,c][shape]=np.asarray(tint[c]*light)[shape]
    leaf_pixels[:,:,3][shape]=1
stem=(abs(xx-(.48+.06*np.sin(yy*3)))<.006)&(yy>.08)&(yy<.94)
leaf_pixels[stem]=(.29,.31,.14,1)
for i in range(7):
    cy=.14+i*.105
    for side in [-1,1]:
        warmth=.016 if (i+(side>0))%3==0 else 0
        ellipse_leaf(.5+side*(.14-.065*i/7),cy,.31-.11*i/7,.09,side*.67,(.38+i*.008+warmth,.52+i*.007,.19+i*.004))
ellipse_leaf(.505,.88,.24,.085,math.pi/2,(.44,.57,.22))
leaf_image=image('olive_sprig',leaf_pixels)
leaf_tree=leaves.node_tree;leaf_shader=leaf_tree.nodes.get('Principled BSDF')
leaf_tex=leaf_tree.nodes.new('ShaderNodeTexImage');leaf_tex.image=leaf_image
leaf_tree.links.new(leaf_tex.outputs['Color'],leaf_shader.inputs['Base Color']);leaf_tree.links.new(leaf_tex.outputs['Alpha'],leaf_shader.inputs['Alpha'])
leaves.surface_render_method='DITHERED';leaves.use_backface_culling=False
leaves['alphaMode']='MASK';leaves['alphaCutoff']=.5

# Geometry is accumulated per scene group/material before object creation. This
# retains indexed meshes and a bounded number of material draws in the GLB.
meshes=defaultdict(lambda:{'v':[],'f':[],'uv':[],'color':[],'normal':[]})
def geometry(group,material,vertices,faces,uvs=None,tint=(1,1,1,1),lighting_normal=None):
    target=meshes[(group,material.name)];start=len(target['v'])
    target['v'].extend(bv(v) for v in vertices)
    target['f'].extend(tuple(start+i for i in face) for face in faces)
    if uvs is None:
        scale=material.get('textureMetres',3.0)
        uvs=[(v[0]/scale,v[2]/scale) for v in vertices]
    target['uv'].extend(uvs)
    target['normal'].extend([lighting_normal]*len(vertices))
    if isinstance(tint[0],(float,int)):target['color'].extend([tint]*len(vertices))
    else:target['color'].extend(tint)

def box(group,material,center,size,bevel=0,tint=(1,1,1,1)):
    if bevel:
        bm=bmesh.new();bmesh.ops.create_cube(bm,size=1)
        for v in bm.verts:v.co.x*=size[0];v.co.y*=size[2];v.co.z*=size[1]
        bmesh.ops.bevel(bm,geom=list(bm.edges),offset=min(bevel,min(size)*.2),segments=1,affect='EDGES')
        bm.verts.ensure_lookup_table();bm.verts.index_update()
        vertices=[(v.co.x+center[0],v.co.z+center[1],-v.co.y+center[2]) for v in bm.verts]
        faces=[tuple(v.index for v in face.verts) for face in bm.faces];bm.free()
    else:
        x,y,z=center;w,h,d=[v/2 for v in size]
        vertices=[(x-w,y-h,z-d),(x+w,y-h,z-d),(x+w,y-h,z+d),(x-w,y-h,z+d),(x-w,y+h,z-d),(x+w,y+h,z-d),(x+w,y+h,z+d),(x-w,y+h,z+d)]
        faces=[(0,1,2,3),(4,7,6,5),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]
    # Split UVs by face orientation for proper metre-scaled tiling on all walls.
    for face in faces:
        pts=[vertices[i] for i in face];normal=(Vector(pts[1])-Vector(pts[0])).cross(Vector(pts[2])-Vector(pts[0]))
        axis=max(range(3),key=lambda i:abs(normal[i]));scale=material.get('textureMetres',3)
        uv=[((p[2] if axis==0 else p[0])/scale,(p[2] if axis==1 else p[1])/scale) for p in pts]
        geometry(group,material,pts,[tuple(range(len(pts)))],uv,tint)

def cylinder(group,material,center,radius,height,segments=16,top_radius=None,tint=(1,1,1,1)):
    top_radius=radius if top_radius is None else top_radius
    vertices=[];uv=[]
    for level,r in [(-height/2,radius),(height/2,top_radius)]:
        for i in range(segments):
            angle=i*math.tau/segments;vertices.append((center[0]+r*math.cos(angle),center[1]+level,center[2]+r*math.sin(angle)));uv.append((i/segments,height/material.get('textureMetres',3)*(level/height+.5)))
    faces=[tuple(range(segments-1,-1,-1)),tuple(range(segments,segments*2))]
    faces += [(i,(i+1)%segments,(i+1)%segments+segments,i+segments) for i in range(segments)]
    geometry(group,material,vertices,[tuple(reversed(face)) for face in faces],uv,tint)

def branch(group,start,end,r0,r1,segments=7,tint=(1,1,1,1)):
    a=Vector(start);b=Vector(end);direction=(b-a).normalized();right=direction.cross(Vector((0,1,0)))
    if right.length<.1:right=direction.cross(Vector((1,0,0)))
    right.normalize();up=direction.cross(right).normalized()
    verts=[];uv=[]
    for center,r,v in [(a,r0,0),(b,r1,(b-a).length)]:
        for i in range(segments):
            p=center+(right*math.cos(i*math.tau/segments)+up*math.sin(i*math.tau/segments))*r
            verts.append(tuple(p));uv.append((i/segments,v))
    geometry(group,bark,verts,[(i,(i+1)%segments,(i+1)%segments+segments,i+segments) for i in range(segments)],uv,tint)

def face_patch(group,material,axis,side,center,width,height,plane,inset=.018,tint=(1,1,1,1)):
    # A shallow bevel ring, rather than raised block geometry in the route.
    u,v=center
    points=[(-width/2,-height/2),(width/2,-height/2),(width/2,height/2),(-width/2,height/2)]
    inner=[(-width/2+.035,-height/2+.035),(width/2-.035,-height/2+.035),(width/2-.035,height/2-.035),(-width/2+.035,height/2-.035)]
    verts=[]
    for coords,depth in [(points,plane),(inner,plane+side*inset)]:
        for px,py in coords:verts.append((depth,v+py,u+px) if axis=='x' else (u+px,v+py,depth))
    faces=[(4,5,6,7)]+[(i,(i+1)%4,(i+1)%4+4,i+4) for i in range(4)]
    normal=(Vector(verts[1])-Vector(verts[0])).cross(Vector(verts[2])-Vector(verts[0]))
    wanted=Vector((side,0,0) if axis=='x' else (0,0,side))
    if normal.dot(wanted)<0:faces=[tuple(reversed(face)) for face in faces]
    scale=material.get('textureMetres',3)
    uv=[((p[2] if axis=='x' else p[0])/scale,p[1]/scale) for p in verts]
    geometry(group,material,verts,faces,uv,tint)

map_text=(ROOT/'shared'/'map.ts').read_text()
obstacles=[]
for match in re.finditer(r"\{ id: '([^']+)', x: ([-\d.]+), y: ([-\d.]+), z: ([-\d.]+), w: ([-\d.]+), h: ([-\d.]+), d: ([-\d.]+), color: '[^']+', kind: '([^']+)'",map_text):
    obstacle={'id':match[1],'kind':match[8]};obstacle.update({key:float(match[i+2]) for i,key in enumerate(['x','y','z','w','h','d'])});obstacles.append(obstacle)
assert len(obstacles)==17,'Review any authoritative-map change before rebuilding art'

# Flush paved plaza. Its scale and the cover routes remain identical to the map.
box('ArenaCore',ground,(0,-.325,0),(64,.65,64))
for obstacle in obstacles:
    x,y,z,w,h,d=[obstacle[key] for key in ['x','y','z','w','h','d']]
    bottom=y-h/2;top=y+h/2
    tint=(.93,.91,.87,1) if obstacle['kind']=='cover' else (1,1,1,1)
    box('ArenaCore',stone,(x,y,z),(w,h,d),.035,tint)
    if obstacle['kind']=='step':
        box('ArenaTrim',bronze,(x,top-.017,z-d/2+.035),(w-.08,.024,.045))
        box('ArenaTrim',petrol,(x,top-.11,z-d/2-.008),(w-.22,.085,.016))
        continue
    # Individual ashlar courses and shallow physical bevels establish human scale.
    for axis,span,other,depth in [('x',d,z,w),('z',w,x,d)]:
        for side in [-1,1]:
            plane=(x if axis=='x' else z)+side*depth/2
            course=.74 if h>2.5 else .66
            rows=max(1,math.ceil(h/course));row_height=h/rows
            for row in range(rows):
                widths=[];cursor=-span/2;offset=.63 if row%2 else 0
                while cursor<span/2-.01:
                    length=min((.78 if not widths and offset else 1.43+random.uniform(-.17,.17)),span/2-cursor)
                    widths.append((cursor+length/2,length));cursor+=length
                for middle,length in widths:
                    shade=random.uniform(.75,1.10)
                    face_patch('ArenaCore',stone,axis,side,(other+middle,bottom+(row+.5)*row_height),max(.07,length-.018),row_height-.018,plane-.003*side,.009,(shade,shade*.985,shade*.96,1))
    # Dark ceramic skirts, copper contact rails and inset service plates.
    band_y=bottom+.15
    for axis,span,other,depth in [('x',d,z,w),('z',w,x,d)]:
        for side in [-1,1]:
            plane=(x if axis=='x' else z)+side*depth/2
            face_patch('ArenaTrim',petrol,axis,side,(other,band_y),span-.07,.17,plane+.011*side,.004)
            face_patch('ArenaTrim',bronze,axis,side,(other,band_y+.105),span-.09,.035,plane+.018*side,.002)
            if h>1.0:
                panel_w=min(1.05,span*.28);panel_h=min(h-.48,1.92)
                face_patch('ArenaTrim',bronze,axis,side,(other,bottom+.30+panel_h/2),panel_w+.07,panel_h+.06,plane+.019*side,.005)
                face_patch('ArenaTrim',petrol,axis,side,(other,bottom+.30+panel_h/2),panel_w,panel_h,plane+.028*side,.003)
                for offset in [-panel_w*.36,panel_w*.36]:
                    face_patch('ArenaTrim',bronze,axis,side,(other+offset,bottom+.40+panel_h*.68),.029,panel_h*.47,plane+.033*side,.002)
    if h>2.8:
        # Coping/entablature stays inside the same collision top.
        box('ArenaTrim',petrol,(x,top-.29,z),(w+.032,.23,d+.032),.008)
        box('ArenaTrim',bronze,(x,top-.42,z),(w+.038,.026,d+.038))
        box('ArenaCore',stone,(x,top-.072,z),(w+.025,.15,d+.025),.025)
        if d>3 and w>3:
            for axis,span,other,depth in [('x',d,z,w),('z',w,x,d)]:
                for side in [-1,1]:
                    plane=(x if axis=='x' else z)+side*depth/2
                    for offset in [-span*.40,span*.40]:
                        face_patch('ArenaCore',stone,axis,side,(other+offset,y-.04),.30,h-.25,plane+side*.019,.019,(.90,.88,.84,1))
                        face_patch('ArenaTrim',bronze,axis,side,(other+offset,top-.63),.32,.047,plane+side*.037,.001)
    if obstacle['kind']=='platform':
        box('ArenaCore',ground,(x,top+.003,z),(w-.10,.008,d-.10))

# The solar-relay insignia gives the northern landmark a specific identity.
for x in [-8,8]:
    for side in [-1,1]:
        plane=-17+side*2.5
        for material,width,top,bottom,depth in [(bronze,1.25,4.78,.84,.030),(petrol,1.16,4.73,.90,.035)]:
            verts=[(x-width/2,top,plane+side*depth),(x+width/2,top,plane+side*depth),(x+width/2,bottom+.35,plane+side*depth),(x,bottom,plane+side*depth),(x-width/2,bottom+.35,plane+side*depth)]
            geometry('ArenaTrim',material,verts,[(0,1,2,3,4) if side<0 else (4,3,2,1,0)])
        for offset in [-.23,0,.23]:
            face_patch('ArenaTrim',bronze,'z',side,(x+offset,2.45+abs(offset)*.55),.045,.60-abs(offset),plane+side*.039,.0002)

# Center solar compass is an inlay, never extra cover.
for i in range(8):
    angle=i*math.tau/8;direction=Vector((math.sin(angle),0,math.cos(angle)));right=Vector((direction.z,0,-direction.x))
    p0=direction*.65;tip=direction*(3.2 if i%2==0 else 2.25);p1=direction*1.15+right*.20;p2=direction*1.15-right*.20
    vertices=[(p.x,.012,p.z) for p in [p0,p1,tip,p2]]
    geometry('ArenaTrim',bronze if i%2==0 else petrol,vertices,[(0,3,2,1)])
for radius in [3.75,3.81]:
    vertices=[]
    for i in range(96):
        a=i*math.tau/96;vertices.extend([(math.sin(a)*(radius-.016),.008,math.cos(a)*(radius-.016)),(math.sin(a)*(radius+.016),.008,math.cos(a)*(radius+.016))])
    geometry('ArenaTrim',bronze,vertices,[(i*2+1,(i*2+3)%192,(i*2+2)%192,i*2) for i in range(96)])

# Perimeter masonry begins beyond the playable square; no ornamental cover is
# introduced into lanes, spawn pads or the gap underneath the northern lintel.
for side in [-1,1]:
    for axis in ['x','z']:
        center=(side*32.55,-.10,0) if axis=='x' else (0,-.10,side*32.55)
        size=(.8,1.05,65.5) if axis=='x' else (65.5,1.05,.8)
        box('Exterior',stone,center,size,.045)
        coping=(center[0],.46,center[2]);cap=(.91,.14,65.5) if axis=='x' else (65.5,.14,.91)
        box('Exterior',stone,coping,cap,.027)
        for i in range(-28,29,7):
            p=(side*32.58,.39,i) if axis=='x' else (i,.39,side*32.58)
            box('Exterior',stone,p,(1.0,1.45,1.0),.04)
            box('Exterior',petrol,(p[0],1.07,p[2]),(1.02,.10,1.02),.015)

def leaf_card(center,width,height,yaw,lean,tint=(1,1,1,1),lighting_normal=None):
    c=Vector(center);right=Vector((math.cos(yaw),0,math.sin(yaw)))
    up=Vector((-math.sin(yaw)*math.sin(lean),math.cos(lean),math.cos(yaw)*math.sin(lean)))
    # Four vertices across the card give the botanical sprig a subtle convex fold.
    normal=right.cross(up).normalized()
    vertices=[tuple(c+right*u*width+up*v*height+normal*(.04 if u==0 else 0)) for v in [-.5,.5] for u in [-.5,0,.5]]
    geometry('Foliage',leaves,vertices,[(0,1,4,3),(1,2,5,4)],[(0,0),(.5,0),(1,0),(0,1),(.5,1),(1,1)],tint,lighting_normal)

def olive_tree(x,z,height,seed,cypress=False):
    rng=random.Random(seed);base=(x,.3,z);fork=(x+.20,height*.48,z-.13)
    branch('Foliage',base,fork,.25 if not cypress else .16,.13)
    crowns=[]
    for i in range(8 if not cypress else 5):
        angle=i*2.399+rng.uniform(-.2,.2)
        radius=(2.00 if not cypress else .33)*(height/7)*rng.uniform(.7,1.1)
        endpoint=(x+math.cos(angle)*radius,height*((.54 if i%3==0 else .66)+rng.random()*.18),z+math.sin(angle)*radius)
        branch('Foliage',fork,endpoint,.11,.018,6);crowns.append(endpoint)
    for i in range(450 if not cypress else 260):
        if cypress:
            cy=.9+rng.random()*(height-.8);r=(1-cy/height)*.64+.10;angle=rng.random()*math.tau
            center=(x+math.cos(angle)*r,cy,z+math.sin(angle)*r)
            lighting_normal=tuple(Vector((center[0]-x,.55,center[2]-z)).normalized())
            leaf_card(center,.82,1.06,rng.random()*math.tau,rng.uniform(-.6,.6),lighting_normal=lighting_normal)
        else:
            crown=crowns[i%len(crowns)];angle=rng.random()*math.tau;r=math.sqrt(rng.random())*1.35
            center=(crown[0]+math.cos(angle)*r,crown[1]+rng.uniform(-.62,.63),crown[2]+math.sin(angle)*r)
            # A broad upward/outward crown normal gives thin botanical cards a
            # continuous canopy response without costly transmission shading.
            lighting_normal=tuple(Vector(((center[0]-x)*.55,1.6+(center[1]-height*.62)*.60,(center[2]-z)*.55)).normalized())
            leaf_card(center,.94,1.15,rng.random()*math.tau,rng.uniform(-1.1,1.1),lighting_normal=lighting_normal)

for i,(x,z,h) in enumerate([(-35,-23,7.5),(-36,0,7.4),(-35,23,7.8),(35,-24,8.2),(36,2,7.2),(35,24,7.3),(-23,-35,7.5),(1,-35,7.0),(25,-35,7.4),(-20,35,7.4),(21,35,7.6)]):
    box('Exterior',stone,(x,.08,z),(3.4,.9,3.4),.06)
    box('Exterior',bronze,(x,.54,z),(3.46,.045,3.46),.007)
    olive_tree(x,z,h*1.27,500+i)
for i,(x,z) in enumerate([(-34.5,-12),(-34.8,12),(34.6,-13),(34.8,13),(-12,-35),(13,-35)]):olive_tree(x,z,7+(i%3)*.8,650+i,True)

# Bougainvillea appears outside the boundary only; small petal rosettes catch the
# warm light without becoming brightly colored gameplay camouflage.
for side in [-1,1]:
    for i in range(55):
        x=side*(33.4+random.random()*.6);z=-29+i*1.08;y=.7+random.random()*.6
        leaf_card((x,y,z),.55,.65,random.random()*math.tau,.3)
        if i%2==0:
            for petal in range(5):
                angle=petal*math.tau/5;cx=x+math.cos(angle)*.085;cz=z+math.sin(angle)*.085
                geometry('Foliage',flower,[(cx-.07,y+.08,cz),(cx,y+.10,cz+.075),(cx+.07,y+.08,cz),(cx,y+.03,cz-.055)],[(0,1,2),(0,2,3)],tint=(random.uniform(.78,1.15),.8,1,1))

def island(group,cx,cz,radius,height,seed,square=False):
    rng=random.Random(seed);segments=128 if square else 64;levels=[(1,0),(1.013,-1.6),(.985,-3.6),(1.02,-6),(.99,-9),(.96,-16),(.94,-25)]
    vertices=[];colors=[];uv=[]
    phases=[rng.uniform(0,6.28) for _ in range(4)]
    for level,(factor,dy) in enumerate(levels):
        for i in range(segments):
            angle=i*math.tau/segments
            outline=radius/(max(abs(math.cos(angle)),abs(math.sin(angle))) if square else 1)
            noise=math.sin(angle*11+phases[0])*.75+math.sin(angle*23+phases[1])*.52+math.sin(angle*37+phases[3]+level*.22)*.38
            r=outline*factor+noise
            # Shallow irregular strata share vertical weathering streaks. Strong
            # alternating ring colors would read as stacked manufactured slabs.
            waviness=.20 if level==0 else .50
            vertices.append((cx+math.cos(angle)*r,height+dy+math.sin(angle*7+phases[2])*waviness,cz+math.sin(angle)*r))
            weathering=.045*math.sin(angle*13+phases[1])+.035*math.sin(angle*29+phases[0])
            shade=[.69,.66,.62,.65,.61,.62,.59][level]+weathering+rng.uniform(-.06,.07);colors.append((shade,shade*.99,shade*.95,1))
            uv.append((angle*radius/5,(height+dy)/5))
    faces=[]
    for level in range(len(levels)-1):
        for i in range(segments):faces.append((level*segments+i,level*segments+(i+1)%segments,(level+1)*segments+(i+1)%segments,(level+1)*segments+i))
    faces.append(tuple(range(segments-1,-1,-1)))
    geometry(group,cliff,vertices,faces,uv,tint=colors)

island('Exterior',0,0,33.9,-.62,91,True)
island('Horizon',72,-105,39,11,18)
island('Horizon',-110,-175,34,-.2,23)
island('Horizon',165,50,32,-1,44)

def rock_outcrop(center,size,seed,group='Exterior'):
    rng=random.Random(seed);bm=bmesh.new();bmesh.ops.create_icosphere(bm,subdivisions=2,radius=1)
    bm.verts.ensure_lookup_table();bm.verts.index_update()
    vertices=[];colors=[]
    for v in bm.verts:
        shade=rng.uniform(.50,.79);colors.append((shade,shade*.98,shade*.91,1))
        vertices.append((center[0]+v.co.x*size[0]*rng.uniform(.85,1.10),center[1]+v.co.z*size[1],center[2]-v.co.y*size[2]*rng.uniform(.88,1.10)))
    faces=[tuple(v.index for v in face.verts) for face in bm.faces];bm.free()
    # Per-face projection prevents vertical rock faces from stretching floor UVs.
    for face in faces:
        points=[vertices[i] for i in face];normal=(Vector(points[1])-Vector(points[0])).cross(Vector(points[2])-Vector(points[0]));axis=max(range(3),key=lambda i:abs(normal[i]))
        uv=[((p[2] if axis==0 else p[0])/3,(p[2] if axis==1 else p[1])/3) for p in points]
        geometry(group,cliff,points,[(0,1,2)],uv,[colors[i] for i in face])
for i in range(36):
    angle=i*math.tau/36;r=34.5/max(abs(math.cos(angle)),abs(math.sin(angle)))
    rock_outcrop((math.cos(angle)*r,-4.0+math.sin(i)*1.3,math.sin(angle)*r),(1.4,3.8+random.random(),1.3),900+i)

# Tall fractured buttresses interrupt the landmark island's circular terraces.
# These distant rocks share the existing cliff batch/material and never enter
# the playable map. A separate seed preserves surrounding architecture exactly.
landmark_rng=random.Random(1789)
for i in range(24):
    angle=i*math.tau/24+landmark_rng.uniform(-.055,.055)
    radius=38.5+landmark_rng.uniform(-.7,1.3)
    center=(72+math.cos(angle)*radius,1.8+landmark_rng.uniform(-1.4,1.8),-105+math.sin(angle)*radius)
    size=(2.5+landmark_rng.random()*1.3,7.6+landmark_rng.random()*2.1,2.2+landmark_rng.random()*1.4)
    rock_outcrop(center,size,2100+i,'Horizon')

# Coastal auxiliary buildings supply believable architectural context beyond
# the boundary, leaving every gameplay route and the solid map buildings intact.
for side in [-1,1]:
    x=side*40;z=-10
    island('Exterior',x,z,10,-.58,80+side)
    box('Exterior',stone,(x,3.4,z),(10,6.8,18),.07)
    box('Exterior',stone,(x+side*.8,7.5,z-1),(8.4,1.5,14),.06)
    for y,width,depth in [(3.45,10.1,18.1),(6.5,10.12,18.12),(8.26,8.55,14.15)]:
        box('Exterior',petrol,(x+(side*.8 if y>8 else 0),y,z-(1 if y>8 else 0)),(width,.17,depth),.014)
        box('Exterior',bronze,(x+(side*.8 if y>8 else 0),y+.10,z-(1 if y>8 else 0)),(width+.015,.024,depth+.015))
    facade=x-side*5
    for bay in [-6,0,6]:
        for level in [0,3.45]:
            center_z=z+bay;base_y=level+.38
            face_patch('Exterior',petrol,'x',-side,(center_z,base_y+1.17),2.32,2.30,facade-side*.03,.02)
            # Carved stone pilasters, lintels and bronze mullions around closed windows.
            for offset in [-1.31,1.31]:box('Exterior',stone,(facade-side*.11,base_y+1.35,center_z+offset),(.20,2.70,.23),.03)
            box('Exterior',stone,(facade-side*.10,base_y+2.70,center_z),(.22,.23,2.95),.035)
            for offset in [-.71,0,.71]:face_patch('Exterior',bronze,'x',-side,(center_z+offset,base_y+1.22),.045,2.1,facade-side*.056,.008)
    for offset in [-7.5,-2.5,2.5,7.5]:
        box('Exterior',stone,(facade-side*.22,3.35,z+offset),(.44,6.55,.48),.055)
        box('Exterior',bronze,(facade-side*.23,3.53,z+offset),(.47,.12,.53),.012)

# Landmark: a real three-dimensional observatory with an open colonnade and a
# ribbed copper dome. It is far outside playable bounds and never casts arena shadows.
landmark_start={key:len(data['v']) for key,data in meshes.items() if key[0]=='Horizon'}
ox,oz=72,-105
box('Horizon',stone,(ox,6.1,oz),(24,4.2,24),.18)
box('Horizon',petrol,(ox,8.1,oz),(24.1,.28,24.1))
cylinder('Horizon',stone,(ox,9,oz),10.1,1.7,32)
cylinder('Horizon',stone,(ox,17,oz),7.2,14.2,32)
for i in range(12):
    angle=i*math.tau/12;x=ox+math.sin(angle)*7.5;z=oz+math.cos(angle)*7.5
    cylinder('Horizon',stone,(x,16.8,z),.62,13.0,10,top_radius=.50)
    cylinder('Horizon',bronze,(x,23.4,z),.77,.35,10)
cylinder('Horizon',stone,(ox,24.5,oz),9.0,1.7,32)
cylinder('Horizon',petrol,(ox,25.4,oz),9.15,.25,32)
for i in range(12):
    a=i*math.tau/12;cylinder('Horizon',stone,(ox+math.sin(a)*6.8,28.7,oz+math.cos(a)*6.8),.38,6.0,8)
cylinder('Horizon',bronze,(ox,31.65,oz),8.0,.28,32)
verts=[];faces=[]
for ring in range(9):
    theta=ring/8*math.pi/2;r=7.8*math.cos(theta);y=31.8+7.2*math.sin(theta)
    for i in range(48):
        a=i*math.tau/48;verts.append((ox+math.sin(a)*r,y,oz+math.cos(a)*r))
for ring in range(8):
    for i in range(48):faces.append((ring*48+i,ring*48+(i+1)%48,(ring+1)*48+(i+1)%48,(ring+1)*48+i))
geometry('Horizon',petrol,verts,faces,tint=(1.12,1.13,1.11,1))
cylinder('Horizon',bronze,(ox,39.3,oz),.26,2.0,10,top_radius=.04)
for i in range(7):
    x=ox-27+i*7.5;z=oz+20+math.sin(i)*8
    box('Horizon',stone,(x,6,z),(5+random.random()*3,5+random.random()*4,6),.12)
    box('Horizon',petrol,(x,9,z),(5.8,.2,6.3),.035)
for key,data in meshes.items():
    if key[0]!='Horizon':continue
    for index in range(landmark_start.get(key,0),len(data['v'])):
        px,pz,py=data['v'][index];data['v'][index]=(px,pz,11+(py-4)*1.35)

environment=bpy.data.objects.new('Environment',None);bpy.context.collection.objects.link(environment)
environment['coordinateSystem']='metres;Y up;ground y=0 after glTF export'
environment['collisionSource']='shared/map.ts'
environment['colliderCount']=len(obstacles)
environment['surfaceReliefMaxMetres']=.04
groups={}
for name in ['ArenaCore','ArenaTrim','Exterior','Foliage','Horizon']:
    obj=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(obj);obj.parent=environment;groups[name]=obj

for (group,material_name),data in meshes.items():
    mesh=bpy.data.meshes.new(group+'_'+material_name);mesh.from_pydata(data['v'],[],data['f']);mesh.materials.append(bpy.data.materials[material_name]);mesh.update()
    uv=mesh.uv_layers.new(name='SurfaceUV')
    colors=mesh.color_attributes.new(name='Color',type='BYTE_COLOR',domain='CORNER')
    for polygon in mesh.polygons:
        # Shared island-ring vertices shade continuously; split rock-face vertices
        # retain their angular fracture edges inside this same cliff batch.
        if material_name=='EnvCliff':polygon.use_smooth=True
        for loop in polygon.loop_indices:
            index=mesh.loops[loop].vertex_index;uv.data[loop].uv=data['uv'][index];colors.data[loop].color=data['color'][index]
    if any(normal is not None for normal in data['normal']):
        # Blender preserves these explicit normals in glTF. Zero vectors retain
        # automatic normals on the few low climbing-plant cards in the same batch.
        for polygon in mesh.polygons:polygon.use_smooth=True
        mesh.normals_split_custom_set_from_vertices([bv(normal) if normal is not None else (0,0,0) for normal in data['normal']])
    obj=bpy.data.objects.new(group+'_'+material_name,mesh);bpy.context.collection.objects.link(obj);obj.parent=groups[group]
    obj['castShadow']=group not in ['Horizon']
    obj['receiveShadow']=group!='Horizon'
    obj['environmentGroup']=group

refs=bpy.data.objects.new('CollisionReferences',None);bpy.context.collection.objects.link(refs);refs.parent=environment
for obstacle in obstacles:
    ref=bpy.data.objects.new('Collision_'+obstacle['id'],None);bpy.context.collection.objects.link(ref);ref.parent=refs
    ref.location=bv((obstacle['x'],obstacle['y'],obstacle['z']));ref.empty_display_type='CUBE';ref.empty_display_size=.15
    ref['sizeXYZ']=[obstacle['w'],obstacle['h'],obstacle['d']];ref['kind']=obstacle['kind']

# Export only game geometry/metadata. Preview lighting/cameras/water are source-only.
# Stage the complete asset before replacement, so a concurrent development-server
# request always receives either the previous export or the complete next one.
export_stage = tempfile.TemporaryDirectory(prefix='.environment-export-', dir=OUT)
staged_glb = Path(export_stage.name) / 'environment.glb'
bpy.ops.object.select_all(action='DESELECT')
for obj in [environment,*environment.children_recursive]:obj.select_set(True)
bpy.context.view_layer.objects.active=environment
bpy.ops.export_scene.gltf(filepath=str(staged_glb),export_format='GLB',use_selection=True,export_yup=True,export_animations=False,export_lights=False,export_cameras=False,export_extras=True,export_apply=True,export_materials='EXPORT',export_normals=True,export_texcoords=True,export_vertex_color='NAME',export_vertex_color_name='Color',export_all_vertex_colors=False)
# Blender 5.2's dithered preview material exports as BLEND. Game foliage uses a
# deterministic cutout, preserving depth writes and avoiding sorted alpha layers.
import struct
binary=staged_glb.read_bytes();json_length=struct.unpack_from('<I',binary,12)[0]
gltf=json.loads(binary[20:20+json_length]);bin_chunk=binary[20+json_length:]
for mat in gltf.get('materials',[]):
    if mat.get('name')=='EnvLeaves':mat.update({'alphaMode':'MASK','alphaCutoff':.5,'doubleSided':True})
# Keep standard glTF vertex colors at 8 bits. Blender may export linearized color
# attributes at 16 bits despite a byte source layer; 8 bits is sufficient for tint,
# leaves all generated weathered texture maps intact, and needs no custom decoder.
payload=bin_chunk[8:];replacements={}
for mesh in gltf['meshes']:
    for primitive in mesh['primitives']:
        color_index=primitive['attributes'].get('COLOR_0')
        if color_index is None:continue
        accessor=gltf['accessors'][color_index]
        if accessor['componentType']!=5123:continue
        assert accessor.get('normalized') and accessor.get('byteOffset',0)==0
        view_index=accessor['bufferView'];view=gltf['bufferViews'][view_index]
        assert not view.get('byteStride') and view['byteLength']==accessor['count']*8
        values=np.frombuffer(payload[view.get('byteOffset',0):view.get('byteOffset',0)+view['byteLength']],dtype='<u2').astype(np.uint32)
        replacements[view_index]=((values+128)//257).astype(np.uint8).tobytes();accessor['componentType']=5121
        accessor.pop('min',None);accessor.pop('max',None)
repacked=bytearray()
for index,view in enumerate(gltf['bufferViews']):
    block=replacements.get(index,payload[view.get('byteOffset',0):view.get('byteOffset',0)+view['byteLength']])
    repacked.extend(b'\0'*((-len(repacked))%4));view['byteOffset']=len(repacked);view['byteLength']=len(block);repacked.extend(block)
repacked.extend(b'\0'*((-len(repacked))%4));gltf['buffers'][0]['byteLength']=len(repacked)
bin_chunk=struct.pack('<II',len(repacked),0x004E4942)+repacked
encoded=json.dumps(gltf,separators=(',',':')).encode();encoded+=b' '*((-len(encoded))%4)
binary=struct.pack('<III',0x46546C67,2,20+len(encoded)+len(bin_chunk))+struct.pack('<II',len(encoded),0x4E4F534A)+encoded+bin_chunk
staged_glb.write_bytes(binary)
for attempt in range(12):
    try:
        staged_glb.replace(OUT/'environment.glb')
        break
    except PermissionError:
        # Windows can briefly hold an open file handle during a served asset fetch.
        # Preserve the previous complete file and retry only the atomic replacement.
        if attempt==11:raise
        time.sleep(.25)
export_stage.cleanup()

scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=24
scene.cycles.use_denoising=True;scene.render.resolution_x=1500;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
scene.world.color=(.33,.46,.56)
world_nodes=scene.world.node_tree if scene.world.use_nodes else None
scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.47,.66,.79,1);scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.52
sun_data=bpy.data.lights.new('PreviewSun','SUN');sun_data.energy=3.4;sun_data.angle=.055
sun=bpy.data.objects.new('PreviewSun',sun_data);bpy.context.collection.objects.link(sun);sun.rotation_euler=(math.radians(30),math.radians(-23),math.radians(-28))
water_mat=surface('PreviewWater',(.035,.29,.39),.19,.25)
bpy.ops.mesh.primitive_plane_add(size=1200,location=bv((0,-9,0)));preview_water=bpy.context.object;preview_water.name='PreviewWater_NotExported';preview_water.data.materials.append(water_mat)
scene.view_settings.view_transform='AgX'
camera_data=bpy.data.cameras.new('EnvironmentReviewCamera');camera=bpy.data.objects.new('EnvironmentReviewCamera',camera_data);bpy.context.collection.objects.link(camera);scene.camera=camera;camera_data.lens=28
def render(name,position,target,lens=28):
    camera.location=bv(position);direction=Vector(bv(target))-camera.location;camera.rotation_euler=direction.to_track_quat('-Z','Y').to_euler();camera_data.lens=lens
    scene.render.filepath=str(SOURCE/name);bpy.ops.render.render(write_still=True)

manifest={'asset':'public/models/environment.glb','groups':list(groups),'materials':[m.name for m in [stone,ground,petrol,bronze,cliff,bark,leaves,flower]],'mapObstacles':obstacles,'coordinateSystem':'metres; Y up; ground y=0','originalArtwork':True,'notes':['Original authored geometry, generated basecolor artwork, and authored PBR/foliage maps.','The observatory and tree trunks are outside the 64 m playable square; high canopies may overhang.','Sky/water/lighting remain runtime systems; preview-only water is at y=-9.','Authoritative collision is unchanged; rendered surface relief is at most 4 cm.']}
(SOURCE/'environment-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
for unused_image in list(bpy.data.images):
    if not unused_image.users:bpy.data.images.remove(unused_image)
render('environment-gameplay.png',(-12,3.45,24),(0,2.15,-13),28)
# Keep the source camera at a useful gameplay review angle when the file opens.
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'environment.blend'),compress=True)
render('environment-overview.png',(61,49,66),(0,0,-4),35)
print('ENVIRONMENT_EXPORT_COMPLETE',json.dumps({'file':str(OUT/'environment.glb'),'bytes':(OUT/'environment.glb').stat().st_size,'groups':list(groups),'batches':len(meshes)}))
