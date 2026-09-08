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
    if kind=='metal':
        # Radially filtered random fields have no preferred scratch direction.
        # The old crossed sine waves produced obvious diagonal bands in grazing
        # reflections. Use restrained mottling and nearly flat metal normals.
        # Keep this RNG local so changing a finish cannot alter the leaf atlas.
        metal_rng=np.random.default_rng(2473)
        frequencies=np.fft.fftfreq(size)*size
        radius_squared=frequencies[:,None]**2+frequencies[None,:]**2
        def isotropic_field(frequency):
            spectrum=np.fft.fft2(metal_rng.standard_normal((size,size)))
            filtered=np.fft.ifft2(spectrum*np.exp(-radius_squared/(frequency*frequency))).real
            return (filtered-filtered.mean())/max(filtered.std(),1e-8)
        broad=isotropic_field(6);fine=isotropic_field(27)
        variation=np.clip(.985+(.7*broad+.3*fine)*.007,.95,1.015)
        height=(.002*broad+.0015*fine).astype(np.float32)
        metal_rough=np.clip(.51+.022*broad+.015*fine,.43,.60)
    color=np.stack([np.clip(base[c]*variation,0,1) for c in range(3)],axis=-1)
    # Finite differences are periodic, so the original authored normal tile is seamless.
    dx=(np.roll(height,-1,axis=1)-np.roll(height,1,axis=1))*2.5
    dy=(np.roll(height,-1,axis=0)-np.roll(height,1,axis=0))*2.5
    normal=np.stack([-dx,-dy,np.ones_like(dx)],axis=-1)
    normal/=np.linalg.norm(normal,axis=2,keepdims=True);normal=normal*.5+.5
    rough=metal_rough if kind=='metal' else np.clip(.84+height*.14,.28,.98)
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

# Original three-branch botanical spray. Filling a card with connected sprays,
# rather than one sparse twig, makes mature crowns possible with fewer cards.
size=512; yy,xx=np.mgrid[:size,:size]/(size-1)
leaf_pixels=np.zeros((size,size,4),np.float32)
def ellipse_leaf(cx,cy,length,width,angle,tint):
    dx=xx-cx;dy=yy-cy;u=dx*math.cos(angle)+dy*math.sin(angle);v=-dx*math.sin(angle)+dy*math.cos(angle)
    shape=(np.abs(u/(length/2))**1.35+(v/(width/2))**2)<1
    rib=np.exp(-np.square(v/(width*.045)))*.09
    light=np.clip(.8+.23*u/length+rib+RNG.normal(0,.012,xx.shape),.55,1.15)
    for c in range(3):leaf_pixels[:,:,c][shape]=np.asarray(tint[c]*light)[shape]
    leaf_pixels[:,:,3][shape]=1
def atlas_twig(start,end,width=.005):
    a=np.array(start);delta=np.array(end)-a
    t=np.clip(((xx-a[0])*delta[0]+(yy-a[1])*delta[1])/np.dot(delta,delta),0,1)
    mask=np.square(xx-a[0]-t*delta[0])+np.square(yy-a[1]-t*delta[1])<width*width
    leaf_pixels[mask]=(.31,.32,.15,1)

for spray,(start,end) in enumerate([((.47,.05),(.21,.83)),((.48,.08),(.54,.96)),((.49,.11),(.86,.78))]):
    atlas_twig(start,end,.006 if spray==1 else .004)
    direction=Vector((end[0]-start[0],end[1]-start[1])).normalized()
    perpendicular=Vector((-direction.y,direction.x))
    for i in range(6):
        t=.22+i*.124;anchor=Vector(start).lerp(Vector(end),t)
        for side in [-1,1]:
            leaf_direction=(direction*.70+perpendicular*side*.82).normalized()
            center=anchor+leaf_direction*(.064 if i<4 else .051)
            atlas_twig(tuple(anchor),tuple(center),.003)
            warmth=.035 if (i+spray+(side>0))%4==0 else 0
            ellipse_leaf(center.x,center.y,.205-i*.009,.085-i*.003,math.atan2(leaf_direction.y,leaf_direction.x),(.38+warmth+i*.006,.52+i*.005,.19+i*.004))
    ellipse_leaf(end[0],end[1]-.02,.125,.057,math.atan2(direction.y,direction.x),(.43,.56,.22))
