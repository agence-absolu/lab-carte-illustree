"""Construit la scène illustrée depuis data/ et rend les blocs de tuiles.

Usage :
  Blender -b -P blender/build_scene.py -- --season summer [--chunks 0,0 1,0]
          [--save-blend] [--no-render] [--samples 32] [--view AgX]

Coordonnées : mètres Mercator locaux (origine = coin sud-ouest de l'emprise des
tuiles, x vers l'est, y vers le nord). Les hauteurs sont multipliées par
k = 1/cos(lat) pour garder les proportions dans l'espace Mercator.
"""

import argparse
import json
import math
import os
import sys
import time

import bpy
import bmesh
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--season', default='summer', help='variante : summer, winter (alpin) ou jour (tropical)')
    p.add_argument('--data', default=os.path.join(ROOT, 'data'))
    p.add_argument('--out', default=os.path.join(ROOT, 'output'))
    p.add_argument('--chunks', nargs='*', help='blocs à rendre « cx,cy » (tous par défaut)')
    p.add_argument('--terrain-step', type=int, default=2, help='sous-échantillonnage du MNT (px)')
    p.add_argument('--ortho-mix', type=float, default=None,
                   help='part de la couleur photo (guide flouté) dans le sol, 0–1 (défaut 0,3 ; 0,12 en hiver)')
    p.add_argument('--guide-factor', type=int, default=4, help='réduction de l\'ortho pour le guide de couleur')
    p.add_argument('--samples', type=int, default=32)
    p.add_argument('--filter-size', type=float, default=1.0, help='filtre de reconstruction (px)')
    p.add_argument('--scale', type=int, default=None, help='densité de rendu (défaut : renderScale de la région ; 2 = HD @2x)')
    p.add_argument('--view', default='Standard', help='transformée de vue (AgX, Standard…)')
    p.add_argument('--sun-elevation', type=float, default=None, help='hauteur du soleil (défaut 35° ; 45° sous les tropiques)')
    p.add_argument('--sun-azimuth', type=float, default=315.0, help='direction d\'où vient le soleil (° depuis le nord)')
    p.add_argument('--sky', type=float, default=None, help='intensité de la lumière du ciel (défaut 0,55 ; 0,65 tropical)')
    p.add_argument('--sun', type=float, default=3.5, help='intensité du soleil')
    p.add_argument('--exposure', type=float, default=None, help='exposition (défaut 0 ; −0,3 en hiver)')
    p.add_argument('--save-blend', action='store_true')
    p.add_argument('--no-render', action='store_true')
    p.add_argument('--seed', type=int, default=1)
    return p.parse_args(argv)


ARGS = parse_args()
WINTER = ARGS.season == 'winter'
RNG = np.random.default_rng(ARGS.seed)


def log(msg):
    print(f'[scene] {msg}', flush=True)


# ---------------------------------------------------------------------------
# Données

with open(os.path.join(ARGS.data, 'region.json')) as f:
    META = json.load(f)

K = META['k']
TROPICAL = META.get('climate') == 'tropical'
LX0, LY0, LX1, LY1 = META['localBbox']
DEM_W, DEM_H = META['dem']['width'], META['dem']['height']
DEM_PX = META['dem']['pxM']
DEM = np.fromfile(os.path.join(ARGS.data, META['dem']['file']), dtype='<f4').reshape(DEM_H, DEM_W)
ALT0 = float(DEM.min())  # altitude de référence (z = 0)
SEA_Z = (0.0 - ALT0) * K  # niveau de la mer (z Blender)
OPEN_SEA = '#0b3f78'  # mer profonde, identique au fond tropical de la visionneuse


