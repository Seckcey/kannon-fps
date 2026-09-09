"""Original Kannon Town architecture, vehicles and dressing, authored in Blender.
Run Blender 5.2 --background --python scripts/blender/generate_town.py.
The shared TypeScript map supplies every gameplay solid and stair coordinate.
"""
import bpy, math, json, random, subprocess, hashlib, os
from pathlib import Path
from collections import defaultdict
from mathutils import Vector
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'art/source'
MATERIALS = SOURCE / 'town-materials'
MATERIALS.mkdir(exist_ok=True)
MAP = json.loads(subprocess.check_output(['node', '--import', 'tsx', str(ROOT/'scripts/blender/export_map.ts')], cwd=str(ROOT)))
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
bpy.context.preferences.filepaths.save_version = 0
random.seed(81026)
rng = np.random.default_rng(81026)
def bv(p): return (p[0], -p[2], p[1])
def linear(v): return v/12.92 if v <= .04045 else ((v+.055)/1.055)**2.4
def color(hex): return tuple(linear(int(hex[i:i+2],16)/255) for i in (1,3,5))
def texture(name, rgb, data=False):
    h,w=rgb.shape[:2]; rgba=np.ones((h,w,4),np.float32); rgba[:,:,:3]=rgb
    image=bpy.data.images.new(name,width=w,height=h,alpha=False)
    image.colorspace_settings.name='Non-Color' if data else 'sRGB'
    image.pixels.foreach_set(rgba.ravel());image.file_format='PNG' if data else 'JPEG';image.filepath_raw=str(MATERIALS/(name+('.png' if data else '.jpg')))
    image.save(); image.pack();return image

def material(name, kind='plain', rough=.8, metallic=0, scale=2):
    m=bpy.data.materials.new(name);m.use_nodes=True;m.use_backface_culling=True
    bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Roughness'].default_value=rough;bs.inputs['Metallic'].default_value=metallic
    m['uvMetres']=scale
    attr=m.node_tree.nodes.new('ShaderNodeVertexColor');attr.layer_name='Color'
    if kind=='plain':
        m.node_tree.links.new(attr.outputs['Color'],bs.inputs['Base Color']);return m
    size=256;y,x=np.mgrid[:size,:size]/size;noise=rng.normal(0,.015,(size,size));h=noise.copy()
    value=np.clip(.88+noise,.7,1)
    if kind=='siding':
        course=(y*10)%1; h=course*.08; value=np.clip(.94+noise-.14*(course<.035),.65,1)
    elif kind=='wood':
        grain=np.sin(x*420+np.sin(y*12)*3)*.025+np.sin(x*97+y*1.8)*.04
        h+=grain;value=np.clip(.82+noise+grain-.1*((x*6)%1<.015),.55,1)
    elif kind=='roof':
        row=np.floor(y*8);u=(x*6+row%2*.5)%1;v=(y*8)%1
        h=.018*np.minimum(v/.03,1);value=np.clip(.73+noise+.10*np.sin(row*6+np.floor(x*6+row%2*.5)*3)-.15*((u<.025)|(v<.08)),.45,.93)
    elif kind=='grass':
        h=rng.normal(0,.045,(size,size));value=np.clip(.84+h,.6,1)
    elif kind=='paint':
        fleck=rng.random((size,size));value=np.clip(.94+noise-.25*(fleck<.012),.58,1);h=noise*.1
    elif kind=='asphalt':
        image=bpy.data.images.load(str(MATERIALS/'asphalt-generated.png'));image.name='TownAsphalt';image.scale(1024,1024)
        image.file_format='JPEG';image.filepath_raw=str(MATERIALS/'TownAsphalt.jpg');image.save();image.pack()
        tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=image
        multiply=m.node_tree.nodes.new('ShaderNodeMixRGB');multiply.blend_type='MULTIPLY';multiply.inputs[0].default_value=1
        m.node_tree.links.new(tex.outputs['Color'],multiply.inputs[1]);m.node_tree.links.new(attr.outputs['Color'],multiply.inputs[2]);m.node_tree.links.new(multiply.outputs[0],bs.inputs['Base Color'])
    if kind!='asphalt':
        rgb=np.stack([value]*3,axis=-1);image=texture(name+'Base',rgb)
        tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=image
        multiply=m.node_tree.nodes.new('ShaderNodeMixRGB');multiply.blend_type='MULTIPLY';multiply.inputs[0].default_value=1
        m.node_tree.links.new(tex.outputs['Color'],multiply.inputs[1]);m.node_tree.links.new(attr.outputs['Color'],multiply.inputs[2]);m.node_tree.links.new(multiply.outputs[0],bs.inputs['Base Color'])
    if kind not in ('plain','paint'):
        dx=(np.roll(h,-1,1)-np.roll(h,1,1))*3;dy=(np.roll(h,-1,0)-np.roll(h,1,0))*3
        normal=np.stack([-dx,-dy,np.ones_like(dx)],axis=-1);normal/=np.linalg.norm(normal,axis=2,keepdims=True)
        img=texture(name+'Normal',normal*.5+.5,True);tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=img
        nm=m.node_tree.nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.45
        m.node_tree.links.new(tex.outputs['Color'],nm.inputs['Color']);m.node_tree.links.new(nm.outputs['Normal'],bs.inputs['Normal'])
    return m

