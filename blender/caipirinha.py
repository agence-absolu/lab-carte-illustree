"""Sprite d'un verre de caipirinha, rendu comme les arbres (build_scene.py --sprites) :
vue de biais, fond transparent, soleil du nord-ouest. Clin d'œil posé chez Fred.

Usage :
  Blender -b -P blender/caipirinha.py -- --out public/tiles/martinique/elements/sprites
Écrit caipirinha.png et ajoute son entrée à sprites.json (model −1 : jamais tiré pour un arbre).
"""

import argparse
import json
import math
import os
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Matrix

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
p = argparse.ArgumentParser()
p.add_argument('--out', required=True)
p.add_argument('--px', type=int, default=512)
p.add_argument('--elevation', type=float, default=30.0, help='hauteur de la caméra au-dessus de l\'horizon (°)')
ARGS = p.parse_args(argv)

bpy.ops.wm.read_factory_settings(use_empty=True)
SCENE = bpy.context.scene


def rgb(hexstr, a=1.0):
    h = hexstr.lstrip('#')
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, a)


def material(name, color, alpha=1.0, roughness=0.5, emission=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF') or m.node_tree.nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = rgb(color)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Alpha'].default_value = alpha
    if emission:
        bsdf.inputs['Emission Color'].default_value = rgb(color)
        bsdf.inputs['Emission Strength'].default_value = emission
    if alpha < 1.0:
        try:
            m.surface_render_method = 'BLENDED'
        except (AttributeError, TypeError):
            m.blend_method = 'BLEND'
    return m


def obj_from(bm, name, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    for poly in me.polygons:
        poly.use_smooth = True
    obj = bpy.data.objects.new(name, me)
    SCENE.collection.objects.link(obj)
    return obj


def cone(name, mat, r1, r2, depth, z0, segments=32, caps=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, segments=segments, radius1=r1, radius2=r2, depth=depth,
                          matrix=Matrix.Translation((0, 0, z0 + depth / 2)))
    return obj_from(bm, name, mat)


def tilted_disc(name, mat, r, thickness, loc, rot):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=32, radius1=r, radius2=r, depth=thickness)
    obj = obj_from(bm, name, mat)
    obj.location = loc
    obj.rotation_euler = rot
    return obj


# --- Modèle (hauteur du verre = 1) -------------------------------------------
glass = material('verre', '#d6eef0', alpha=0.38, roughness=0.04)
liquid = material('cocktail', '#d4e85a', alpha=0.85, roughness=0.15, emission=0.25)
ice = material('glacon', '#e8f6ff', alpha=0.8, roughness=0.1, emission=0.2)
rind = material('ecorce', '#2f7d18', roughness=0.45)
flesh = material('pulpe', '#a8d63a', roughness=0.35, emission=0.2)
straw = material('paille', '#fbfbf8', roughness=0.4)

cone('verre', glass, 0.36, 0.43, 1.0, 0.0, caps=False)
cone('fond', glass, 0.36, 0.36, 0.08, 0.0)
cone('cocktail', liquid, 0.345, 0.405, 0.72, 0.08)

# Quartiers de citron vert dans le verre : demi-disques épais (écorce + pulpe)
for i, (x, y, z, rz) in enumerate([(-0.12, -0.08, 0.28, 0.4), (0.13, 0.02, 0.45, 2.1), (-0.05, 0.12, 0.62, 3.6)]):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=0.17, radius2=0.17, depth=0.12)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, 0), plane_no=(0, 1, 0), clear_inner=True)
    bmesh.ops.contextual_create(bm, geom=[e for e in bm.edges if e.is_boundary])
    o = obj_from(bm, f'quartier_{i}', flesh)
    o.data.materials.append(rind)
    for poly in o.data.polygons:  # faces latérales arrondies = écorce
        poly.material_index = 1 if abs(poly.normal.z) < 0.5 and poly.normal.y > -0.5 else 0
    o.location = (x, y, z)
    o.rotation_euler = (math.radians(70), 0.3 * i, rz)

# Glaçons
for i, (x, y, z, r) in enumerate([(0.1, -0.12, 0.66, 0.3), (-0.16, 0.05, 0.72, 1.1), (0.05, 0.16, 0.78, 2.0)]):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=0.17)
    bmesh.ops.bevel(bm, geom=bm.edges[:], offset=0.02, segments=2, affect='EDGES')
    o = obj_from(bm, f'glacon_{i}', ice)
    o.location = (x, y, z)
    o.rotation_euler = (r, 0.5 * r, 0.3)