leaf_image=image('olive_sprig',leaf_pixels)
leaf_tree=leaves.node_tree;leaf_shader=leaf_tree.nodes.get('Principled BSDF')
leaf_tex=leaf_tree.nodes.new('ShaderNodeTexImage');leaf_tex.image=leaf_image
leaf_tint=leaf_tree.nodes.new('ShaderNodeVertexColor');leaf_tint.layer_name='Color'
leaf_mix=leaf_tree.nodes.new('ShaderNodeMixRGB');leaf_mix.blend_type='MULTIPLY';leaf_mix.inputs[0].default_value=1
leaf_tree.links.new(leaf_tex.outputs['Color'],leaf_mix.inputs[1]);leaf_tree.links.new(leaf_tint.outputs['Color'],leaf_mix.inputs[2]);leaf_tree.links.new(leaf_mix.outputs[0],leaf_shader.inputs['Base Color'])
leaf_tree.links.new(leaf_tex.outputs['Alpha'],leaf_shader.inputs['Alpha'])
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

def box(group,material,center,size,bevel=0,tint=(1,1,1,1),omit_top=False):
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
        if omit_top and axis==1 and normal.y>0:continue
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

# Flush paved plaza. A low-density vertex grid supplies broad wear and warm/cool
# variation without another texture, layer, batch, or raised gameplay surface.
# The grid below is the only upward floor surface. Retaining the slab's hidden
# top would shade the entire floor twice in one draw (far layer submitted first).
box('ArenaCore',ground,(0,-.325,0),(64,.65,64),omit_top=True)
floor_vertices=[];floor_colors=[];floor_uv=[]
for iz in range(25):
    for ix in range(25):
        px=-32+ix*64/24;pz=-32+iz*64/24
        edge=max(abs(px),abs(pz))/32
        sheltered=sum(math.exp(-((px-o['x'])/(o['w']*.65+1.5))**2-((pz-o['z'])/(o['d']*.65+1.5))**2) for o in obstacles if o['kind']!='step')
        walk=math.exp(-(px/3.7)**2)*.09
        mottling=.035*math.sin(px*.19+pz*.09)+.024*math.cos(pz*.31-px*.12)
        shade=max(.74,min(1.03,.91+walk+mottling-.09*edge**5-.065*min(sheltered,1)))
        floor_vertices.append((px,0,pz));floor_uv.append((px/6,pz/6))
        floor_colors.append((shade,shade*(.97+.015*math.sin(pz*.12)),shade*.92,1))