mats={
 'siding':material('TownLimestoneSiding','siding',scale=2), 'trim':material('TownLimestoneTrim',scale=2),
 'wood':material('TownGroundWood','wood',scale=2), 'roof':material('TownGroundRoof','roof',scale=2),
 'concrete':material('TownGroundConcrete',scale=3), 'asphalt':material('TownGroundAsphalt','asphalt',scale=5),
 'grass':material('TownGroundGrass','grass',scale=2), 'paint':material('TownPaint','paint',.48,.2,3),
 'glass':material('TownGlass',rough=.19,metallic=.7), 'rubber':material('TownRubber',rough=.95),
 'metal':material('TownBronzeMetal',rough=.29,metallic=.8), 'leaves':material('TownLeaves','grass',.9,0,1),
 'earth':material('TownCliffEarth','plain',.97,0,6),
}
batches=defaultdict(lambda:{'v':[],'f':[],'uv':[],'c':[]})
def poly(key, points, tint='#ffffff', uv=None):
    batch=batches[key];start=len(batch['v']);batch['v'].extend(bv(p) for p in points);batch['f'].append(tuple(range(start,start+len(points))))
    normal=(Vector(points[1])-Vector(points[0])).cross(Vector(points[2])-Vector(points[0]));axis=max(range(3),key=lambda i:abs(normal[i]));axes=[i for i in range(3) if i!=axis]
    if axis==0: axes=[2,1]
    if axis==2: axes=[0,1]
    scale=mats[key]['uvMetres'];batch['uv'].extend(uv or [(p[axes[0]]/scale,p[axes[1]]/scale) for p in points]);batch['c'].extend([(*color(tint),1)]*len(points))
def box(key, center, size, tint='#ffffff'):
    x,y,z=center;w,h,d=(v/2 for v in size)
    p=[(x-w,y-h,z-d),(x+w,y-h,z-d),(x+w,y+h,z-d),(x-w,y+h,z-d),(x-w,y-h,z+d),(x+w,y-h,z+d),(x+w,y+h,z+d),(x-w,y+h,z+d)]
    for face in [(0,3,2,1),(4,5,6,7),(0,4,7,3),(1,2,6,5),(0,1,5,4),(3,7,6,2)]:poly(key,[p[i] for i in face],tint)
def cylinder(key, center, radius, depth, tint, axis='y', segments=16):
    c=Vector(center);a={'x':Vector((1,0,0)),'y':Vector((0,1,0)),'z':Vector((0,0,1))}[axis]
    u=Vector((0,0,1)) if axis=='x' else Vector((1,0,0));v=a.cross(u)
    rings=[[tuple(c+a*end*depth/2+(u*math.cos(i*2*math.pi/segments)+v*math.sin(i*2*math.pi/segments))*radius) for i in range(segments)] for end in [-1,1]]
    for i in range(segments):j=(i+1)%segments;poly(key,[rings[0][i],rings[0][j],rings[1][j],rings[1][i]],tint)
    poly(key,list(reversed(rings[0])),tint);poly(key,rings[1],tint)
def roof(x,z,w,d,base,rise,tint='#77786d'):
    e=.32
    for side in [-1,1]:
        points=[(x-w/2-e,base,z+side*(d/2+e)),(x+w/2+e,base,z+side*(d/2+e)),(x+w/2+e,base+rise,z),(x-w/2-e,base+rise,z)]
        if side<0:points.reverse()
        poly('roof',points,tint)
        box('trim',(x,base-.04,z+side*(d/2+e)),(w+.8,.18,.14),'#e9e1cf')
    for side in [-1,1]:
        points=[(x+side*w/2,base,z-d/2),(x+side*w/2,base,z+d/2),(x+side*w/2,base+rise,z)]
        if side<0:points.reverse()
        poly('siding',points,'#d9d5c4')