# Rondelle sur le bord, à gauche : écorce verte et pulpe claire
rim_loc = (-0.42, -0.02, 0.98)
tilted_disc('rondelle_ecorce', rind, 0.26, 0.05, rim_loc, (math.radians(90), 0, math.radians(18)))
tilted_disc('rondelle_pulpe', flesh, 0.235, 0.062, rim_loc, (math.radians(90), 0, math.radians(18)))

# Paille blanche, inclinée vers la droite
s = cone('paille', straw, 0.022, 0.022, 1.0, 0.0, segments=12)
s.location = (0.08, 0.05, 0.12)
s.rotation_euler = (0, math.radians(22), 0)

# --- Lumière et rendu (comme build_scene.py : soleil NO, ciel clair) ---------
sun = bpy.data.lights.new('soleil', 'SUN')
sun.energy = 3.5
sun.angle = math.radians(1.5)
sun_obj = bpy.data.objects.new('soleil', sun)
SCENE.collection.objects.link(sun_obj)
sun_obj.rotation_euler = (math.radians(45), 0.0, -math.radians(315 + 180))
world = bpy.data.worlds.new('ciel')
SCENE.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get('Background') or world.node_tree.nodes.new('ShaderNodeBackground')
bg.inputs['Color'].default_value = rgb('#bcd6f0')
bg.inputs['Strength'].default_value = 0.9

r = SCENE.render
r.engine = 'BLENDER_EEVEE'
SCENE.eevee.taa_render_samples = 64
r.film_transparent = True
r.filter_size = 1.0
r.image_settings.file_format = 'PNG'
r.image_settings.color_mode = 'RGBA'
r.resolution_x = r.resolution_y = ARGS.px
SCENE.view_settings.view_transform = 'Standard'
SCENE.view_settings.look = 'None'
# Contour cartoon : lignes Freestyle sur les silhouettes, bords et arêtes vives (vert sombre)
r.use_freestyle = True
r.line_thickness_mode = 'ABSOLUTE'
r.line_thickness = ARGS.px / 160
fs = bpy.context.view_layer.freestyle_settings
lineset = fs.linesets[0] if fs.linesets else fs.linesets.new('contours')
lineset.select_by_visibility = True
lineset.select_silhouette = True
lineset.select_border = True
lineset.select_crease = True
if lineset.linestyle is None:
    lineset.linestyle = bpy.data.linestyles.new('contour')
lineset.linestyle.color = rgb('#173b12')[:3]
lineset.linestyle.thickness = 1.0

# Caméra orthographique regardant vers le nord, inclinée, cadrée sur la silhouette
e = math.radians(ARGS.elevation)
right = np.array([1.0, 0.0, 0.0])
up = np.array([0.0, math.sin(e), math.cos(e)])
bpy.context.view_layer.update()
pts = np.array([o.matrix_world @ v.co for o in SCENE.objects if o.type == 'MESH' for v in o.data.vertices])
sx, sy = pts @ right, pts @ up
side = 1.06 * max(sx.max() - sx.min(), sy.max() - sy.min())
cx, cy = (sx.max() + sx.min()) / 2, (sy.max() + sy.min()) / 2
cam_data = bpy.data.cameras.new('camera')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = side
cam = bpy.data.objects.new('camera', cam_data)
SCENE.collection.objects.link(cam)
view = np.array([0.0, math.cos(e), -math.sin(e)])
cam.location = tuple(cx * right + cy * up - 10 * view)
cam.rotation_euler = (math.pi / 2 - e, 0.0, 0.0)
SCENE.camera = cam

os.makedirs(ARGS.out, exist_ok=True)
r.filepath = os.path.join(ARGS.out, 'caipirinha.png')
bpy.ops.render.render(write_still=True)

index_file = os.path.join(ARGS.out, 'sprites.json')
with open(index_file) as f:
    index = json.load(f)
# side : côté de l'image en hauteurs de verre ; footY : pied du verre (z = 0) depuis le haut
index['caipirinha'] = {'model': -1, 'side': side, 'footY': 0.5 + cy / side}
with open(index_file, 'w') as f:
    json.dump(index, f, indent=1)
print(f'[caipirinha] {r.filepath} (côté {side:.2f}, pied à {0.5 + cy / side:.2f})', flush=True)