geometry('ArenaCore',ground,floor_vertices,[(z*25+x,z*25+x+25,z*25+x+26,z*25+x+1) for z in range(24) for x in range(24)],floor_uv,floor_colors)
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
            course=.92 if h>2.5 else .79
            rows=max(1,math.ceil(h/course));row_height=h/rows
            for row in range(rows):
                widths=[];cursor=-span/2;offset=.63 if row%2 else 0
                while cursor<span/2-.01:
                    length=min((.87 if not widths and offset else 1.82+random.uniform(-.24,.24)),span/2-cursor)
                    widths.append((cursor+length/2,length));cursor+=length
                for middle,length in widths:
                    # Shelter/grime is concentrated at the base; neighboring
                    # blocks vary subtly rather than producing a checkerboard.
                    shade=random.uniform(.89,1.04)-.08*math.exp(-row*.9)
                    face_patch('ArenaCore',stone,axis,side,(other+middle,bottom+(row+.5)*row_height),max(.07,length-.018),row_height-.018,plane-.003*side,.009,(shade,shade*.985,shade*.96,1))
    # Different construction for tactical barriers and full-height buildings.
    # Shutters are explicitly closed: these solids never suggest usable doors.
    band_y=bottom+.15
    for axis,span,other,depth in [('x',d,z,w),('z',w,x,d)]:
        for side in [-1,1]:
            plane=(x if axis=='x' else z)+side*depth/2
            face_patch('ArenaTrim',petrol,axis,side,(other,band_y),span-.07,.17,plane+.011*side,.004)
            face_patch('ArenaTrim',bronze,axis,side,(other,band_y+.105),span-.09,.035,plane+.018*side,.002)
            if obstacle['kind']=='cover':
                panel_w=span*.58;panel_h=min(.39,h*.28);panel_y=bottom+h*.54
                face_patch('ArenaTrim',bronze,axis,side,(other,panel_y),panel_w+.07,panel_h+.07,plane+.018*side,.005)
                face_patch('ArenaTrim',petrol,axis,side,(other,panel_y),panel_w,panel_h,plane+.026*side,.003)
                # Chunky flush end fittings and a broad coping read at game scale.
                for offset in [-span*.40,span*.40]:
                    face_patch('ArenaTrim',petrol,axis,side,(other+offset,bottom+h*.52),.23,h-.22,plane+.022*side,.005)
                    face_patch('ArenaTrim',bronze,axis,side,(other+offset,top-.17),.27,.16,plane+.029*side,.004)
                face_patch('ArenaTrim',bronze,axis,side,(other,top-.074),span-.10,.11,plane+.017*side,.004)
            elif obstacle['id'] in ['west-block','east-block']:
                bay_count=max(2,round(span/3.8));bay_span=(span-.95)/bay_count
                for bay in range(bay_count):
                    center=other-span/2+.475+bay_span*(bay+.5)
                    panel_w=min(2.28,bay_span*.65);panel_h=h-1.67;panel_y=bottom+.78+panel_h/2
                    face_patch('ArenaTrim',petrol,axis,side,(center,panel_y),panel_w,panel_h,plane+.014*side,.004,(.76,.84,.86,1))
                    for row in range(5):
                        face_patch('ArenaTrim',bronze,axis,side,(center,panel_y-panel_h/2+.15+row*(panel_h-.3)/4),panel_w-.09,.055,plane+.024*side,.004,(.77,.75,.71,1))
                    for offset in [-panel_w/2-.055,panel_w/2+.055]:
                        # Distinct 35/32/30 mm depths prevent coplanar surfaces
                        # where jambs, lintels and the 38 mm pilasters overlap.
                        face_patch('ArenaCore',stone,axis,side,(center+offset,panel_y),.17,panel_h+.25,plane+.022*side,.013,(.93,.90,.83,1))
                    face_patch('ArenaCore',stone,axis,side,(center,panel_y+panel_h/2+.1),panel_w+.25,.20,plane+.020*side,.012,(.96,.93,.86,1))
                    face_patch('ArenaTrim',bronze,axis,side,(center,panel_y-panel_h/2-.07),panel_w+.20,.08,plane+.026*side,.004)
            elif obstacle['kind']=='platform':
                # Horizontal frieze, not another miniature building facade.
                face_patch('ArenaTrim',petrol,axis,side,(other,bottom+h*.58),span-.35,.38,plane+.019*side,.005)
                for offset in [-span*.4,span*.4]:face_patch('ArenaTrim',bronze,axis,side,(other+offset,bottom+h*.58),.22,.44,plane+.028*side,.004)
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
                        face_patch('ArenaTrim',bronze,axis,side,(other+offset,top-.63),.32,.047,plane+side*.039,.001)
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
    rng=random.Random(seed);base=(x,.3,z)
    if cypress:
        branch('Foliage',(x,-.10,z),(x+.10,height*.91,z),.19,.025,7)
        for i in range(145):
            cy=.8+rng.random()*(height-.7);r=(1-cy/height)*.57+.08;angle=i*2.399
            center=(x+math.cos(angle)*r,cy,z+math.sin(angle)*r)
            lighting_normal=tuple(Vector((center[0]-x,.65,center[2]-z)).normalized())
            leaf_card(center,.9,1.12,angle,rng.uniform(-.6,.6),(.88,.96,.82,1),lighting_normal)
        return
    # A connected tapered skeleton gives the crown weight. The broad canopy is
    # one irregular ellipsoid, not separate discs around every branch endpoint.
    knee=(x-.08,height*.25,z+.06);fork=(x+.20,height*.51,z-.13)
    branch('Foliage',base,knee,.34,.26,8);branch('Foliage',knee,fork,.26,.16,8)
    crown_radius=height*.34;crown_y=height*.76
    for i in range(6):
        angle=i*math.tau/6+rng.uniform(-.16,.16)
        reach=crown_radius*rng.uniform(.50,.69)
        elbow=(x+math.cos(angle)*reach,height*(.61+rng.random()*.06),z+math.sin(angle)*reach)
        branch('Foliage',fork,elbow,.14,.075,7)
        for side in [-1,1]:
            a=angle+side*.38;r=crown_radius*rng.uniform(.79,.96)
            tip=(x+math.cos(a)*r,crown_y+rng.uniform(-.20,.36),z+math.sin(a)*r)
            branch('Foliage',elbow,tip,.075,.015,6)
    for i in range(340):
        angle=i*2.399+rng.uniform(-.12,.12)
        # Even angular coverage prevents visible hollow rings. Interior cards
        # connect the crown; the outer quarter follows its rounded silhouette.
        normalized_r=math.sqrt(rng.random())
        if i%4==0:normalized_r=rng.uniform(.80,1)
        radius=crown_radius*normalized_r*(1+.08*math.sin(angle*3+seed))
        dome=math.sqrt(max(0,1-normalized_r**2))
        center=(x+math.cos(angle)*radius,crown_y+1.35*dome+.22*math.sin(angle*3+seed)+rng.uniform(-.95,.50),z+math.sin(angle)*radius*.90)
        lighting_normal=tuple(Vector(((center[0]-x)*.45,1.6+(center[1]-crown_y)*.6,(center[2]-z)*.45)).normalized())
        warmth=rng.uniform(.88,1.08)
        leaf_card(center,rng.uniform(1.08,1.46),rng.uniform(1.04,1.36),angle+rng.uniform(-1.7,1.7),rng.uniform(-1.3,1.3),(warmth,1, .90+rng.random()*.1,1),lighting_normal)