def frame_x(x, z0,z1,y0,y1,side):
    for z in [z0,z1]:box('trim',(x+side*.018,(y0+y1)/2,z),(.12,y1-y0+.16,.13),'#e9e4d8')
    for y in [y0,y1]:box('trim',(x+side*.018,y,(z0+z1)/2),(.14,.13,z1-z0+.18),'#e9e4d8')

env=bpy.data.objects.new('Environment',None);bpy.context.collection.objects.link(env)
refs=bpy.data.objects.new('CollisionReferences',None);bpy.context.collection.objects.link(refs);refs.parent=env
for ob in MAP['obstacles']:
    s=ob.get('surface','trim');key={'teal':'siding','yellow':'siding','trim':'trim','wood':'wood','concrete':'concrete','bus':'paint','truck':'paint','fence':'trim','roof':'roof'}[s]
    box(key,(ob['x'],ob['y'],ob['z']),(ob['w'],ob['h'],ob['d']),ob['color'])
    ref=bpy.data.objects.new('Collision_'+ob['id'],None);bpy.context.collection.objects.link(ref);ref.parent=refs;ref.location=bv((ob['x'],ob['y'],ob['z']));ref['sizeXYZ']=[ob['w'],ob['h'],ob['d']]
    if s=='fence':
        axis='z' if ob['d']>ob['w'] else 'x';length=max(ob['d'],ob['w']);count=int(length/.23)
        for i in range(count):
            p=[ob['x'],ob['y'],ob['z']];p[2 if axis=='z' else 0]+=-length/2+(i+.5)*length/count
            size=(ob['w']+.045,ob['h']+.08,.16) if axis=='z' else (.16,ob['h']+.08,ob['d']+.045)
            box('trim',p,size,'#ebe3ce' if i%4 else '#cec7b5')

# One road plane; grass and pavement patch the ground without floating layers.
box('earth',(0,-.27,0),(220,.5,220),'#a29176')
box('asphalt',(0,-.025,0),(17.8,.05,46),'#ddddda')
for side in [-1,1]:
    x=lambda u:side*u
    box('grass',(x(20),-.025,0),(22,.05,46),'#718c44')
    box('concrete',(x(9.55),.015,0),(1.3,.03,46),'#c5c2b8')
    box('concrete',(x(11.2),.018,-2.25),(4.4,.036,2.3),'#ccc8ba')
    box('concrete',(x(9.6),.019,9.75),(3.2,.038,5.4),'#c3c0b3')
    box('wood',(x(16),.02,0),(11.72,.04,11.72),'#a9906a')
    box('concrete',(x(14),.024,9.75),(7.72,.048,7.22),'#a9a99f')
    roof(x(16),0,12.3,12.3,6.42,1.65)
    roof(x(14),9.75,8.5,7.75,3.29,.7)
    roof(x(28),16,4.4,3.7,2.6,.6)
    for y in [0.12,3.05,6.2]:
        box('trim',(x(9.82),y,0),(.16,.16,12.35),'#e8dfcc')
        box('trim',(x(22.18),y,0),(.16,.16,12.35),'#e8dfcc')
    frame_x(x(9.8),-3.4,-1.1,0,2.65,-side);frame_x(x(9.8),1,4.7,.95,2.5,-side)
    frame_x(x(9.8),-3.4,3.4,4.15,5.85,-side);frame_x(x(22.2),3.1,5.3,3.2,5.9,side)
    # Open windows have only frames and sill; shots and sightlines pass through.
    for z in [-1.1,1.1]:box('trim',(x(9.75),5,z),(.16,1.7,.08),'#ece5d4')
    box('trim',(x(9.73),4.12,0),(.32,.12,7),'#e6ddc7')
    box('trim',(x(9.75),2.72,-2.25),(.52,.12,2.65),'#e2d8c2')
    for z in [-5.92,5.92]:box('trim',(x(9.82),3.15,z),(.22,6.3,.22),'#e9e1d0')
    # Stair handrails are outside the walk corridor.
    for i in range(10):
        z=-4+i*.8;y=(i+1)*.32
        for u in [23,25.7]:box('trim',(x(u),y+.44,z),(.07,.9,.07),'#e3ddce')
    for z in [3.2,3.65,4.1,4.55,5,5.45,5.85]:box('trim',(x(26.17),3.8,z),(.07,1.1,.075),'#eee4d1')
    # Garage roller frame and visible workshop details.
    for z in [7.05,12.55]:box('trim',(x(9.8),1.35,z),(.22,2.7,.19),'#ece3d0')
    box('trim',(x(9.8),2.7,9.8),(.22,.22,5.75),'#ece3d0')
    box('metal',(x(17.7),1.2,12.3),(.15,1.8,1.6),'#536863')
    for y in [.5,1.1,1.7]:box('wood',(x(17.48),y,12.3),(.38,.08,1.7),'#a9926a')
    for i in range(4):box('paint',(x(17.2),.72+i*.23,12.2),(.48,.18,1.1),'#56685c')
    # Ceiling lamps and simple original framed prints, no borrowed imagery.
    for u,z in [(13,0),(19,3.8)]:
        cylinder('metal',(x(u),2.72,z),.18,.12,'#bbb49e')
        cylinder('trim',(x(u),2.63,z),.13,.06,'#f0dba5')
    box('wood',(x(12.4),1.6,-5.81),(1.15,.9,.075),'#75604c');box('paint',(x(12.4),1.6,-5.76),(.99,.73,.015),'#729896')
    # Original chimney with stone bands.
    box('concrete',(x(19.6),7.3,-3.2),(1.1,3.1,1.15),'#a69b86')
    for y in np.arange(5.85,8.9,.25):box('trim',(x(19.6),float(y),-3.2),(1.14,.04,1.19),'#958d7e')
    box('trim',(x(19.6),8.89,-3.2),(1.4,.15,1.4),'#d0c9b8')
    # Footpaths around rear deck, warm dry borders, lawn mowing bands.
    box('concrete',(x(27.3),.014,3.5),(1.65,.028,19),'#bbb7a8')
    for z in np.arange(-21,22,3):box('grass',(x(28),.004,float(z)),(5.5,.008,1.25),'#7f944f')