def ground_z(x, y):
    """Hauteur du terrain (z Blender) aux points locaux x, y — interpolation bilinéaire."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    fi = np.clip((x - LX0) / DEM_PX - 0.5, 0, DEM_W - 1.001)
    fj = np.clip((LY1 - y) / DEM_PX - 0.5, 0, DEM_H - 1.001)
    i0 = np.floor(fi).astype(int)
    j0 = np.floor(fj).astype(int)
    di = fi - i0
    dj = fj - j0
    a = DEM[j0, i0] * (1 - di) + DEM[j0, i0 + 1] * di
    b = DEM[j0 + 1, i0] * (1 - di) + DEM[j0 + 1, i0 + 1] * di
    return (a * (1 - dj) + b * dj - ALT0) * K


def uv_of(x, y):
    return (x - LX0) / (LX1 - LX0), (y - LY0) / (LY1 - LY0)


with open(os.path.join(ARGS.data, META['vectors']['file'])) as f:
    VECTORS = json.load(f)
with open(os.path.join(ARGS.data, META['trees']['file'])) as f:
    TREES = json.load(f)


def lines_of(geom):
    if geom['type'] == 'LineString':
        return [geom['coordinates']]
    if geom['type'] == 'MultiLineString':
        return geom['coordinates']
    return []


def polys_of(geom):
    if geom['type'] == 'Polygon':
        return [geom['coordinates']]
    if geom['type'] == 'MultiPolygon':
        return geom['coordinates']
    return []


def points_in_ring(px, py, ring):
    """Test point-dans-polygone vectorisé (lancer de rayon)."""
    ring = np.asarray(ring)[:, :2]
    inside = np.zeros(px.shape, dtype=bool)
    xj, yj = ring[-1]
    for xi, yi in ring:
        cond = (yi > py) != (yj > py)
        with np.errstate(divide='ignore', invalid='ignore'):
            xint = (xj - xi) * (py - yi) / (yj - yi) + xi
        inside ^= cond & (px < xint)
        xj, yj = xi, yi
    return inside


# ---------------------------------------------------------------------------
# Scène vide

bpy.ops.wm.read_factory_settings(use_empty=True)
SCENE = bpy.context.scene


def link(obj):
    SCENE.collection.objects.link(obj)
    return obj


def mesh_object(name, verts, faces, uvs=None, mat=None):
    """Objet maillé depuis des tableaux numpy (verts N×3, faces M×n de même taille)."""
    me = bpy.data.meshes.new(name)
    verts = np.asarray(verts, dtype=np.float32)
    faces = np.asarray(faces, dtype=np.int32)
    nf, nside = faces.shape
    me.vertices.add(len(verts))
    me.vertices.foreach_set('co', verts.ravel())
    me.loops.add(nf * nside)
    me.loops.foreach_set('vertex_index', faces.ravel())
    me.polygons.add(nf)
    me.polygons.foreach_set('loop_start', np.arange(0, nf * nside, nside, dtype=np.int32))
    me.polygons.foreach_set('loop_total', np.full(nf, nside, dtype=np.int32))
    if uvs is not None:
        layer = me.uv_layers.new(name='UVMap')
        layer.data.foreach_set('uv', np.asarray(uvs, dtype=np.float32)[faces.ravel()].ravel())
    me.update(calc_edges=True)
    me.validate()
    if mat:
        me.materials.append(mat)
    return link(bpy.data.objects.new(name, me))


def bmesh_object(name, bm, mat=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if mat:
        me.materials.append(mat)
    return link(bpy.data.objects.new(name, me))


# ---------------------------------------------------------------------------
# Matériaux (petits utilitaires de nœuds)

class Nodes:
    def __init__(self, name):
        self.mat = bpy.data.materials.new(name)
        if not self.mat.node_tree:
            self.mat.use_nodes = True
        self.nt = self.mat.node_tree
        self.nt.nodes.clear()
        self.out = self.nt.nodes.new('ShaderNodeOutputMaterial')

    def node(self, kind, **props):
        n = self.nt.nodes.new(kind)
        for k, v in props.items():
            if k in n.inputs.keys():
                n.inputs[k].default_value = v
            else:
                setattr(n, k, v)
        return n

    def link(self, a, b):
        self.nt.links.new(a, b)

    def mix(self, fac, a, b, blend='MIX'):
        """Mélange de couleurs ; fac, a, b : socket ou valeur."""
        n = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend)
        for ident, v in (('Factor_Float', fac), ('A_Color', a), ('B_Color', b)):
            sock = next(s for s in n.inputs if s.identifier == ident)
            if isinstance(v, bpy.types.NodeSocket):
                self.link(v, sock)
            else:
                sock.default_value = v
        return next(s for s in n.outputs if s.identifier == 'Result_Color')

    def math(self, op, a, b=0.0, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if isinstance(v, bpy.types.NodeSocket):
                self.link(v, n.inputs[i])
            else:
                n.inputs[i].default_value = v
        return n.outputs[0]

    def noise(self, vector, scale, detail=2.0, roughness=0.5, out='Fac'):
        n = self.node('ShaderNodeTexNoise')
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = roughness
        self.link(vector, n.inputs['Vector'])
        return n.outputs[out]

    def voronoi(self, vector, scale, out='Distance'):
        n = self.node('ShaderNodeTexVoronoi')
        n.inputs['Scale'].default_value = scale
        self.link(vector, n.inputs['Vector'])
        return n.outputs[out]

    def bump(self, height, strength, distance=0.3):
        n = self.node('ShaderNodeBump')
        n.inputs['Strength'].default_value = strength
        n.inputs['Distance'].default_value = distance
        self.link(height, n.inputs['Height'])
        return n.outputs['Normal']

    def smooth(self, x, lo, hi):
        """smoothstep(lo, hi, x) via Map Range."""
        n = self.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP')
        n.inputs['From Min'].default_value = lo
        n.inputs['From Max'].default_value = hi
        self.link(x, n.inputs['Value'])
        return n.outputs['Result']

    def ramp(self, x, stops):
        """Rampe de couleurs : stops = [(position, couleur), …]."""
        n = self.node('ShaderNodeValToRGB')
        els = n.color_ramp.elements
        els[0].position, els[0].color = stops[0]
        els[1].position, els[1].color = stops[1]
        for pos, col in stops[2:]:
            e = els.new(pos)
            e.color = col
        self.link(x, n.inputs['Fac'])
        return n.outputs['Color']

    def bsdf(self, color, roughness=0.9, specular=0.1, normal=None, output=True):
        p = self.node('ShaderNodeBsdfPrincipled')
        if normal is not None:
            self.link(normal, p.inputs['Normal'])
        if isinstance(color, bpy.types.NodeSocket):
            self.link(color, p.inputs['Base Color'])
        else:
            p.inputs['Base Color'].default_value = color
        p.inputs['Roughness'].default_value = roughness
        p.inputs['Specular IOR Level'].default_value = specular
        if output:
            self.link(p.outputs[0], self.out.inputs['Surface'])
        return p


def rgb(hexstr, a=1.0):
    """Couleur hexadécimale sRGB → linéaire."""
    h = hexstr.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c) + (a,)


def load_image(name, colorspace='sRGB'):
    img = bpy.data.images.load(os.path.join(ARGS.data, name))
    img.colorspace_settings.name = colorspace
    return img


def image_node(m, img, uv=None, interpolation='Linear'):
    # 'Cubic' est une B-spline dans Blender : elle lisse la texture au lieu de l'affiner
    t = m.node('ShaderNodeTexImage', interpolation=interpolation, extension='EXTEND')
    t.image = img
    if uv is not None:
        m.link(uv, t.inputs['Vector'])
    return t


ORTHO = load_image(META['ortho']['file'])
CANOPY = load_image(META['canopy']['file'], 'Non-Color')
MASKS = load_image(META['masks']['file'], 'Non-Color') if 'masks' in META else None  # R plage, G canne, B cultures, A sol nu
if MASKS is not None:
    MASKS.alpha_mode = 'CHANNEL_PACKED'  # A est une donnée : ne pas prémultiplier RVB
SEABED = load_image(META['seabed']['file']) if 'seabed' in META else None  # fond marin sans bateaux

# Guide de couleur : ortho réduite (~1 m/px), interpolée linéairement, donc floue.
# Elle ne donne que les teintes à grande échelle ; le détail fin est procédural.
GUIDE = ORTHO.copy()
GUIDE.name = 'ortho_guide'
GUIDE.scale(max(1, ORTHO.size[0] // ARGS.guide_factor), max(1, ORTHO.size[1] // ARGS.guide_factor))


def ground_material():
    """Sol procédural guidé par l'ortho.

    Les teintes à grande échelle (herbe, terre nue, éboulis) viennent de l'ortho
    floutée ; le détail fin (touffes, gravier, micro-relief) est procédural, donc
    net à toutes les échelles et indépendant de la résolution de la photo.
    """
    m = Nodes('sol')
    uv = m.node('ShaderNodeUVMap', uv_map='UVMap').outputs['UV']
    guide = image_node(m, GUIDE, uv).outputs['Color']
    canopy = image_node(m, CANOPY, uv).outputs['Color']

    geo = m.node('ShaderNodeNewGeometry')
    pos = geo.outputs['Position']  # mètres Mercator : échelle de bruit s → motifs de ~1/s m
    nz = m.node('ShaderNodeSeparateXYZ')
    m.link(geo.outputs['Normal'], nz.inputs[0])
    slope = m.math('SUBTRACT', 1.0, nz.outputs['Z'])

    large = m.noise(pos, 0.03, 3.0)          # taches de ~30 m
    mid = m.noise(pos, 0.25, 3.0)            # ~4 m
    fine = m.noise(pos, 0.9, 4.0, 0.65)      # ~1 m : grain visible au zoom max (≈ 3 px en z19)
    tufts = m.voronoi(pos, 0.6)              # touffes d'herbe / cailloux (~1,7 m)

    if not WINTER:
        mix = 0.3 if ARGS.ortho_mix is None else ARGS.ortho_mix
        hsv = m.node('ShaderNodeHueSaturation')
        hsv.inputs['Saturation'].default_value = 1.1
        hsv.inputs['Value'].default_value = 1.15
        m.link(guide, hsv.inputs['Color'])
        photo = hsv.outputs['Color']

        # Masques déduits du guide : « verdeur » (G − moyenne R, B) et luminosité
        rgbs = m.node('ShaderNodeSeparateColor')
        m.link(guide, rgbs.inputs['Color'])
        rb = m.math('MULTIPLY', m.math('ADD', rgbs.outputs['Red'], rgbs.outputs['Blue']), 0.5)
        # Seuils serrés : seules les zones nettement non vertes deviennent de la terre nue
        green = m.smooth(m.math('SUBTRACT', rgbs.outputs['Green'], rb), -0.012, 0.006)
        steep = m.smooth(slope, 0.12, 0.35)
        under = m.smooth(canopy, 0.1, 0.55)

        grass = m.mix(large, rgb('#78a043'), rgb('#98b655'))
        grass = m.mix(m.math('MULTIPLY', mid, 0.6), grass, rgb('#6c9440'))
        bare = m.mix(mid, rgb('#c9bc9c'), rgb('#b0a285'))
        rock = m.mix(mid, rgb('#a6a095'), rgb('#8b857b'))
        forest = m.mix(large, rgb('#3c5728'), rgb('#4b6830'))

        base = m.mix(green, bare, grass)
        base = m.mix(steep, base, rock)
        base = m.mix(m.math('MULTIPLY', under, 0.9), base, forest)
        color = m.mix(mix, base, photo)

        # Détail fin : modulation de luminosité (touffes + grain) et micro-relief
        grain = m.math('ADD', m.math('MULTIPLY', fine, 0.6), m.math('MULTIPLY', tufts, 0.4))
        shade = m.math('ADD', 0.7, m.math('MULTIPLY', grain, 0.6))
        color = m.mix(1.0, color, shade, 'MULTIPLY')
        m.bsdf(color, 0.95, 0.05, m.bump(grain, 0.45, 0.5))
    else:
        mix = 0.12 if ARGS.ortho_mix is None else ARGS.ortho_mix
        snow = m.mix(large, rgb('#f3f6fa'), rgb('#e6edf5'))
        # Un soupçon du guide en niveaux de gris pour garder du modelé
        gray = m.node('ShaderNodeRGBToBW')
        m.link(guide, gray.inputs['Color'])
        relief = m.mix(mix, snow, m.mix(0.5, snow, gray.outputs['Val'], 'MULTIPLY'))
        rock = m.mix(mid, rgb('#8a8580'), rgb('#77726c'))
        rocky = m.smooth(slope, 0.35, 0.5)
        base = m.mix(rocky, relief, rock)
        # Sous les arbres : neige un peu plus terne (puits d'arbres)
        color = m.mix(m.math('MULTIPLY', canopy, 0.25), base, rgb('#b8c2c8'))
        # Neige travaillée par le vent : ondulations légères
        wind = m.noise(pos, 0.6, 2.0, 0.4)
        m.bsdf(color, 0.6, 0.3, m.bump(m.math('ADD', wind, m.math('MULTIPLY', fine, 0.3)), 0.12))
    return m.mat


def ground_material_tropical():
    """Sol tropical : herbe, latérite, sable, sous-bois ; mer colorée selon la profondeur.

    Même principe que le sol alpin (teintes guidées par l'ortho floutée, détail fin
    procédural). Sous le niveau de la mer, couleur d'après la bathymétrie, motifs
    du fond (récifs, herbiers) repris de l'ortho, écume au rivage, vaguelettes.
    """
    m = Nodes('sol')
    uv = m.node('ShaderNodeUVMap', uv_map='UVMap').outputs['UV']
    guide = image_node(m, GUIDE, uv).outputs['Color']
    canopy = image_node(m, CANOPY, uv).outputs['Color']

    geo = m.node('ShaderNodeNewGeometry')
    pos = geo.outputs['Position']
    nz = m.node('ShaderNodeSeparateXYZ')
    m.link(geo.outputs['Normal'], nz.inputs[0])
    pz = m.node('ShaderNodeSeparateXYZ')
    m.link(pos, pz.inputs[0])
    slope = m.math('SUBTRACT', 1.0, nz.outputs['Z'])
    # Hauteur au-dessus de la mer, en mètres réels (négative = profondeur)
    height = m.math('DIVIDE', m.math('SUBTRACT', pz.outputs['Z'], SEA_Z), K)

    large = m.noise(pos, 0.03, 3.0)
    mid = m.noise(pos, 0.25, 3.0)
    fine = m.noise(pos, 0.9, 4.0, 0.65)
    tufts = m.voronoi(pos, 0.6)
    grain = m.math('ADD', m.math('MULTIPLY', fine, 0.6), m.math('MULTIPLY', tufts, 0.4))

    rgbs = m.node('ShaderNodeSeparateColor')
    m.link(guide, rgbs.inputs['Color'])
    lum = m.node('ShaderNodeRGBToBW')
    m.link(guide, lum.inputs['Color'])

    # --- Terre --------------------------------------------------------------
    mix = 0.3 if ARGS.ortho_mix is None else ARGS.ortho_mix
    hsv = m.node('ShaderNodeHueSaturation')
    hsv.inputs['Saturation'].default_value = 1.15
    hsv.inputs['Value'].default_value = 1.1
    m.link(guide, hsv.inputs['Color'])
    photo = hsv.outputs['Color']

    # Verdeur G − R (la brume bleuit l'ortho : pas de 2G − R − B)
    green = m.smooth(m.math('SUBTRACT', rgbs.outputs['Green'], rgbs.outputs['Red']), -0.03, 0.005)
    # Sous les tropiques, les pentes raides restent végétalisées : roche seulement sur les à-pics
    steep = m.smooth(slope, 0.5, 0.75)
    under = m.smooth(canopy, 0.1, 0.55)

    grass = m.mix(large, rgb('#6aa83c'), rgb('#8cc152'))
    grass = m.mix(m.math('MULTIPLY', mid, 0.6), grass, rgb('#5c9636'))
    laterite = m.mix(mid, rgb('#b88a5c'), rgb('#9f7048'))
    rock = m.mix(mid, rgb('#9d968a'), rgb('#857e73'))
    forest = m.mix(large, rgb('#2c5726'), rgb('#3b6a2e'))
    sand = m.mix(mid, rgb('#f1e4c0'), rgb('#e2d0a2'))

    base = m.mix(green, laterite, grass)
    base = m.mix(steep, base, rock)
    base = m.mix(m.math('MULTIPLY', under, 0.9), base, forest)
    # Plage : estran sableux BD TOPO, ou rivage clair à moins de ~1,5 m d'altitude
    beach = m.math('MULTIPLY', m.smooth(lum.outputs['Val'], 0.3, 0.45), m.smooth(height, 1.8, 0.6))
    if MASKS is not None:
        masks = image_node(m, MASKS, uv).outputs['Color']
        mr = m.node('ShaderNodeSeparateColor')
        m.link(masks, mr.inputs['Color'])
        beach = m.math('MAXIMUM', beach, m.smooth(mr.outputs['Red'], 0.2, 0.6))
        # Canne à sucre (RPG) : couvert dense vert-jaune là où l'ortho est verte ;
        # parcelles récoltées (non vertes) laissées en terre.
        cane_zone = m.smooth(mr.outputs['Green'], 0.3, 0.7)
        # Touffes (~0,8 m) et ombres entre tiges : texture dense, vert tendre un peu passé
        clumps = m.voronoi(pos, 1.3)
        cane = m.mix(m.noise(pos, 0.4, 3.0), rgb('#7c9c48'), rgb('#94b05a'))
        cane = m.mix(m.smooth(clumps, 0.15, 0.6), rgb('#56783a'), cane)
        cane = m.mix(m.math('MULTIPLY', m.noise(pos, 3.0, 2.0), 0.35), cane, rgb('#b3c47c'))
        base = m.mix(m.math('MULTIPLY', cane_zone, green), base, cane)
        # Sol nu WorldCover (A) : galets des lits de rivière, coulées, carrières
        stones = m.voronoi(pos, 1.1)
        gravel = m.mix(m.noise(pos, 0.3, 3.0), rgb('#bdb7ab'), rgb('#9c968b'))
        gravel = m.mix(m.smooth(stones, 0.05, 0.35), rgb('#7d786f'), gravel)
        bare_zone = m.smooth(image_node(m, MASKS, uv).outputs['Alpha'], 0.25, 0.6)
        base = m.mix(bare_zone, base, gravel)
    base = m.mix(beach, base, sand)
    land = m.mix(mix, base, photo)
    shade = m.math('ADD', 0.7, m.math('MULTIPLY', grain, 0.6))
    land = m.mix(1.0, land, shade, 'MULTIPLY')
    land_bsdf = m.bsdf(land, 0.95, 0.05, m.bump(grain, 0.45, 0.5), output=False)

    # --- Mer ----------------------------------------------------------------
    depth = m.math('MULTIPLY', height, -1.0)
    water = m.ramp(m.math('DIVIDE', depth, 50.0, clamp=True), [
        (0.0, rgb('#9beedd')),
        (0.03, rgb('#46cdc9')),    # 1,5 m : lagon turquoise
        (0.14, rgb('#1d97c4')),    # 7 m
        (0.4, rgb('#0f62a0')),     # 20 m
        (1.0, rgb('#0a3d77')),     # 50 m et plus
    ])
    # Motifs du fond (récifs, herbiers) repris de l'ortho, plus marqués en eau peu profonde
    seabed = m.node('ShaderNodeHueSaturation')
    seabed.inputs['Saturation'].default_value = 1.4
    seabed.inputs['Value'].default_value = 1.2
    # Fond marin débarrassé des bateaux (fetch-data), à défaut le guide
    m.link(image_node(m, SEABED, uv).outputs['Color'] if SEABED else guide, seabed.inputs['Color'])
    shallow = m.smooth(depth, 15.0, 2.0)
    fac = m.math('ADD', 0.15, m.math('MULTIPLY', shallow, 0.3))
    water = m.mix(fac, water, seabed.outputs['Color'], 'OVERLAY')
    # Écume au rivage
    foam = m.math('MULTIPLY', m.smooth(depth, 0.6, 0.05), m.smooth(m.noise(pos, 0.5, 2.0), 0.35, 0.6))
    water = m.mix(m.math('MULTIPLY', foam, 0.8), water, rgb('#f4fbfb'))
    waves = m.noise(pos, 0.18, 3.0, 0.55)
    sea_bsdf = m.bsdf(water, 0.12, 0.5, m.bump(waves, 0.12, 0.6), output=False)
    # Au large, couleur plate (émission, insensible à l'éclairage) = fond de la visionneuse
    # (src/main.ts) : la mer rejoint le fond sans marche visible au bord des blocs rendus.
    open_sea = m.node('ShaderNodeEmission')
    open_sea.inputs['Color'].default_value = rgb(OPEN_SEA)
    open_sea.inputs['Strength'].default_value = 1.0
    deep = m.node('ShaderNodeMixShader')
    m.link(m.smooth(depth, 25.0, 55.0), deep.inputs['Fac'])
    m.link(sea_bsdf.outputs[0], deep.inputs[1])
    m.link(open_sea.outputs[0], deep.inputs[2])

    is_sea = m.smooth(height, 0.05, -0.05)
    mixs = m.node('ShaderNodeMixShader')
    m.link(is_sea, mixs.inputs['Fac'])
    m.link(land_bsdf.outputs[0], mixs.inputs[1])
    m.link(deep.outputs[0], mixs.inputs[2])
    m.link(mixs.outputs[0], m.out.inputs['Surface'])
    return m.mat


def flat_material(name, color, roughness=0.8, specular=0.1):
    m = Nodes(name)
    m.bsdf(rgb(color) if isinstance(color, str) else color, roughness, specular)
    return m.mat


def roof_material():
    """Toits : ortho désaturée (garde l'aspect réel des toits) ou neige l'hiver."""
    m = Nodes('toit')
    if WINTER:
        m.bsdf(rgb('#dde4ec'), 0.6, 0.3)
        return m.mat
    uv = m.node('ShaderNodeUVMap', uv_map='UVMap').outputs['UV']
    ortho = image_node(m, ORTHO, uv).outputs['Color']
    hsv = m.node('ShaderNodeHueSaturation')
    # Sous les tropiques, on garde la couleur des tôles (rouges, vertes, bleues)
    hsv.inputs['Saturation'].default_value = 1.15 if TROPICAL else 0.8
    hsv.inputs['Value'].default_value = 1.2
    m.link(ortho, hsv.inputs['Color'])
    m.bsdf(m.mix(0.15 if TROPICAL else 0.35, hsv.outputs['Color'], rgb('#8a8580')), 0.7, 0.2)
    return m.mat


def tree_material(name, c1, c2):
    m = Nodes(name)
    info = m.node('ShaderNodeObjectInfo')
    color = m.mix(info.outputs['Random'], rgb(c1), rgb(c2))
    if WINTER:
        geo = m.node('ShaderNodeNewGeometry')
        nz = m.node('ShaderNodeSeparateXYZ')
        m.link(geo.outputs['Normal'], nz.inputs[0])
        noise = m.node('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 1.5
        m.link(geo.outputs['Position'], noise.inputs['Vector'])
        up = m.smooth(nz.outputs['Z'], 0.25, 0.6)
        patch = m.smooth(noise.outputs['Fac'], 0.42, 0.58)
        color = m.mix(m.math('MULTIPLY', up, patch), color, rgb('#f2f5f8'))
    m.bsdf(color, 0.85, 0.1)
    return m.mat


# ---------------------------------------------------------------------------
# Terrain

def build_terrain():
    step = ARGS.terrain_step
    js = np.arange(0, DEM_H, step)
    is_ = np.arange(0, DEM_W, step)
    if js[-1] != DEM_H - 1:
        js = np.append(js, DEM_H - 1)
    if is_[-1] != DEM_W - 1:
        is_ = np.append(is_, DEM_W - 1)
    nj, ni = len(js), len(is_)
    X = LX0 + (is_ + 0.5) * DEM_PX
    Y = LY1 - (js + 0.5) * DEM_PX
    XX, YY = np.meshgrid(X, Y)
    ZZ = (DEM[np.ix_(js, is_)] - ALT0) * K
    verts = np.stack([XX.ravel(), YY.ravel(), ZZ.ravel()], axis=1)
    idx = np.arange(nj * ni).reshape(nj, ni)
    # Faces dans le sens antihoraire vu de dessus (normales vers le haut)
    a = idx[1:, :-1]
    b = idx[1:, 1:]
    c = idx[:-1, 1:]
    d = idx[:-1, :-1]
    faces = np.stack([a.ravel(), b.ravel(), c.ravel(), d.ravel()], axis=1)
    u, v = uv_of(verts[:, 0], verts[:, 1])
    mat = ground_material_tropical() if TROPICAL else ground_material()
    obj = mesh_object('terrain', verts, faces, np.stack([u, v], axis=1), mat)
    for p in obj.data.polygons:
        p.use_smooth = True
    log(f'terrain {ni}×{nj} sommets')
    return obj


# ---------------------------------------------------------------------------
# Arbres

def cone_layers(bm, layers, segments=7):
    """Empile des cônes (rayon, z_bas, z_haut) — modèle normalisé (rayon 1, hauteur 1)."""
    for r, z0, z1 in layers:
        bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=r, radius2=0.0,
                              depth=z1 - z0, matrix=_translation(0, 0, (z0 + z1) / 2))


def _translation(x, y, z):
    from mathutils import Matrix
    return Matrix.Translation((x, y, z))


def trunk(bm, r, h):
    bmesh.ops.create_cone(bm, cap_ends=False, segments=5, radius1=r, radius2=r * 0.7, depth=h,
                          matrix=_translation(0, 0, h / 2))


def tree_models():
    """Modèles low-poly normalisés : hauteur 1, rayon de houppier 1."""
    # Collection hors scène : seulement instanciée par les Geometry Nodes
    coll = bpy.data.collections.new('modeles_arbres')
    mat_con = tree_material('conifere', '#2f5a34', '#3d6b3a')
    mat_con2 = tree_material('conifere_clair', '#46703d', '#557d41')
    mat_leaf = tree_material('feuillu', '#5d8a3a', '#7a9c43')
    mat_bush = tree_material('buisson', '#4a7a32', '#64913a')
    mat_trunk = flat_material('tronc', '#5b4532')
    models = []

    def model(name, build, mat):
        bm = bmesh.new()
        build(bm)
        obj = bmesh_object(name, bm)
        obj.data.materials.append(mat)
        obj.data.materials.append(mat_trunk)
        # Le tronc (5 faces) est créé en premier : matériau 1
        for p in obj.data.polygons:
            p.material_index = 1 if p.index < 5 else 0
        SCENE.collection.objects.unlink(obj)
        coll.objects.link(obj)
        models.append(obj)

    if TROPICAL:
        return tropical_models(coll, models, model)

    # Préfixe numérique : l'indice d'instance suit l'ordre des modèles dans la collection
    # Épicéa : trois étages de cônes
    model('0_epicea', lambda bm: (trunk(bm, 0.07, 0.15),
                                cone_layers(bm, [(1.0, 0.1, 0.55), (0.78, 0.35, 0.8), (0.52, 0.6, 1.0)])), mat_con)
    # Mélèze / pin : silhouette plus étroite, un seul cône long
    model('1_meleze', lambda bm: (trunk(bm, 0.06, 0.2),
                                cone_layers(bm, [(0.85, 0.15, 0.7), (0.6, 0.45, 1.0)], 6)), mat_con2)

    # Feuillu : boule légèrement aplatie
    def leafy(bm):
        trunk(bm, 0.08, 0.35)
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0,
                                   matrix=_translation(0, 0, 0.62) @ _scale(1.0, 1.0, 0.42))
    model('2_feuillu', leafy, mat_leaf)

    # Buisson (aulnes verts, landes) : dôme bas et large
    def bush(bm):
        trunk(bm, 0.05, 0.1)
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0,
                                   matrix=_translation(0, 0, 0.45) @ _scale(1.0, 1.0, 0.55))
    model('3_buisson', bush, mat_bush)

    return coll, models


def tropical_models(coll, models, model):
    """Modèles tropicaux normalisés (hauteur 1, rayon de houppier 1)."""
    mat_a = tree_material('tropical', '#2f6a2c', '#4c8a36')
    mat_b = tree_material('tropical_clair', '#4a8a34', '#68a23e')
    mat_palm = tree_material('palmes', '#5f9c3a', '#86b84c')
    mat_mang = tree_material('mangrove', '#2a5a2c', '#3b6b33')

    def ico(bm, x, y, z, r, flat):
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=r,
                                   matrix=_translation(x, y, z) @ _scale(1.0, 1.0, flat))

    # Feuillu en parasol : grande couronne aplatie et deux lobes
    def umbrella(bm):
        trunk(bm, 0.06, 0.5)
        ico(bm, 0, 0, 0.72, 0.85, 0.36)
        ico(bm, 0.38, 0.15, 0.8, 0.55, 0.45)
        ico(bm, -0.3, -0.28, 0.76, 0.5, 0.45)
    model('0_parasol', umbrella, mat_a)

    # Feuillu touffu : grappe de boules
    def cluster(bm):
        trunk(bm, 0.06, 0.4)
        ico(bm, 0, 0, 0.62, 0.7, 0.55)
        ico(bm, 0.42, 0.1, 0.55, 0.5, 0.6)
        ico(bm, -0.25, 0.38, 0.58, 0.5, 0.6)
        ico(bm, -0.2, -0.4, 0.52, 0.48, 0.6)
    model('1_touffu', cluster, mat_b)

    # Cocotier : stipe fin et palmes en étoile, retombantes
    def palm(bm):
        bmesh.ops.create_cone(bm, cap_ends=False, segments=5, radius1=0.05, radius2=0.035, depth=0.9,
                              matrix=_translation(0, 0, 0.45))
        n = 9
        for i in range(n):
            a = 2 * math.pi * i / n + (0.2 if i % 2 else 0.0)
            c, s_ = math.cos(a), math.sin(a)
            reach = 1.0 if i % 2 == 0 else 0.85
            base = bm.verts.new((0, 0, 0.9))
            ridge = bm.verts.new((0.5 * reach * c, 0.5 * reach * s_, 1.0))
            left = bm.verts.new((0.5 * reach * c - 0.22 * s_, 0.5 * reach * s_ + 0.22 * c, 0.94))
            right = bm.verts.new((0.5 * reach * c + 0.22 * s_, 0.5 * reach * s_ - 0.22 * c, 0.94))
            tip = bm.verts.new((reach * c, reach * s_, 0.62))
            for f in ((base, right, ridge), (base, ridge, left), (ridge, right, tip), (ridge, tip, left)):
                bm.faces.new(f)
    model('2_cocotier', palm, mat_palm)

    # Palétuvier : dôme bas, large et dense
    def mangrove(bm):
        trunk(bm, 0.05, 0.15)
        ico(bm, 0, 0, 0.5, 1.0, 0.5)
    model('3_paletuvier', mangrove, mat_mang)

    # Bananier : faux-tronc court et grandes feuilles larges, arquées puis retombantes
    mat_banana = tree_material('bananier', '#6fae3c', '#93c851')

    def banana(bm):
        bmesh.ops.create_cone(bm, cap_ends=False, segments=5, radius1=0.09, radius2=0.07, depth=0.6,
                              matrix=_translation(0, 0, 0.3))
        n = 7
        for i in range(n):
            a = 2 * math.pi * i / n + 0.3 * math.sin(3.1 * i)
            c, s_ = math.cos(a), math.sin(a)
            reach = 0.85 + 0.15 * ((i * 5) % 3) / 2
            w = 0.24  # demi-largeur du limbe
            base = bm.verts.new((0.05 * c, 0.05 * s_, 0.6))
            mid = bm.verts.new((0.5 * reach * c, 0.5 * reach * s_, 1.0))
            ml = bm.verts.new((0.5 * reach * c - w * s_, 0.5 * reach * s_ + w * c, 0.93))
            mr = bm.verts.new((0.5 * reach * c + w * s_, 0.5 * reach * s_ - w * c, 0.93))
            tip = bm.verts.new((reach * c, reach * s_, 0.72))
            for f in ((base, mr, mid), (base, mid, ml), (mid, mr, tip), (mid, tip, ml)):
                bm.faces.new(f)
    model('4_bananier', banana, mat_banana)

    # Arbre fruitier (vergers, café-cacao) : petite boule ronde et dense
    mat_orchard = tree_material('verger', '#3f7a2f', '#5a9338')

    def orchard(bm):
        trunk(bm, 0.07, 0.3)
        ico(bm, 0, 0, 0.6, 0.95, 0.62)
    model('5_verger', orchard, mat_orchard)

    return coll, models


def _scale(x, y, z):
    from mathutils import Matrix
    return Matrix.Diagonal((x, y, z, 1.0))


TROPICAL_KINDS = {'broadleaf': 0, 'palm': 2, 'mangrove': 3, 'banana': 4, 'orchard': 5}


def tree_kinds(xs, ys, hs):
    """Indice de modèle de chaque arbre.

    Plantation procédurale : type fourni par fetch-data (champ k). Sinon (LiDAR,
    alpin) : selon la zone de végétation BD TOPO et la hauteur.
    """
    if TROPICAL:
        kinds = np.array([TROPICAL_KINDS.get(t.get('k'), 0) for t in TREES], dtype=np.int32)
        # Deux silhouettes de feuillus, tirées au hasard
        swap = (kinds == 0) & (RNG.random(kinds.shape) < 0.45)
        return np.where(swap, 1, kinds).astype(np.int32)
    leafy_share = np.full(xs.shape, 0.05)
    for f in VECTORS.get('zone_de_vegetation', []):
        nature = (f['properties'].get('nature') or '').lower()
        share = 0.9 if 'feuillus' in nature else 0.5 if 'mixte' in nature else 0.25 if 'ouverte' in nature or 'lande' in nature or 'haie' in nature else 0.0
        if share == 0.0:
            continue
        for poly in polys_of(f['geometry']):
            mask = points_in_ring(xs, ys, poly[0])
            leafy_share[mask] = np.maximum(leafy_share[mask], share)
    r = RNG.random(xs.shape)
    kinds = np.where(r < leafy_share, 2, np.where(RNG.random(xs.shape) < 0.3, 1, 0))
    # Végétation basse : surtout des buissons
    low = RNG.random(xs.shape) < np.clip((7 - hs) / 2.5, 0, 1)
    kinds = np.where(low, 3, kinds)
    return kinds.astype(np.int32)


def build_trees():
    coll, _ = tree_models()
    xs = np.array([t['x'] for t in TREES])
    ys = np.array([t['y'] for t in TREES])
    hs = np.array([t['h'] for t in TREES])
    rs = np.array([t['r'] for t in TREES])
    kinds = tree_kinds(xs, ys, hs)
    if not TROPICAL:
        # Les feuillus ont un houppier plus large que les conifères
        rs = np.where(kinds == 2, np.clip(rs * 1.5, 1.2, 6), rs)
        rs = np.where(kinds == 3, np.clip(0.5 * hs + 0.6, 1.5, 4), rs)
    zs = ground_z(xs, ys) - 0.2 * K
    n = len(xs)

    me = bpy.data.meshes.new('arbres')
    me.vertices.add(n)
    me.vertices.foreach_set('co', np.stack([xs, ys, zs], axis=1).astype(np.float32).ravel())
    scale = np.stack([rs * K, rs * K, hs * K], axis=1).astype(np.float32)
    me.attributes.new('echelle', 'FLOAT_VECTOR', 'POINT').data.foreach_set('vector', scale.ravel())
    rot = np.zeros((n, 3), dtype=np.float32)
    rot[:, 2] = RNG.random(n) * 2 * math.pi
    me.attributes.new('rotation', 'FLOAT_VECTOR', 'POINT').data.foreach_set('vector', rot.ravel())
    me.attributes.new('modele', 'INT', 'POINT').data.foreach_set('value', kinds)
    obj = link(bpy.data.objects.new('arbres', me))

    ng = bpy.data.node_groups.new('instancier_arbres', 'GeometryNodeTree')
    ng.is_modifier = True
    ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    N = ng.nodes
    L = ng.links
    gin = N.new('NodeGroupInput')
    gout = N.new('NodeGroupOutput')
    ci = N.new('GeometryNodeCollectionInfo')
    ci.inputs['Collection'].default_value = coll
    ci.inputs['Separate Children'].default_value = True
    ci.inputs['Reset Children'].default_value = True
    ci.transform_space = 'ORIGINAL'
    iop = N.new('GeometryNodeInstanceOnPoints')
    iop.inputs['Pick Instance'].default_value = True

    def attr(name, dtype):
        a = N.new('GeometryNodeInputNamedAttribute')
        a.data_type = dtype
        a.inputs['Name'].default_value = name
        return a.outputs['Attribute']

    L.new(gin.outputs[0], iop.inputs['Points'])
    L.new(ci.outputs['Instances'], iop.inputs['Instance'])
    L.new(attr('modele', 'INT'), iop.inputs['Instance Index'])
    L.new(attr('echelle', 'FLOAT_VECTOR'), iop.inputs['Scale'])
    e2r = N.new('FunctionNodeEulerToRotation')
    L.new(attr('rotation', 'FLOAT_VECTOR'), e2r.inputs[0])
    L.new(e2r.outputs[0], iop.inputs['Rotation'])
    L.new(iop.outputs['Instances'], gout.inputs[0])
    mod = obj.modifiers.new('arbres', 'NODES')
    mod.node_group = ng
    names = 'parasols/touffus/cocotiers/palétuviers/bananiers/fruitiers' if TROPICAL else 'épicéas/mélèzes/feuillus/buissons'
    log(f'{n} arbres ({np.bincount(kinds, minlength=6 if TROPICAL else 4).tolist()} {names})')


# ---------------------------------------------------------------------------
# Bâtiments

def build_buildings():
    mat_wall = flat_material('facade', '#ece3d3' if TROPICAL else '#a88262' if WINTER else '#b98a5e')
    mat_roof = roof_material()
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new('UVMap')
    count = 0
    for f in VECTORS.get('batiment', []):
        props = f['properties']
        for poly in polys_of(f['geometry']):
            ring = [tuple(c[:2]) for c in poly[0]]
            if len(ring) > 1 and ring[0] == ring[-1]:
                ring = ring[:-1]
            if len(ring) < 3:
                continue
            xs = np.array([c[0] for c in ring])
            ys = np.array([c[1] for c in ring])
            gz = ground_z(xs, ys)
            base = gz.min() - 1.0 * K
            h = props.get('hauteur') or 0
            top_alt = props.get('altitude_maximale_toit')
            if top_alt and top_alt > ALT0:
                top = (top_alt - ALT0) * K
            else:
                top = gz.max() + max(h, 3.0) * K
            top = max(top, gz.max() + 3.0 * K)
            # Sens antihoraire (normale du toit vers le haut)
            area = 0.5 * np.sum(xs * np.roll(ys, -1) - np.roll(xs, -1) * ys)
            if area < 0:
                ring = ring[::-1]
            try:
                floor = bm.faces.new([bm.verts.new((x, y, base)) for x, y in ring])
            except ValueError:
                continue
            # L'extrusion supprime la face de départ et crée le toit sur les nouveaux sommets
            ext = bmesh.ops.extrude_face_region(bm, geom=[floor])
            for v in ext['geom']:
                if isinstance(v, bmesh.types.BMVert):
                    v.co.z = top
            count += 1
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # Faces de murs → matériau 0 ; toits (normale vers le haut) → 1
    for face in bm.faces:
        face.material_index = 1 if face.normal.z > 0.5 else 0
        if face.material_index == 1:
            for loop in face.loops:
                loop[uv_layer].uv = uv_of(loop.vert.co.x, loop.vert.co.y)
    obj = bmesh_object('batiments', bm)
    obj.data.materials.append(mat_wall)
    obj.data.materials.append(mat_roof)
    log(f'{count} bâtiments')


# ---------------------------------------------------------------------------
# Rubans drapés (routes, cours d'eau)

ROAD_WIDTH = {  # largeur réelle en mètres selon la nature BD TOPO
    'Route à 2 chaussées': 9.0,
    'Route à 1 chaussée': 5.0,
    'Route empierrée': 3.5,
    'Chemin': 2.5,
    'Bretelle': 4.0,
    'Rond-point': 6.0,
    'Escalier': 1.5,
    'Sentier': 1.2,
}


def densify(line, step):
    pts = np.asarray(line, dtype=np.float64)[:, :2]
    out = [pts[0]]
    for a, b in zip(pts[:-1], pts[1:]):
        d = np.linalg.norm(b - a)
        n = max(1, int(math.ceil(d / step)))
        for t in np.arange(1, n + 1) / n:
            out.append(a + (b - a) * t)
    return np.array(out)


def ribbon(bm, line, width, lift, uv_layer=None):
    pts = densify(line, 1.5)
    if len(pts) < 2:
        return
    # Normales aux sommets (moyenne des segments adjacents)
    seg = np.diff(pts, axis=0)
    seg /= np.maximum(np.linalg.norm(seg, axis=1, keepdims=True), 1e-9)
    tan = np.vstack([seg[:1], seg[:-1] + seg[1:], seg[-1:]])
    tan /= np.maximum(np.linalg.norm(tan, axis=1, keepdims=True), 1e-9)
    nrm = np.stack([-tan[:, 1], tan[:, 0]], axis=1)
    left = pts + nrm * width / 2
    right = pts - nrm * width / 2
    zl = ground_z(left[:, 0], left[:, 1]) + lift
    zr = ground_z(right[:, 0], right[:, 1]) + lift
    zc = ground_z(pts[:, 0], pts[:, 1]) + lift
    # Le ruban ne doit pas s'enfoncer : on prend le max du centre et des bords
    zl = np.maximum(zl, zc)
    zr = np.maximum(zr, zc)
    vl = [bm.verts.new((x, y, z)) for (x, y), z in zip(left, zl)]
    vr = [bm.verts.new((x, y, z)) for (x, y), z in zip(right, zr)]
    for i in range(len(pts) - 1):
        bm.faces.new((vr[i], vr[i + 1], vl[i + 1], vl[i]))


def build_roads():
    groups = {}
    for f in VECTORS.get('troncon_de_route', []):
        p = f['properties']
        if str(p.get('position_par_rapport_au_sol') or '0').startswith('-'):
            continue  # tunnels, passages souterrains
        nature = p.get('nature') or 'Chemin'
        if nature.startswith('Bac'):
            continue  # bacs et liaisons maritimes : tracés sur la mer
        width = (p.get('largeur_de_chaussee') or ROAD_WIDTH.get(nature, 2.5)) * K
        cls = 'route' if nature in ('Route à 1 chaussée', 'Route à 2 chaussées', 'Bretelle', 'Rond-point') else \
              'empierre' if nature in ('Route empierrée', 'Chemin') else 'sentier'
        groups.setdefault(cls, []).append((f, width))
    colors = {
        'route': ('#8f8c88', '#c7cdd3'),      # été, hiver (déneigée mais grise et sale)
        'empierre': ('#cdbb98', '#e9eef3'),
        'sentier': ('#d8c9a6', '#eef2f6'),
    }
    lifts = {'route': 0.35, 'empierre': 0.3, 'sentier': 0.25}
    for cls, items in groups.items():
        bm = bmesh.new()
        for f, width in items:
            for line in lines_of(f['geometry']):
                ribbon(bm, line, width, lifts[cls] * K)
        c = colors[cls][1 if WINTER else 0]
        bmesh_object(f'routes_{cls}', bm, flat_material(f'route_{cls}', c, 0.9, 0.1))
        log(f'{len(items)} tronçons « {cls} »')


def build_water():
    mat = flat_material('eau', '#4f97b8' if not WINTER else '#cfdde6', 0.15 if not WINTER else 0.5, 0.5)
    bm = bmesh.new()
    n = 0
    for f in VECTORS.get('troncon_hydrographique', []):
        p = f['properties']
        if (p.get('nature') or '') == 'Conduit buse' or str(p.get('position_par_rapport_au_sol') or '0').startswith('-'):
            continue
        for line in lines_of(f['geometry']):
            ribbon(bm, line, 1.5 * K, 0.2 * K)
            n += 1
    for f in VECTORS.get('surface_hydrographique', []):
        for poly in polys_of(f['geometry']):
            ring = [tuple(c[:2]) for c in poly[0]][:-1]
            if len(ring) < 3:
                continue
            xs = np.array([c[0] for c in ring])
            ys = np.array([c[1] for c in ring])
            # Plan d'eau horizontal au niveau du point le plus bas de la rive ; pour un plan
            # d'eau plat (bassin, étang), au niveau du relief intérieur : avec un MNT lissé ou
            # grossier, la rive basse est sous le niveau réel et l'eau disparaîtrait sous le sol.
            z = ground_z(xs, ys).min() + 0.3 * K
            gx, gy = np.meshgrid(np.arange(xs.min(), xs.max(), 2.0), np.arange(ys.min(), ys.max(), 2.0))
            gx, gy = gx.ravel(), gy.ravel()
            inner = points_in_ring(gx, gy, ring) if len(gx) else np.zeros(0, bool)
            if inner.sum() >= 4:
                zi = ground_z(gx[inner], gy[inner])
                if np.percentile(zi, 90) - np.percentile(zi, 10) < 3 * K:
                    z = max(z, float(np.percentile(zi, 90)) + 0.3 * K)
            try:
                bm.faces.new([bm.verts.new((x, y, z)) for x, y in ring])
                n += 1
            except ValueError:
                pass
    if n:
        bmesh_object('eau', bm, mat)
    else:
        bm.free()
    log(f'{n} éléments d\'eau')


# ---------------------------------------------------------------------------
# Lumière, monde, rendu

def setup_lighting():
    sun = bpy.data.lights.new('soleil', 'SUN')
    sun.energy = ARGS.sun
    sun.angle = math.radians(1.5)
    sun.color = (1.0, 0.97, 0.92)
    obj = link(bpy.data.objects.new('soleil', sun))
    # La lumière part dans la direction opposée à l'azimut d'où vient le soleil
    elevation = ARGS.sun_elevation if ARGS.sun_elevation is not None else (45.0 if TROPICAL else 35.0)
    obj.rotation_euler = (math.radians(90 - elevation), 0.0,
                          -math.radians(ARGS.sun_azimuth + 180))

    world = bpy.data.worlds.new('ciel')
    SCENE.world = world
    if not world.node_tree:
        world.use_nodes = True
    bg = world.node_tree.nodes.get('Background') or world.node_tree.nodes.new('ShaderNodeBackground')
    bg.inputs['Color'].default_value = rgb('#bcd6f0')
    bg.inputs['Strength'].default_value = ARGS.sky if ARGS.sky is not None else (0.65 if TROPICAL else 0.55)


def setup_render():
    r = SCENE.render
    r.engine = 'BLENDER_EEVEE'
    ev = SCENE.eevee
    ev.taa_render_samples = ARGS.samples
    ev.use_shadows = True
    ev.shadow_resolution_scale = 1.0
    ev.use_raytracing = True
    ev.use_fast_gi = True
    ev.fast_gi_distance = 30.0
    r.film_transparent = False
    r.filter_size = ARGS.filter_size  # 1,5 px par défaut dans Blender : trop doux pour des tuiles
    r.image_settings.file_format = 'PNG'
    r.image_settings.color_mode = 'RGB'
    r.image_settings.color_depth = '8'
    try:
        SCENE.view_settings.view_transform = ARGS.view
    except TypeError:
        log(f'transformée de vue « {ARGS.view} » inconnue, on garde {SCENE.view_settings.view_transform}')
    # La neige sature vite : exposition un peu plus basse en hiver
    SCENE.view_settings.exposure = ARGS.exposure if ARGS.exposure is not None else (-0.3 if WINTER else 0.0)
    try:
        SCENE.view_settings.look = 'None'
    except TypeError:
        pass


RENDER_SCALE = ARGS.scale or META.get('renderScale', 1)


def chunk_geometry(cx, cy):
    """Centre, largeur (m Mercator) et taille en px du bloc cx, cy (cy compté depuis le nord).

    La largeur ne dépend pas de la densité : en @2x on rend deux fois plus de pixels
    sur la même emprise.
    """
    n = META['chunkTiles'] * META['tileSize']
    margin = META['chunkMarginPx']
    res = META['res']
    span = n * res
    x_left = cx * span
    y_top = META['heightM'] - cy * span
    size_px = n + 2 * margin
    return (x_left + span / 2, y_top - span / 2), size_px * res, size_px * RENDER_SCALE


def setup_camera():
    cam = bpy.data.cameras.new('camera')
    cam.type = 'ORTHO'
    zmax = float(DEM.max() - ALT0) * K + 200
    cam.clip_start = 1.0
    cam.clip_end = zmax + 100
    obj = link(bpy.data.objects.new('camera', cam))
    obj.location = (0, 0, zmax)
    obj.rotation_euler = (0, 0, 0)  # regarde vers −Z, nord en haut
    SCENE.camera = obj
    return obj


def render_chunks(cam):
    nx, ny = META['chunks']['nx'], META['chunks']['ny']
    if ARGS.chunks:
        todo = [tuple(int(v) for v in c.split(',')) for c in ARGS.chunks]
    else:
        todo = [(cx, cy) for cy in range(ny) for cx in range(nx)]
    out_dir = os.path.join(ARGS.out, 'renders', ARGS.season)
    os.makedirs(out_dir, exist_ok=True)
    for cx, cy in todo:
        (x, y), scale, px = chunk_geometry(cx, cy)
        cam.location.x = x
        cam.location.y = y
        cam.data.ortho_scale = scale
        SCENE.render.resolution_x = px
        SCENE.render.resolution_y = px
        SCENE.render.resolution_percentage = 100
        SCENE.render.filepath = os.path.join(out_dir, f'chunk_{cx}_{cy}.png')
        t = time.time()
        bpy.ops.render.render(write_still=True)
        log(f'bloc {cx},{cy} ({px} px, ×{RENDER_SCALE}) rendu en {time.time() - t:.1f} s → {SCENE.render.filepath}')


def main():
    t = time.time()
    build_terrain()
    build_trees()
    build_buildings()
    build_roads()
    build_water()
    setup_lighting()
    setup_render()
    cam = setup_camera()
    log(f'scène construite en {time.time() - t:.1f} s')
    if ARGS.save_blend:
        os.makedirs(ARGS.out, exist_ok=True)
        path = os.path.join(ARGS.out, f'scene_{ARGS.season}.blend')
        bpy.ops.wm.save_as_mainfile(filepath=path)
        log(f'scène enregistrée : {path}')
    if not ARGS.no_render:
        render_chunks(cam)


main()