for i,(x,z,h) in enumerate([(-29,-35,7.5),(-35,8,8.4),(-35,23,7.8),(28,-35,8.2),(35,16,7.8),(36,31,7.3),(-19,-36,7.5),(-9,-37,7.0),(19,-36,7.4),(-20,35,7.4),(21,35,7.6)]):
    # Masonry extends into the cliff, rather than leaving a planter floating
    # above its sloping edge. The soil/top and trunk placement stay unchanged.
    box('Exterior',stone,(x,-.75,z),(3.4,2.56,3.4),.06)
    box('Exterior',bronze,(x,.54,z),(3.46,.045,3.46),.007)
    olive_tree(x,z,h*1.27,500+i)
for i,(x,z) in enumerate([(-34.5,-12),(-34.8,12),(34.6,-13),(34.8,13),(-12,-35),(13,-35)]):
    box('Exterior',stone,(x,-.4,z),(1.4,1.2,1.4),.05)
    olive_tree(x,z,7+(i%3)*.8,650+i,True)

# Six rooted bougainvillea planters replace the detached single leaves along the
# whole perimeter. Branches, sprays and flowers form one coherent plant silhouette.
# The box/soil/root meet, and all planting remains outside the playable square.
plant_rng=random.Random(3489)
for side in [-1,1]:
    for z in [-19,-3,27]:
        x=side*33.8
        box('Exterior',stone,(x,-.34,z),(1.85,1.72,2.7),.05,(.92,.88,.81,1))
        geometry('Foliage',bark,[(x-.8,.53,z-1.2),(x+.8,.53,z-1.2),(x+.8,.53,z+1.2),(x-.8,.53,z+1.2)],[(0,3,2,1)],tint=(.72,.68,.58,1))
        root=Vector((x,.54,z));tips=[]
        for i in range(5):
            a=i*2.399;tip=Vector((x+math.cos(a)*.45,1.02+(i%2)*.20,z+math.sin(a)*.82));tips.append(tip)
            branch('Foliage',tuple(root),tuple(tip),.025,.008,5)
            for t in [.45,.72,1]:
                center=root.lerp(tip,t)
                leaf_card(tuple(center),.65,.66,a+.4,.3,(.90,.97,.86,1),tuple(Vector((-side*.35,1,0)).normalized()))
        leaf_card((x,.88,z),.7,.75,.7,.2,(.95,1,.88,1),(0,1,0))
        right=Vector((0,0,1));up=Vector((side*.40,1,0)).normalized()
        for i in range(8):
            center=tips[i%5]+Vector((-side*.12,.04,plant_rng.uniform(-.10,.10)))
            for petal in range(5):
                angle=petal*math.tau/5;p=center+right*(math.cos(angle)*.065)+up*(math.sin(angle)*.065)
                points=[tuple(p+right*u+up*v) for u,v in [(-.055,0),(0,.070),(.055,0),(0,-.055)]]
                geometry('Foliage',flower,points,[(0,1,2),(0,2,3)],tint=(plant_rng.uniform(.85,1.12),.84,1,1))