def wheel(x,y,z,r=.57):
    cylinder('rubber',(x,y,z),r,.31,'#252724','x',24)
    cylinder('metal',(x+(.17 if x>0 else -.17),y,z),r*.58,.045,'#9b9e96','x',20)
    cylinder('rubber',(x+(.2 if x>0 else -.2),y,z),r*.19,.052,'#525750','x',16)
    for i in range(8):
        a=i*math.tau/8;cylinder('metal',(x+(.2 if x>0 else -.2),y+math.sin(a)*r*.37,z+math.cos(a)*r*.37),.032,.055,'#434a47','x',6)

# School bus: repetitive windows, inset rubber seals, roof ribs, bumpers,
# wheels and grilles retain a recognizable silhouette in a single paint batch.
for side in [-1,1]:
    wx=-2.4+side*1.515
    for i in range(10):
        z=-8.55+i*.86
        box('rubber',(wx,2.15,z),(.028,.89,.77),'#323c36')
        box('glass',(wx+side*.018,2.17,z),(.022,.72,.65),'#6d8e90')
        box('trim',(wx+side*.032,2.17,z),(.03,.035,.67),'#c2c6b9')
    for y in [.85,1.05,1.5]:box('rubber',(wx+side*.025,y,-4.45),(.05,.09,9.72),'#464d3f')
    for z in [-7.6,-.75]:wheel(-2.4+side*1.48,.6,z,.62)
for z in [-8.2,-6.4,-4.6,-2.8,-1,.35]:box('paint',(-2.4,3.015,z),(3.04,.06,.06),'#b79953')
box('rubber',(-2.4,.55,-10.94),(3.05,.22,.18),'#51574b')
box('metal',(-2.4,.9,-10.92),(1.82,.62,.03),'#a3a796')
for y in [.66,.79,.92,1.05,1.18]:box('rubber',(-2.4,y,-10.948),(1.75,.047,.02),'#35433a')
for x in [-3.52,-1.28]:
    cylinder('metal',(x,1.06,-10.96),.17,.06,'#c9cabb','z');cylinder('trim',(x,1.06,-11),.12,.03,'#eee6bd','z')
box('glass',(-2.4,2.22,-9.318),(2.61,1.12,.035),'#627c7b')
box('trim',(-2.4,2.22,-9.35),(.07,1.2,.05),'#cab575')

# Moving truck has a real open cargo hold. Its colored stripe wraps the sides.
for side in [-1,1]:
    x=2.65+side*1.76
    box('paint',(x,.99,6.32),(.035,.82,7.55),'#65958c')
    for z in [3,4.4,5.8,7.2,8.6,9.9]:box('metal',(x+side*.02,1.81,z),(.035,2.53,.035),'#b5b7a7')
    for z in [.6,8.55]:wheel(2.65+side*1.56,.57,z,.57)
    box('glass',(2.65+side*1.565,1.92,1.05),(.026,.91,1.73),'#577772')
box('glass',(2.65,1.91,-.123),(2.71,.89,.035),'#638782')
box('metal',(2.65,.46,-.19),(3.35,.25,.2),'#b2b4a4')
for x in [1.46,3.84]:box('trim',(x,.88,-.15),(.32,.27,.08),'#ebddbb')
for x,z in [(1.7,3.3),(3.4,3.7)]:
    for y in [.44,1.06]:box('trim',(x,y,z+.405),(.69,.06,.035),'#baa877')
box('metal',(2.65,.35,10.16),(3.2,.06,.28),'#a5aa9d')

# Small parked cars have glazing, contrasting tires and bumpers.
for x,z,tint in [(-3.9,16.2,'#629a91'),(4,-17.4,'#cbb06b')]:
    box('glass',(x,1.53,z-.912),(2.26,.48,.035),'#657f7c');box('glass',(x,1.53,z+.912),(2.26,.48,.035),'#657f7c')
    for dx in [-1.65,1.65]:
        for dz in [-.95,.95]:cylinder('rubber',(x+dx,.44,z+dz),.44,.2,'#30322c','z',20)
    for dx in [-2.4,2.4]:box('metal',(x+dx,.48,z),(.13,.16,1.98),'#b6b6a4')

# Low-detail out-of-bounds planting and distant dry hills frame the one map.
for i in range(18):
    x=random.choice([-1,1])*random.uniform(33,47);z=random.uniform(-34,34);height=random.uniform(5,8)
    cylinder('wood',(x,height/2,z),.16,height,'#8c8066',segments=10)
    for j in range(5):
        a=j*math.tau/5;cx=x+math.cos(a)*1.2;cz=z+math.sin(a)*1.2;cy=height+random.uniform(-.3,.6)
        for k in range(8):
            angle=k*math.tau/8;tip=(cx+math.cos(angle)*1.9,cy-random.uniform(.2,.8),cz+math.sin(angle)*1.9)
            across=Vector((-math.sin(angle)*.28,0,math.cos(angle)*.28));base=Vector((cx,cy,cz))
            poly('leaves',[tuple(base-across),tuple(base+across),tip],random.choice(['#65784c','#879458','#63744e']))
            poly('leaves',[tip,tuple(base+across),tuple(base-across)],'#71804d')
# A continuous eroded ridge avoids repeated cone silhouettes on the horizon.
rings=[]
for r,factor in [(68,0),(92,.22),(122,.78),(153,1),(193,.44),(235,0)]:
    rings.append([(math.cos(a)*r, -.25+factor*(21+7*math.sin(a*3+.7)+5*math.sin(a*7)+2*math.sin(a*17)), math.sin(a)*r) for a in [i*math.tau/128 for i in range(128)]])
for row in range(len(rings)-1):
    for i in range(128):
        j=(i+1)%128
        poly('earth',[rings[row][i],rings[row+1][i],rings[row+1][j],rings[row][j]],random.choice(['#b8a88f','#b9aa93','#b3a28a']))
# Broadleaf trees supplement the palms with layered, volumetric crowns.
for side in [-1,1]:
    for z in [-26,-11,11,28]:
        x=side*random.uniform(34,39);cylinder('wood',(x,2.5,z),.25,5,'#726451',segments=10)
        for j in range(5):
            cx=x+math.cos(j*2.4)*1.15;cz=z+math.sin(j*2.4)*1.15;cy=5.2+random.uniform(-.4,.8)
            for band in range(6):
                for k in range(10):
                    points=[]
                    for row,column in [(band,k),(band+1,k),(band+1,k+1),(band,k+1)]:
                        a=column*math.tau/10;t=row*math.pi/6;radius=1+.07*math.sin(column*4+row*3)
                        points.append((cx+math.sin(t)*math.cos(a)*1.75*radius,cy+math.cos(t)*1.55,cz+math.sin(t)*math.sin(a)*1.75*radius))
                    poly('leaves',list(reversed(points)),random.choice(['#6d8052','#738557','#647a4b','#80905c']))