# Preserve the downstream seeded cliff geometry exactly: the previous scatter
# consumed three placement samples per card and five colors per flower rosette.
for side in [-1,1]:
    for i in range(55):
        for _ in range(3+(5 if i%2==0 else 0)):random.random()

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

# Asymmetric coastal wings frame the gameplay camera. All deep relief, stepped
# terraces and parapets are outside the 64 m square; playable roofs remain flat.
def exterior_building(x,z,w,d,h,side,base=0,levels=2,group='Exterior'):
    tint=(.92,.89,.82,1)
    # Keep body/coping top surfaces distinct: coplanar opaque roof layers can
    # produce dark ray/shadow artifacts even when they share a material.
    box(group,stone,(x,base+(h-.12)/2,z),(w,h-.12,d),.09,tint)
    for y in [base+.30,base+h-.55]:
        box(group,petrol,(x,y,z),(w+.18,.23,d+.18),.02,(.90,.95,.94,1))
        box(group,bronze,(x,y+.16,z),(w+.24,.07,d+.24),.014)
    box(group,stone,(x,base+h-.15,z),(w+.35,.30,d+.35),.06,(.99,.97,.91,1))
    # Main inward facade, plus its visible south-facing return. Recessed dark
    # shutters, broad mullions and layered stone surrounds read across the arena.
    for axis,span,other,plane,face_side in [('x',d,z,x-side*w/2,-side),('z',w,x,z+d/2,1)]:
        bays=max(1,round(span/4.5));spacing=(span-.8)/bays
        for bay in range(bays):
            center=other-span/2+.4+spacing*(bay+.5)
            for level in range(levels):
                level_h=h/levels;bottom=base+level*level_h+.78;panel_h=level_h*.56;panel_w=min(2.5,spacing*.55)
                face_patch(group,petrol,axis,face_side,(center,bottom+panel_h/2),panel_w,panel_h,plane+face_side*.055,.015,(.66,.78,.79,1))
                for offset in [-panel_w/2-.16,panel_w/2+.16]:
                    center3=(plane+face_side*.20,bottom+panel_h/2,center+offset) if axis=='x' else (center+offset,bottom+panel_h/2,plane+face_side*.20)
                    size3=(.40,panel_h+.45,.28) if axis=='x' else (.28,panel_h+.45,.40)
                    box(group,stone,center3,size3,.045,(.94,.91,.85,1))
                for cy,ch in [(bottom-.08,.22),(bottom+panel_h+.13,.30)]:
                    center3=(plane+face_side*.22,cy,center) if axis=='x' else (center,cy,plane+face_side*.22)
                    size3=(.48,ch,panel_w+.84) if axis=='x' else (panel_w+.84,ch,.48)
                    # Crisp horizontal sill/lintel blocks keep real projection
                    # but avoid spending 32 extra bevel triangles on each one.
                    box(group,stone,center3,size3)
                for offset in [-panel_w*.23,panel_w*.23]:
                    face_patch(group,bronze,axis,face_side,(center+offset,bottom+panel_h/2),.075,panel_h-.12,plane+face_side*.079,.018)
                for row in [.30,.65]:
                    face_patch(group,bronze,axis,face_side,(center,bottom+panel_h*row),panel_w-.08,.06,plane+face_side*.080,.02,(.78,.77,.71,1))
        # Large corners/capital blocks make the facade's construction legible.
        for offset in [-span/2+.30,span/2-.30]:
            center3=(plane+face_side*.20,base+h/2,other+offset) if axis=='x' else (other+offset,base+h/2,plane+face_side*.20)
            size3=(.45,h-.25,.56) if axis=='x' else (.56,h-.25,.45)
            box(group,stone,center3,size3,.055,(.94,.91,.84,1))