meshes=[];triangles=0
for key,batch in batches.items():
    mesh=bpy.data.meshes.new('Town_'+key);mesh.from_pydata(batch['v'],[],batch['f']);mesh.update()
    obj=bpy.data.objects.new('Horizon_Town_'+key if key=='earth' else 'Town_'+key,mesh);bpy.context.collection.objects.link(obj);obj.parent=env;mesh.materials.append(mats[key])
    uv=mesh.uv_layers.new(name='UVMap');col=mesh.color_attributes.new(name='Color',type='FLOAT_COLOR',domain='CORNER')
    for polygon in mesh.polygons:
        for loop in polygon.loop_indices:
            index=mesh.loops[loop].vertex_index;uv.data[loop].uv=batch['uv'][index];col.data[loop].color=batch['c'][index]
    mesh.calc_loop_triangles();triangles+=len(mesh.loop_triangles);meshes.append(obj)
assert triangles<=70000,triangles
for obj in bpy.context.selected_objects:obj.select_set(False)
env.select_set(True);refs.select_set(True)
for obj in [*meshes,*refs.children]:obj.select_set(True)
out=ROOT/'public/models/environment.glb'
staged=out.with_name('environment.town-staged.glb')
bpy.ops.export_scene.gltf(filepath=str(staged),export_format='GLB',use_selection=True,export_apply=True,export_yup=True,export_extras=True,export_animations=False,export_cameras=False,export_lights=False,export_vertex_color='NAME',export_vertex_color_name='Color',export_all_vertex_colors=False)
payload=staged.read_bytes()
assert payload[:4]==b'glTF' and int.from_bytes(payload[8:12],'little')==len(payload) and len(payload)<=7_000_000
staged.replace(out)
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=24
scene.world.use_nodes=True
scene.world.node_tree.nodes.get('Background').inputs['Color'].default_value=(.34,.55,.8,1)
scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.65
sun_data=bpy.data.lights.new('PreviewSun','SUN');sun_data.energy=3
sun=bpy.data.objects.new('PreviewSun',sun_data);bpy.context.collection.objects.link(sun);sun.rotation_euler=(.48,-.4,-.62)
area_data=bpy.data.lights.new('PreviewFill','AREA');area_data.energy=900;area_data.shape='DISK';area_data.size=40
area=bpy.data.objects.new('PreviewFill',area_data);bpy.context.collection.objects.link(area);area.location=bv((0,22,0))
camera_data=bpy.data.cameras.new('TownPreviewCamera');camera=bpy.data.objects.new('TownPreviewCamera',camera_data);bpy.context.collection.objects.link(camera);scene.camera=camera;camera_data.lens=24
scene.render.resolution_x=1280;scene.render.resolution_y=720;scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'kannon-town.blend'))
manifest={'name':MAP['name'],'bytes':out.stat().st_size,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'triangles':triangles,'batches':len(meshes),'collisionReferences':len(MAP['obstacles']),'mapSha256':hashlib.sha256((ROOT/'shared/map.ts').read_bytes()).hexdigest(),'source':'art/source/kannon-town.blend','generator':'scripts/blender/generate_town.py','inspiration':'Nuketown functional arrangement; original Blender geometry and material art','asphalt':'Image Gen original albedo; see town-materials/asphalt-generated.png'}
(SOURCE/'town-export.json').write_text(json.dumps(manifest,indent=2)+'\n')
if os.environ.get('KANNON_TOWN_PREVIEW')=='1':
    for name,pos,target in [('town-street',(0,6.2,22),(-2,2,0)),('town-overview',(38,31,33),(0,1,0)),('town-interior',(-12.2,1.9,3),(-19,1.3,0))]:
        camera.location=bv(pos);camera.rotation_euler=(Vector(bv(target))-camera.location).to_track_quat('-Z','Y').to_euler();scene.render.filepath=str(SOURCE/(name+'.png'));bpy.ops.render.render(write_still=True)
print('KANNON_TOWN_EXPORT',json.dumps(manifest))