for side in [-1,1]:island('Exterior',side*41,-19 if side<0 else -17,22 if side<0 else 24,-.58,80+side)
# Tall volumes sit at the outer north corners, inside the forward camera's view
# while remaining entirely outside collision. Lower wings recede along the sides.
exterior_building(-38.5,-30,10,12,11.4,-1,levels=3)
exterior_building(-39,-31,8,7,3.4,-1,base=11.4,levels=1)
exterior_building(-41,-10,8,12,4.4,-1,levels=1)
exterior_building(40,-6,10,16,7.6,1,levels=2)
exterior_building(38.5,-29,10,14,13.2,1,levels=3)
# Compact roof screens/solar service fins break long horizontal roof strips.
for x,z,base,w,d,side in [(-39,-31,14.8,8,7,-1),(38.5,-29,13.2,10,14,1)]:
    for offset in [-w*.37,w*.37]:
        box('Exterior',stone,(x+offset,base+.60,z-d*.30),(.50,1.2,.62),.06)
        box('Exterior',bronze,(x+offset,base+1.22,z-d*.30),(.55,.10,.69),.014)
    box('Exterior',petrol,(x,base+.28,z-d*.30),(w*.72,.50,.20),.025)

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
for i,(x,z,w,d,h) in enumerate([(45,-96,8,9,7),(49,-85,9,8,5),(60,-78,10,7,4),(73,-76,8,8,6),(86,-82,9,8,8),(99,-94,7,8,6),(86,-101,8,7,7)]):
    # The observatory belongs to a descending coastal settlement, not a bare
    # isolated pedestal. Every house is grounded on its own retaining terrace.
    box('Horizon',stone,(x,4.35,z),(w+2,.7,d+2),.08,(.76,.74,.68,1))
    box('Horizon',stone,(x,4.7+h/2,z),(w,h,d),.10,(.91,.89,.82,1))
    box('Horizon',petrol,(x,4.7+h-.15,z),(w+.15,.28,d+.15),.025)
    box('Horizon',stone,(x,4.7+h+.12,z),(w+.28,.23,d+.28),.055)
    for offset in [-w*.26,w*.26]:
        face_patch('Horizon',petrol,'z',1,(x+offset,4.7+h*.57),w*.22,h*.46,z+d/2+.04,.02,(.66,.72,.71,1))
        face_patch('Horizon',bronze,'z',1,(x+offset,4.7+h*.57),.09,h*.48,z+d/2+.07,.02)
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
export_triangles=sum(gltf['accessors'][primitive['indices']]['count']//3 for mesh in gltf['meshes'] for primitive in mesh['primitives'])
export_batches=sum(len(mesh['primitives']) for mesh in gltf['meshes'])
assert export_triangles<=70000,f'Export exceeds the fixed 70k triangle ceiling: {export_triangles}'
assert len(binary)<=7000000,f'Export exceeds the fixed 7 MB ceiling: {len(binary)}'
assert export_batches==15,f'Preserve the 15-batch runtime contract: {export_batches}'
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

manifest={'asset':'public/models/environment.glb','artRevision':'sunbreak-art-depth','groups':list(groups),'materials':[m.name for m in [stone,ground,petrol,bronze,cliff,bark,leaves,flower]],'mapObstacles':obstacles,'coordinateSystem':'metres; Y up; ground y=0','originalArtwork':True,'budget':{'maxTriangles':70000,'maxBytes':7000000,'maxColorBatches':15},'leafAtlasAlphaCoverage':round(float(np.mean(leaf_pixels[:,:,3]>.5)),4),'notes':['Original authored geometry, generated basecolor artwork, and authored PBR/foliage maps.','Asymmetric exterior archive/gallery/pavilion framing; closed shuttered facade bays are distinct from low tactical barrier fittings.','Connected mature olive crowns use 340 compound-spray cards per tree; cypress trees use 145. Canopies have no opaque filler shells.','Broad paving variation uses existing vertex colors; no additional texture/decal layer or raised floor geometry.','The observatory settlement, exterior terraces and tree trunks are outside the 64 m playable square; high canopies may overhang.','Sky/water/lighting remain runtime systems; preview-only water is at y=-9.','Authoritative collision is unchanged; rendered surface relief is at most 4 cm.','Blender previews establish source appearance only; separate gameplay/GPU acceptance is recorded in docs/ART_DEPTH.md and docs/RELEASE.md.']}
manifest['notes'].extend(['Petrol metal uses low-contrast isotropic wear, nearly flat normals and roughness between 0.43 and 0.60; crossed directional wave patterns are removed.','Six masonry planters contain rooted bougainvillea stems, connected leaf sprays and flower clusters; detached single-leaf perimeter scatter is removed.','Flush shutter surrounds, pilasters and fittings use distinct surface depths inside the 4 cm envelope to avoid coplanar black artifacts at their intersections.','The Y=0 paving grid is the only upward floor layer. The underlying slab retains sides and bottom but omits its hidden top, preventing a redundant floor-sized PBR shading pass inside the same draw.'])
(SOURCE/'environment-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
for unused_image in list(bpy.data.images):
    if not unused_image.users:bpy.data.images.remove(unused_image)
render('environment-gameplay.png',(-12,3.45,24),(0,2.15,-13),28)
# Keep the source camera at a useful gameplay review angle when the file opens.
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'environment.blend'),compress=True)
render('environment-overview.png',(61,49,66),(0,0,-4),35)
scene.render.resolution_y=844
render('environment-platform.png',(0,4.4,22),(0,3.2,-13),24)
scene.render.resolution_x=1200;scene.render.resolution_y=800
render('environment-material-detail.png',(-28,2.4,5),(-19,1.8,0),35)
render('environment-planting.png',(-29,2.4,-15),(-33.8,.9,-19),48)
print('ENVIRONMENT_EXPORT_COMPLETE',json.dumps({'file':str(OUT/'environment.glb'),'bytes':(OUT/'environment.glb').stat().st_size,'groups':list(groups),'batches':len(meshes)}))
