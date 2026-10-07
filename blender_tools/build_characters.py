"""Собирает бойцов из примитивов по blender_tools/characters.json и экспортирует assets/models/<id>.glb.

Запуск (Blender нет в PATH):
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe" --background --factory-startup --python blender_tools/build_characters.py
Только один боец:  ... --python blender_tools/build_characters.py -- drip

Модель: чиби-пропорции, вперёд смотрит -Y (в glTF это +Z), один меш с цветами вершин,
жёсткая привязка частей к костям, анимации idle/run/attack/super/death.
"""
import bpy
import bmesh
import json
import math
import os
import sys
from mathutils import Matrix, Vector, Euler

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'assets', 'models')
FPS = 30

BONES = ['root', 'hips', 'chest', 'head', 'arm_L', 'arm_R', 'leg_L', 'leg_R']
BI = {n: i for i, n in enumerate(BONES)}


def srgb(h):
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(ch * 2 for ch in h)
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return (*lin, 1.0)


class Builder:
    def __init__(self):
        self.bm = bmesh.new()
        self.dl = self.bm.verts.layers.deform.verify()
        self.cl = self.bm.loops.layers.float_color.new('Color')

    def _finish(self, verts, color, bone, smooth):
        col = srgb(color)
        faces = set()
        for v in verts:
            v[self.dl][BI[bone]] = 1.0
            faces.update(v.link_faces)
        for f in faces:
            f.smooth = smooth
            for l in f.loops:
                l[self.cl] = col
        return verts

    def mat(self, loc, rot=(0, 0, 0), scale=(1, 1, 1)):
        m = Matrix.Translation(Vector(loc)) @ Euler(rot).to_matrix().to_4x4()
        s = Matrix.Diagonal((*scale, 1))
        return m @ s

    def box(self, size, loc, color, bone, rot=(0, 0, 0)):
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=self.mat(loc, rot, size))
        return self._finish(r['verts'], color, bone, False)

    def sphere(self, r, loc, color, bone, scale=(1, 1, 1), seg=10, rings=7, rot=(0, 0, 0), keep=None):
        res = bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=rings, radius=r, matrix=self.mat(loc, rot, scale))
        verts = res['verts']
        if keep:
            c = Vector(loc)
            drop = [v for v in verts if not keep((v.co - c).x / (r * scale[0]), (v.co - c).y / (r * scale[1]), (v.co - c).z / (r * scale[2]))]
            bmesh.ops.delete(self.bm, geom=drop, context='VERTS')
            verts = [v for v in verts if v.is_valid]
        return self._finish(verts, color, bone, True)

    def ico(self, r, loc, color, bone, sub=1):
        res = bmesh.ops.create_icosphere(self.bm, subdivisions=sub, radius=r, matrix=self.mat(loc))
        return self._finish(res['verts'], color, bone, True)

    def cyl(self, r1, r2, z0, z1, xy, color, bone, seg=10, scale_y=1.0, cap=True):
        h = z1 - z0
        res = bmesh.ops.create_cone(self.bm, cap_ends=cap, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=h,
                                    matrix=self.mat((xy[0], xy[1], (z0 + z1) / 2), (0, 0, 0), (1, scale_y, 1)))
        return self._finish(res['verts'], color, bone, True)

    def rod(self, r, a, b, color, bone, seg=8):
        """Цилиндр между точками a и b."""
        a, b = Vector(a), Vector(b)
        d = b - a
        q = Vector((0, 0, 1)).rotation_difference(d.normalized())
        m = Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4()
        res = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r, depth=d.length, matrix=m)
        return self._finish(res['verts'], color, bone, True)

    def torus(self, R, r, loc, color, bone, rot=(0, 0, 0), seg=14, tseg=5):
        m = self.mat(loc, rot)
        rings = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            ring = []
            for j in range(tseg):
                b = 2 * math.pi * j / tseg
                p = Vector(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b)))
                ring.append(self.bm.verts.new(m @ p))
            rings.append(ring)
        for i in range(seg):
            for j in range(tseg):
                a, b = rings[i][j], rings[(i + 1) % seg][j]
                c, d = rings[(i + 1) % seg][(j + 1) % tseg], rings[i][(j + 1) % tseg]
                self.bm.faces.new((a, b, c, d))
        return self._finish([v for ring in rings for v in ring], color, bone, True)


    def checker_ring(self, r1, r2, z0, z1, seg, c1, c2, bone, offset=0, scale_y=1.0, xy=(0, 0)):
        """Кольцо цилиндра, грани покрашены через одну — для клетки."""
        res = bmesh.ops.create_cone(self.bm, cap_ends=False, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=z1 - z0,
                                    matrix=self.mat((xy[0], xy[1], (z0 + z1) / 2), (0, 0, 0), (1, scale_y, 1)))
        verts = res['verts']
        for v in verts:
            v[self.dl][BI[bone]] = 1.0
        faces = set()
        for v in verts:
            faces.update(v.link_faces)
        cols = (srgb(c1), srgb(c2))
        for f in faces:
            cc = f.calc_center_median()
            k = int(((math.atan2(cc.y - xy[1], cc.x - xy[0]) + math.pi) / (2 * math.pi)) * seg + 0.5) + offset
            f.smooth = True
            for l in f.loops:
                l[self.cl] = cols[k % 2]
        return verts

    def tri(self, size, loc, spin, color, bone, thick=0.008):
        """Плоский треугольник лицом вперёд (-Y); spin поворачивает его в плоскости."""
        res = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=True, segments=3, radius1=size, radius2=size, depth=thick,
                                    matrix=self.mat(loc, (math.pi / 2, spin, 0)))
        return self._finish(res['verts'], color, bone, False)


def mix_hex(a, b, k):
    a, b = a.lstrip('#'), b.lstrip('#')
    ca = [int(a[i:i + 2], 16) for i in (0, 2, 4)]
    cb = [int(b[i:i + 2], 16) for i in (0, 2, 4)]
    return '#' + ''.join(f'{round(x + (y - x) * k):02x}' for x, y in zip(ca, cb))


def build_body(B, c):
    H = c.get('height', 1.0)
    build = c.get('build', 'normal')
    tr = {'slim': 0.155, 'normal': 0.175, 'big': 0.22, 'huge': 0.27}[build]
    ar = {'slim': 0.05, 'normal': 0.056, 'big': 0.07, 'huge': 0.1}[build]
    lr = {'slim': 0.062, 'normal': 0.068, 'big': 0.082, 'huge': 0.09}[build]
    skin = c['skin']
    top, bottom, shoes, hair = c['top'], c['bottom'], c['shoes'], c['hair']
    z = lambda v: v * H
    sx = tr + ar * 0.9  # плечи
    lx = tr * 0.48      # ноги

    # --- обувь
    for side, bone in ((1, 'leg_L'), (-1, 'leg_R')):
        x = lx * side
        st = shoes['type']
        big = shoes.get('big') or st == 'chunky'
        sole_h = 0.06 if big else 0.035
        w, l = (0.15, 0.27) if big else (0.13, 0.24)
        B.box((w + 0.01, l + 0.01, sole_h), (x, -0.035, sole_h / 2), shoes['sole'], bone)
        uh = 0.17 if st == 'boots' else 0.075
        B.box((w, l * 0.92, uh), (x, -0.03 + (0.02 if st == 'boots' else 0), sole_h + uh / 2), shoes['color'], bone)
        B.sphere(w / 2, (x, -0.03 - l * 0.42, sole_h + 0.025), shoes['color'], bone, scale=(1, 0.8, 0.6), seg=8, rings=5)
        # боковая вставка — узнаваемая форма без логотипов
        if st in ('runner', 'chunky', 'retro'):
            B.box((0.012, l * 0.55, 0.035), (x + side * w / 2, -0.04, sole_h + 0.04), shoes['accent'], bone, rot=(0.35, 0, 0))
        if st == 'retro':
            B.box((w + 0.006, l * 0.3, 0.05), (x, 0.06, sole_h + 0.035), shoes['accent'], bone)
        if st == 'boots':
            B.box((w + 0.008, 0.02, 0.02), (x, -0.07, sole_h + uh - 0.02), shoes['accent'], bone)

    # --- ноги
    leg_top = z(0.46)
    foot = 0.1
    for side, bone in ((1, 'leg_L'), (-1, 'leg_R')):
        x = lx * side
        bt = bottom['type']
        if bt == 'shorts':
            B.cyl(lr * 0.75, lr * 0.75, foot, z(0.3), (x, 0), skin, bone, seg=8)
            B.cyl(lr * 1.35, lr * 1.2, z(0.27), leg_top, (x, 0), bottom['color'], bone)
        elif bt == 'joggers':
            # широкие спортивки с резинкой у щиколотки
            B.cyl(lr * 1.15, lr * 1.5, foot + 0.07, leg_top, (x, 0), bottom['color'], bone)
            B.cyl(lr * 0.95, lr * 1.0, foot + (0.1 if shoes['type'] == 'boots' else 0.02), foot + 0.08, (x, 0), bottom.get('cuff', bottom['color']), bone)
            if bottom.get('pattern') == 'dogs':
                # принт с собаками: маленькие пятна-мордочки
                for i, (zz, ang) in enumerate(((0.16, 0.3), (0.24, 2.0), (0.31, -1.2), (0.38, 1.0), (0.2, -2.4), (0.34, 3.0))):
                    rr = lr * (1.2 + (zz - 0.1) * 0.9)
                    px, py = x + math.cos(ang) * rr, math.sin(ang) * rr
                    B.box((0.04, 0.014, 0.04), (px, py, z(zz)), '#a5683a', bone, rot=(0, 0, ang))
                    B.box((0.02, 0.016, 0.018), (px, py, z(zz) - 0.012), '#f2efe6', bone, rot=(0, 0, ang))
        elif bt == 'flare':
            B.cyl(lr * 1.75, lr * 1.0, foot - 0.02, z(0.3), (x, 0), bottom['color'], bone)
            B.cyl(lr * 1.0, lr * 1.1, z(0.3), leg_top, (x, 0), bottom['color'], bone)
        else:
            B.cyl(lr, lr * 1.1, foot + (0.08 if shoes['type'] == 'boots' else 0), leg_top, (x, 0), bottom['color'], bone)
            if bt == 'rolled':
                B.cyl(lr * 1.3, lr * 1.25, foot + 0.07, foot + 0.12, (x, 0), bottom.get('cuff', '#7f9fd0'), bone)
            if bt == 'track' and not bottom.get('tape'):
                B.box((0.012, 0.02, leg_top - foot), (x + side * lr * 1.02, 0, (leg_top + foot) / 2), bottom.get('stripe', '#fff'), bone)
            if bt == 'track' and bottom.get('tape'):
                # лампас из повторяющихся вставок
                n = 9
                for i in range(n):
                    a = foot + (leg_top - foot) * i / n
                    b = foot + (leg_top - foot) * (i + 1) / n
                    B.box((0.014, 0.03, b - a), (x + side * lr * 1.04, 0, (a + b) / 2), bottom['tape'][i % len(bottom['tape'])], bone)
        if bottom.get('crosses'):
            # серебряные кресты на штанинах
            def leg_r(zz):
                if bt == 'flare' and zz < z(0.3):
                    k = (zz - foot) / (z(0.3) - foot)
                    return lr * (1.75 + (1.0 - 1.75) * k)
                return lr * 1.05
            for zz in (z(0.38), z(0.2)):
                fy2 = -leg_r(zz) - 0.006
                B.box((0.012, 0.01, 0.07), (x, fy2, zz), '#e3e6ea', bone)
                B.box((0.046, 0.01, 0.012), (x, fy2, zz + 0.014), '#e3e6ea', bone)

    # --- таз и торс
    B.cyl(tr * 0.92, tr * 0.95, z(0.42), z(0.52), (0, 0), bottom['color'], 'hips', seg=12, scale_y=0.8)
    t0, t1 = z(0.5), z(0.84)
    tt = top['type']
    if tt == 'sweater':
        n = top.get('stripes', 7)
        for i in range(n):
            a = t0 + (t1 - t0) * i / n
            b = t0 + (t1 - t0) * (i + 1) / n
            k = i / n
            B.cyl(tr * (1.0 - 0.05 * k), tr * (1.0 - 0.05 * (k + 1 / n)), a, b, (0, 0), top['color'] if i % 2 == 0 else top['stripe'], 'chest', seg=12, scale_y=0.78, cap=(i in (0, n - 1)))
    elif tt == 'checker':
        n = 5
        for i in range(n):
            a = t0 + (t1 - t0) * i / n
            b = t0 + (t1 - t0) * (i + 1) / n
            B.checker_ring(tr, tr * 0.99, a, b, 12, top['color'], top['stripe'], 'chest', offset=i, scale_y=0.78)
        B.cyl(tr * 0.97, tr * 0.97, t0, t0 + 0.005, (0, 0), top['color'], 'chest', seg=12, scale_y=0.78)
    elif tt == 'puffer':
        # пуховик: дутые секции
        n = 4
        for i in range(n):
            zc = t0 - 0.02 + (t1 - t0 + 0.02) * (i + 0.5) / n
            hh = (t1 - t0 + 0.02) / n
            B.sphere(tr * 1.38, (0, 0, zc), top['color'] if i % 2 == 0 else top.get('stripe', top['color']), 'chest',
                     scale=(1, 0.8, hh / (tr * 1.38) * 0.75), seg=14, rings=6)
    else:
        B.cyl(tr, tr * 0.95, t0, t1, (0, 0), top['color'], 'chest', seg=12, scale_y=0.78)
    B.sphere(tr * 0.97 * (1.3 if tt == 'puffer' else 1), (0, 0, t1), top['color'] if tt != 'sweater' else top['stripe'], 'chest', scale=(1, 0.78, 0.38), seg=12, rings=6)
    trim = top.get('trim')
    if tt == 'puffer':
        B.cyl(0.115, 0.11, t1 - 0.02, t1 + 0.09, (0, 0), top['color'], 'chest', seg=12)
        B.box((0.014, 0.01, t1 - t0 + 0.08), (0, -tr * 1.1, (t0 + t1) / 2 + 0.02), top.get('trim', '#222'), 'chest')
    if top.get('boxlogo'):
        fy = -tr * 0.78 - 0.008
        B.box((0.13, 0.01, 0.05), (0, fy, z(0.7)), '#d0141e', 'chest')
        B.box((0.09, 0.013, 0.012), (0, fy - 0.002, z(0.7)), '#ffffff', 'chest')
    if tt in ('bomber', 'varsity', 'zip', 'tracksuit'):
        B.cyl(tr * 1.03, tr * 1.03, t0 - 0.005, t0 + 0.04, (0, 0), trim or top['color'], 'chest', seg=12, scale_y=0.8)
        B.cyl(0.085, 0.08, t1 + 0.0, t1 + 0.06, (0, 0), trim or top['color'], 'chest', seg=10)
    if tt in ('zip', 'tracksuit'):
        B.box((0.014, 0.01, t1 - t0), (0, -tr * 0.78, (t0 + t1) / 2), top.get('stripe', trim or '#ccc'), 'chest')
    if tt == 'zip':
        B.torus(0.1, 0.035, (0, 0.06, t1 + 0.02), top['color'], 'chest', rot=(1.2, 0, 0), seg=10, tseg=4)
    if tt == 'varsity':
        B.box((0.06, 0.01, 0.06), (0.08, -tr * 0.78, t1 - 0.1), trim or '#fff', 'chest')
    if tt == 'hoodie' and hair['style'] != 'hood':
        B.torus(0.11, 0.04, (0, 0.06, t1 + 0.02), top['color'], 'chest', rot=(1.2, 0, 0), seg=10, tseg=4)
    if tt == 'anorak':
        # анорак: капюшон сзади, большой карман-кенгуру, белая плашка и нашивка-флаг (без надписей)
        B.torus(0.125, 0.045, (0, 0.07, t1 + 0.02), top['color'], 'chest', rot=(1.2, 0, 0), seg=10, tseg=4)
        B.box((0.25, 0.025, 0.12), (0, -tr * 0.8, z(0.6)), mix_hex(top['color'], '#000000', 0.35), 'chest')
        B.box((0.012, 0.01, 0.12), (0, -tr * 0.79, t1 - 0.07), '#bfbfbf', 'chest')
        B.box((0.14, 0.012, 0.042), (0, -tr * 0.8 - 0.01, z(0.695)), '#f2f2f2', 'chest')
        B.box((0.115, 0.014, 0.016), (0, -tr * 0.8 - 0.014, z(0.695)), '#1a1a1a', 'chest')
        fz = z(0.635)
        B.box((0.06, 0.012, 0.04), (0, -tr * 0.8 - 0.012, fz), '#c8102e', 'chest')
        B.box((0.06, 0.014, 0.01), (0, -tr * 0.8 - 0.015, fz), '#ffffff', 'chest')
        B.box((0.01, 0.014, 0.04), (-0.008, -tr * 0.8 - 0.015, fz), '#ffffff', 'chest')
        B.box((0.06, 0.016, 0.005), (0, -tr * 0.8 - 0.017, fz), '#0b2a6f', 'chest')
        B.box((0.005, 0.016, 0.04), (-0.008, -tr * 0.8 - 0.017, fz), '#0b2a6f', 'chest')
    if c.get('emblem') == 'label':
        # белая «этикетка» на чёрной футболке: рамка и строки-полоски, без текста
        ly = -tr * 0.78 - 0.008
        for (w_, h_, zz) in ((0.2, 0.012, z(0.76)), (0.2, 0.012, z(0.56)), ):
            B.box((w_, 0.008, h_), (0, ly, zz), '#f2f2f2', 'chest')
        for sx_ in (-0.1, 0.1):
            B.box((0.012, 0.008, 0.2), (sx_, ly, z(0.66)), '#f2f2f2', 'chest')
        for zz, w_ in ((0.73, 0.15), (0.7, 0.08), (0.66, 0.12), (0.62, 0.15), (0.59, 0.1)):
            B.box((w_, 0.009, 0.012), (0, ly - 0.001, z(zz)), '#f2f2f2', 'chest')
    if c.get('emblem') == 'heart':
        # сердце в цветах флагов: левая половина сине-жёлтая, правая бело-красная
        hy = -tr * 0.78 - 0.01
        hz_ = z(0.7)
        B.sphere(0.045, (0.04, hy, hz_), '#2f6fd6', 'chest', scale=(1, 0.3, 1), seg=8, rings=5)
        B.sphere(0.045, (-0.04, hy, hz_), '#f2f2f2', 'chest', scale=(1, 0.3, 1), seg=8, rings=5)
        B.tri(0.06, (0.03, hy, hz_ - 0.045), -math.pi / 2, '#ffd23f', 'chest', thick=0.012)
        B.tri(0.06, (-0.03, hy, hz_ - 0.045), -math.pi / 2, '#e53935', 'chest', thick=0.012)
    if c.get('emblem') == 'laurel':
        # маленький белый венок на груди
        B.torus(0.022, 0.005, (-0.07, -tr * 0.78 - 0.006, z(0.74)), '#f2f2f2', 'chest', rot=(math.pi / 2, 0, 0), seg=10, tseg=3)
    if tt == 'hoodie':
        # карман-кенгуру
        B.box((0.2, 0.02, 0.07), (0, -tr * 0.78, z(0.58)), mix_hex(top['color'], '#000000', 0.25), 'chest')
        for side in (1, -1):
            B.rod(0.007, (side * 0.03, -tr * 0.79, t1 - 0.01), (side * 0.035, -tr * 0.8, t1 - 0.11), top.get('trim', '#ddd'), 'chest', seg=4)

    fy = -tr * 0.78 - 0.006
    if c.get('emblem') == 'berserk':
        # «клеймо»: два тёмно-красных треугольника — большой остриём вниз, малый вверх над ним
        ec = '#7a0d0d'
        B.tri(0.1, (0, fy, z(0.65)), -math.pi / 2, ec, 'chest')
        B.tri(0.06, (0, fy - 0.002, z(0.76)), math.pi / 2, ec, 'chest')
        B.box((0.012, 0.009, 0.2), (0, fy - 0.003, z(0.67)), '#2a0606', 'chest')
    if c.get('emblem') == 'horseshoe':
        # подкова (в духе джинсового бренда, без надписей)
        gc = '#e0b43a'
        B.torus(0.06, 0.012, (0, fy, z(0.69)), gc, 'chest', rot=(math.pi / 2, 0, 0), seg=14, tseg=4)
        B.box((0.06, 0.012, 0.03), (0, fy + 0.004, z(0.745)), top['color'], 'chest')

    if c.get('emblem') == 'brand':
        # своя эмблема: клинок и два отростка, тёмно-красная
        ec = '#6b0f0f'
        fy = -tr * 0.78 - 0.006
        B.box((0.022, 0.008, 0.17), (0, fy, z(0.68)), ec, 'chest')
        B.box((0.018, 0.008, 0.09), (0.035, fy, z(0.72)), ec, 'chest', rot=(0, -0.65, 0))
        B.box((0.018, 0.008, 0.09), (-0.035, fy, z(0.72)), ec, 'chest', rot=(0, 0.65, 0))
        B.sphere(0.018, (0, fy, z(0.58)), ec, 'chest', scale=(1, 0.4, 1.4), seg=6, rings=4)

    # --- руки
    sh = z(0.8)
    hand_z = z(0.47)
    weapon = c.get('weapon')
    for side, bone in ((1, 'arm_L'), (-1, 'arm_R')):
        x = sx * side
        sleeve = top.get('sleeves', top['color'])
        if tt == 'sweater':
            n = 4
            for i in range(n):
                a = sh - (sh - hand_z - 0.04) * i / n
                b = sh - (sh - hand_z - 0.04) * (i + 1) / n
                B.cyl(ar, ar, b, a, (x, 0), top['color'] if i % 2 == 0 else top['stripe'], bone, seg=8)
        elif tt in ('tee', 'checker'):
            if tt == 'checker':
                B.checker_ring(ar * 1.15, ar * 1.25, z(0.66), sh, 8, top['color'], top['stripe'], bone, xy=(x, 0))
            else:
                B.cyl(ar * 1.15, ar * 1.25, z(0.66), sh, (x, 0), top['color'], bone, seg=8)
            B.cyl(ar * 0.85, ar * 0.85, hand_z + 0.03, z(0.67), (x, 0), skin, bone, seg=8)
        elif tt == 'puffer':
            for i in range(3):
                zc = sh - (sh - hand_z - 0.06) * (i + 0.5) / 3
                B.sphere(ar * 1.7, (x, 0, zc), sleeve, bone, scale=(1, 1, 0.75), seg=10, rings=6)
        else:
            B.cyl(ar, ar * 1.05, hand_z + 0.04, sh, (x, 0), sleeve, bone, seg=8)
            if trim and tt in ('bomber', 'varsity'):
                B.cyl(ar * 1.12, ar * 1.12, hand_z + 0.04, hand_z + 0.08, (x, 0), trim, bone, seg=8)
            if tt == 'tracksuit':
                B.box((0.012, 0.016, sh - hand_z - 0.04), (x + side * ar, 0, (sh + hand_z) / 2 + 0.02), top.get('stripe', '#fff'), bone)
        B.sphere(ar * 1.15, (x, 0, sh), sleeve if tt != 'sweater' else top['color'], bone, seg=8, rings=5)
        if build == 'huge':
            # качок: огромные дельты и бицепс, мощное предплечье
            B.sphere(ar * 1.75, (x + side * 0.02, 0, sh - 0.02), sleeve, bone, scale=(1, 1, 0.9), seg=8, rings=6)
            arm_skin = tt in ('tee', 'checker')
            B.sphere(ar * 1.35, (x, -0.01, (sh + hand_z) / 2 + 0.02), skin if arm_skin else sleeve, bone, scale=(1, 1, 1.3), seg=8, rings=5)
            B.sphere(ar * 1.1, (x, 0, hand_z + 0.09), skin if arm_skin else sleeve, bone, scale=(1, 1, 1.4), seg=8, rings=5)
        if top.get('badge') and side == 1:
            # нашивка на левом рукаве (компас-патч, без логотипа)
            B.box((0.012, 0.06, 0.06), (x + ar * 1.05, 0, sh - 0.12), '#141414', bone)
            B.box((0.014, 0.04, 0.04), (x + ar * 1.06, 0, sh - 0.12), '#f2c94c', bone)
            B.box((0.016, 0.02, 0.02), (x + ar * 1.07, 0, sh - 0.12), '#2f9e5b', bone)
        hr = ar * 1.25
        hcol = skin
        if weapon == 'fists':
            hr = ar * 1.75
        if weapon == 'gloves':
            hr, hcol = ar * 1.8, '#b71c1c'
        B.sphere(hr, (x, 0, hand_z), hcol, bone, seg=8, rings=6)
        if weapon == 'gloves':
            B.cyl(ar * 1.3, ar * 1.3, hand_z + hr * 0.6, hand_z + hr * 0.6 + 0.04, (x, 0), '#f2f2f2', bone, seg=8)

    if 'watch' in c.get('accessories', []):
        B.cyl(ar * 1.15, ar * 1.15, hand_z + 0.06, hand_z + 0.09, (sx, 0), '#d4d4d4', 'arm_L', seg=8)

    # --- оружие
    hx = -sx
    if weapon == 'pistols':
        for side, bone in ((1, 'arm_L'), (-1, 'arm_R')):
            x = sx * side
            B.box((0.045, 0.17, 0.06), (x, -0.07, hand_z - 0.03), '#d9a520', bone)
            B.box((0.04, 0.05, 0.08), (x, -0.0, hand_z - 0.07), '#2b2b2b', bone, rot=(-0.3, 0, 0))
    elif weapon == 'sign':
        B.rod(0.014, (hx, -0.02, hand_z - 0.05), (hx, -0.02, hand_z + 0.32), '#8d5a2b', 'arm_R', seg=6)
        B.box((0.34, 0.025, 0.22), (hx, -0.03, hand_z + 0.38), '#d32f2f', 'arm_R')
        B.box((0.31, 0.03, 0.19), (hx, -0.035, hand_z + 0.38), '#ffffff', 'arm_R')
        B.box((0.22, 0.034, 0.025), (hx, -0.037, hand_z + 0.41), '#111111', 'arm_R')
        B.box((0.16, 0.034, 0.025), (hx, -0.037, hand_z + 0.35), '#111111', 'arm_R')
    elif weapon == 'shotgun':
        B.rod(0.035, (hx, 0.05, hand_z - 0.02), (hx, -0.42, hand_z - 0.02), '#3a3a3a', 'arm_R', seg=8)
        B.rod(0.03, (hx - 0.05, 0.0, hand_z - 0.02), (hx - 0.05, -0.38, hand_z - 0.02), '#3a3a3a', 'arm_R', seg=8)
        B.box((0.07, 0.16, 0.09), (hx - 0.02, 0.12, hand_z - 0.05), '#7a4a22', 'arm_R', rot=(0.2, 0, 0))
        B.box((0.08, 0.12, 0.05), (hx - 0.02, -0.2, hand_z - 0.06), '#7a4a22', 'arm_R')
    elif weapon == 'megaphone':
        # мегафон: раструб вперёд, ручка вниз
        mz = hand_z + 0.02
        res = B.rod(0.04, (hx, -0.02, mz), (hx, -0.12, mz), '#f2f2f2', 'arm_R', seg=10)
        B.bm.verts.ensure_lookup_table()
        cone = bmesh.ops.create_cone(B.bm, cap_ends=True, cap_tris=False, segments=12, radius1=0.045, radius2=0.12, depth=0.16,
                                     matrix=Matrix.Translation((hx, -0.2, mz)) @ Euler((math.pi / 2, 0, 0)).to_matrix().to_4x4())
        B._finish(cone['verts'], '#e53935', 'arm_R', True)
        B.box((0.03, 0.04, 0.09), (hx, -0.05, mz - 0.07), '#222222', 'arm_R')
    elif weapon == 'bag':
        # пакет с бургерами в левой руке, стакан кофе в правой
        lx_ = sx
        B.box((0.16, 0.11, 0.2), (lx_ + 0.02, -0.02, hand_z - 0.13), '#c89b62', 'arm_L')
        B.box((0.165, 0.115, 0.03), (lx_ + 0.02, -0.02, hand_z - 0.02), '#a97d48', 'arm_L')
        B.box((0.05, 0.118, 0.05), (lx_ + 0.02, -0.02, hand_z - 0.12), '#d32f2f', 'arm_L')
        B.cyl(0.035, 0.045, hand_z - 0.1, hand_z + 0.04, (hx, -0.04), '#f5f0e6', 'arm_R', seg=8)
        B.cyl(0.047, 0.047, hand_z + 0.03, hand_z + 0.05, (hx, -0.04), '#4a2c1a', 'arm_R', seg=8)
    elif weapon == 'bottle':
        B.cyl(0.04, 0.04, hand_z - 0.12, hand_z + 0.06, (hx, -0.05), '#2f9e5b', 'arm_R', seg=8)
        B.cyl(0.015, 0.03, hand_z + 0.06, hand_z + 0.13, (hx, -0.05), '#2f9e5b', 'arm_R', seg=6)
        B.cyl(0.042, 0.042, hand_z - 0.07, hand_z - 0.01, (hx, -0.05), '#f2e6c8', 'arm_R', seg=8)
    elif weapon == 'blaster':
        # игрушечный бластер для мячей-рикошетов
        B.box((0.06, 0.2, 0.08), (hx, -0.09, hand_z - 0.03), '#f2c94c', 'arm_R')
        B.rod(0.03, (hx, -0.18, hand_z - 0.02), (hx, -0.26, hand_z - 0.02), '#1a1a1a', 'arm_R', seg=8)
        B.box((0.045, 0.05, 0.09), (hx, 0.0, hand_z - 0.08), '#1a1a1a', 'arm_R', rot=(-0.3, 0, 0))
    elif weapon == 'arcade':
        # ретро-пушка 8-Бита: корпус с пикселями
        B.box((0.1, 0.26, 0.11), (hx, -0.1, hand_z - 0.02), '#5b2a9e', 'arm_R')
        B.box((0.104, 0.06, 0.04), (hx, -0.04, hand_z + 0.025), '#5cf2ff', 'arm_R')
        B.box((0.104, 0.04, 0.03), (hx, -0.16, hand_z + 0.025), '#ff4fd8', 'arm_R')
        B.rod(0.04, (hx, -0.23, hand_z - 0.02), (hx, -0.3, hand_z - 0.02), '#2a2a2a', 'arm_R', seg=8)
    elif weapon == 'shuriken':
        for a in (0, math.pi / 4):
            B.cyl(0.09, 0.09, hand_z - 0.005, hand_z + 0.005, (hx, -0.08), '#9fa6ad', 'arm_R', seg=4, cap=True)
            B.sphere(0.02, (hx, -0.08, hand_z), '#333', 'arm_R', seg=6, rings=4)

    # --- шея и голова
    hz = z(0.84) + 0.29
    B.cyl(0.06, 0.06, z(0.82), hz - 0.18, (0, 0), skin, 'head', seg=8)
    head_r = 0.325
    B.sphere(head_r, (0, 0, hz), skin, 'head', scale=(1.0, 0.95, 0.95), seg=14, rings=10)
    for side in (1, -1):
        B.sphere(0.055, (side * head_r * 0.98, 0.0, hz - 0.01), skin, 'head', scale=(0.6, 1, 1), seg=8, rings=5)
    eye_z = hz - 0.01
    fy = -head_r * 0.95
    if 'sunglasses' in c.get('accessories', []):
        B.box((0.44, 0.04, 0.1), (0, fy + 0.0, eye_z + 0.01), '#101010', 'head')
        B.box((0.1, 0.045, 0.02), (0.09, fy - 0.001, eye_z + 0.03), '#5ad1ff', 'head')
    else:
        for side in (1, -1):
            B.sphere(0.07, (side * 0.115, fy + 0.04, eye_z), '#ffffff', 'head', scale=(0.9, 0.55, 1.15), seg=8, rings=6)
            B.sphere(0.037, (side * 0.115, fy + 0.0, eye_z - 0.005), '#1a1a1a', 'head', scale=(1, 0.5, 1.2), seg=6, rings=4)
        brow = hair['color'] if hair['style'] != 'none' else '#5a4030'
        if c.get('beard'):
            brow = c['beard']['color']
        for side in (1, -1):
            B.box((0.09, 0.02, 0.025), (side * 0.115, fy + 0.025, eye_z + 0.1), brow, 'head', rot=(0, side * 0.12, 0))
    B.sphere(0.03, (0, fy - 0.01, hz - 0.07), skin, 'head', seg=6, rings=4)
    if not c.get('beard'):
        B.box((0.07, 0.02, 0.016), (0, fy + 0.03, hz - 0.14), '#5a2a22', 'head')

    # --- волосы
    st = hair['style']
    if st != 'none':
        under = hair.get('under', hair['color'])
        cap_keep = lambda x, y, zz: zz > (-0.3 + 0.75 * ((-y + 1) / 2)) * 0.95 or (zz > -0.35 and y > 0.2)
        rr = head_r + (0.012 if st in ('buzz', 'taper') else 0.025)
        cap_col = under if st == 'crop' else mix_hex(hair['color'], skin, 0.5) if st == 'taper' else hair.get('inner', hair['color']) if st == 'hood' else hair['color']
        B.sphere(rr, (0, 0.005, hz), cap_col, 'head', scale=(1.0, 0.97, 0.97), seg=14, rings=10, keep=cap_keep)
        if st == 'short':
            B.sphere(head_r * 0.85, (0, -0.02, hz + 0.1), hair['color'], 'head', scale=(1.05, 1.0, 0.6), seg=12, rings=7)
        if st == 'crop':
            B.sphere(head_r * 0.82, (0, -0.02, hz + 0.13), hair['color'], 'head', scale=(1.05, 1.0, 0.55), seg=12, rings=7)
        if st == 'hood':
            # капюшон надет: оболочка вокруг головы, открыто только лицо
            B.sphere(head_r + 0.075, (0, 0.02, hz + 0.02), hair['color'], 'head', scale=(1.05, 1.0, 1.05), seg=16, rings=10,
                     keep=lambda x, y, zz: y > -0.62 or zz > 0.55)
            B.torus(head_r * 0.82, 0.03, (0, -head_r * 0.62, hz + 0.0), mix_hex(hair['color'], '#000000', 0.2), 'head', rot=(math.pi / 2 - 0.15, 0, 0), seg=16, tseg=4)
        if st == 'taper':
            # тейпер-фейд: виски почти под кожу, сверху короткий объём
            B.sphere(head_r * 0.8, (0, -0.015, hz + 0.135), hair['color'], 'head', scale=(1.0, 1.02, 0.5), seg=12, rings=7)
        if st == 'curly':
            n = hair.get('count', 26)
            ga = math.pi * (3 - math.sqrt(5))
            for i in range(n):
                yy = 1 - (i / (n - 1)) * 1.3
                rad = math.sqrt(max(0, 1 - yy * yy))
                th = ga * i
                v = Vector((math.cos(th) * rad, math.sin(th) * rad, yy))
                if not cap_keep(v.x, v.y, v.z) and v.z < 0.3:
                    continue
                p = Vector((0, 0, hz)) + v * (head_r + 0.04)
                B.ico(0.075 + 0.02 * ((i * 7) % 3) / 2, tuple(p), hair['color'], 'head', sub=1)
    if c.get('beard'):
        bc = c['beard']['color']
        B.sphere(head_r * 0.98, (0, -0.02, hz - 0.03), bc, 'head', scale=(1.0, 0.98, 1.0), seg=14, rings=10,
                 keep=lambda x, y, zz: zz < -0.05 and y < 0.35)
        B.box((0.14, 0.03, 0.03), (0, fy - 0.005, hz - 0.11), bc, 'head')
    if 'earring' in c.get('accessories', []):
        B.ico(0.022, (-head_r * 1.0, -0.01, hz - 0.08), '#ffd54a', 'head', sub=1)

    # --- цепь
    if 'trident' in c.get('accessories', []):
        # цепочка с маленьким трезубцем
        B.torus(0.11 if build != 'huge' else 0.15, 0.008, (0, -0.05, z(0.8)), '#d9b13b', 'chest', rot=(0.6, 0, 0), seg=16, tseg=3)
        py_ = -tr * 0.8 - 0.012
        B.box((0.008, 0.008, 0.045), (0, py_, z(0.7)), '#d9b13b', 'chest')
        for sx_ in (-0.015, 0.015):
            B.box((0.006, 0.008, 0.03), (sx_, py_, z(0.705)), '#d9b13b', 'chest')
        B.box((0.036, 0.008, 0.006), (0, py_, z(0.69)), '#d9b13b', 'chest')
    if 'chain' in c.get('accessories', []):
        B.torus(0.12 if build != 'big' else 0.14, 0.014, (0, -0.05, z(0.79)), '#ffcc33', 'chest', rot=(0.6, 0, 0), seg=16, tseg=4)
        B.box((0.05, 0.015, 0.06), (0, -tr * 0.8 - 0.01, z(0.67)), '#ffcc33', 'chest')

    return {'tr': tr, 'sx': sx, 'lx': lx, 'sh': sh, 'hand_z': hand_z, 'hz': hz, 'H': H}


def make_armature(name, dims):
    H = dims['H']
    arm = bpy.data.armatures.new(name + '_rig')
    obj = bpy.data.objects.new(name + '_rig', arm)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.edit_bones

    def bone(n, head, tail, parent=None):
        b = eb.new(n)
        b.head, b.tail = head, tail
        b.roll = 0
        if parent:
            b.parent = eb[parent]
        return b

    bone('root', (0, 0, 0), (0, 0, 0.2))
    bone('hips', (0, 0, 0.46 * H), (0, 0, 0.55 * H), 'root')
    bone('chest', (0, 0, 0.55 * H), (0, 0, 0.84 * H), 'hips')
    bone('head', (0, 0, 0.84 * H), (0, 0, dims['hz'] + 0.25), 'chest')
    bone('arm_L', (dims['sx'], 0, dims['sh']), (dims['sx'], 0, dims['hand_z']), 'chest')
    bone('arm_R', (-dims['sx'], 0, dims['sh']), (-dims['sx'], 0, dims['hand_z']), 'chest')
    bone('leg_L', (dims['lx'], 0, 0.46 * H), (dims['lx'], 0, 0.05), 'hips')
    bone('leg_R', (-dims['lx'], 0, 0.46 * H), (-dims['lx'], 0, 0.05), 'hips')
    bpy.ops.object.mode_set(mode='POSE')
    for pb in obj.pose.bones:
        pb.rotation_mode = 'XYZ'
    return obj


def forward_sign(obj, bname):
    """+1 если положительный поворот по X кости двигает её конец вперёд (-Y)."""
    pb = obj.pose.bones[bname]
    bpy.context.view_layer.update()
    t0 = (obj.matrix_world @ pb.tail).copy()
    pb.rotation_euler = (0.4, 0, 0)
    bpy.context.view_layer.update()
    t1 = obj.matrix_world @ pb.tail
    pb.rotation_euler = (0, 0, 0)
    bpy.context.view_layer.update()
    if bname == 'root':
        # корень вертикальный: вперёд = конец уходит в -Y
        return 1 if t1.y < t0.y else -1
    return 1 if t1.y < t0.y else -1


def make_actions(obj, weapon):
    S = {b: forward_sign(obj, b) for b in BONES}
    # "вперёд" для ног/рук, "наклон вперёд" для корпуса
    melee = weapon in ('fists', 'gloves')

    def act(name, length, keys, loc_keys=None, loop=True):
        a = bpy.data.actions.new(name)
        a.use_fake_user = True
        obj.animation_data_create()
        obj.animation_data.action = a
        for pb in obj.pose.bones:
            pb.rotation_euler = (0, 0, 0)
            pb.location = (0, 0, 0)
        for bname, frames in keys.items():
            pb = obj.pose.bones[bname]
            for f, rot in frames:
                pb.rotation_euler = (rot[0] * S[bname], rot[1], rot[2])
                pb.keyframe_insert('rotation_euler', frame=f)
        for f, v in (loc_keys or []):
            pb = obj.pose.bones['root']
            pb.location = (0, v, 0)  # локальная Y корня = вверх
            pb.keyframe_insert('location', frame=f)
        for pb in obj.pose.bones:
            if not any(fc for fc in iter_fcurves(a) if pb.name in fc.data_path):
                pb.rotation_euler = (0, 0, 0)
                pb.keyframe_insert('rotation_euler', frame=1)
                pb.keyframe_insert('rotation_euler', frame=length)
        return a

    D = math.radians
    L = 30
    act('idle', L + 1, {
        'chest': [(1, (D(0), 0, 0)), (16, (D(3), 0, 0)), (L + 1, (D(0), 0, 0))],
        'head': [(1, (D(0), 0, 0)), (16, (D(-3), 0, 0)), (L + 1, (D(0), 0, 0))],
        'arm_L': [(1, (D(4), 0, D(6))), (16, (D(8), 0, D(9))), (L + 1, (D(4), 0, D(6)))],
        'arm_R': [(1, (D(4), 0, D(-6))), (16, (D(8), 0, D(-9))), (L + 1, (D(4), 0, D(-6)))],
    }, [(1, 0), (16, -0.015), (L + 1, 0)])

    R = 16
    sw = D(38)
    act('run', R + 1, {
        'leg_L': [(1, (sw, 0, 0)), (9, (-sw, 0, 0)), (R + 1, (sw, 0, 0))],
        'leg_R': [(1, (-sw, 0, 0)), (9, (sw, 0, 0)), (R + 1, (-sw, 0, 0))],
        'arm_L': [(1, (-sw, 0, D(8))), (9, (sw, 0, D(8))), (R + 1, (-sw, 0, D(8)))],
        'arm_R': [(1, (sw, 0, D(-8))), (9, (-sw, 0, D(-8))), (R + 1, (sw, 0, D(-8)))],
        'chest': [(1, (D(10), D(6), 0)), (9, (D(10), D(-6), 0)), (R + 1, (D(10), D(6), 0))],
        'hips': [(1, (0, D(-5), 0)), (9, (0, D(5), 0)), (R + 1, (0, D(-5), 0))],
    }, [(1, 0), (5, 0.04), (9, 0), (13, 0.04), (R + 1, 0)])

    if melee:
        act('attack', 13, {
            'arm_R': [(1, (D(0), 0, 0)), (3, (D(85), 0, D(15))), (6, (D(20), 0, 0)), (13, (0, 0, 0))],
            'arm_L': [(1, (D(0), 0, 0)), (6, (D(0), 0, 0)), (9, (D(85), 0, D(-15))), (13, (0, 0, 0))],
            'chest': [(1, (0, 0, 0)), (3, (D(8), D(-20), 0)), (9, (D(8), D(20), 0)), (13, (0, 0, 0))],
        }, loop=False)
    else:
        both = weapon == 'pistols'
        keys = {
            'arm_R': [(1, (D(0), 0, 0)), (3, (D(85), 0, 0)), (9, (D(80), 0, 0)), (13, (0, 0, 0))],
            'chest': [(1, (0, 0, 0)), (3, (D(-6), 0, 0)), (13, (0, 0, 0))],
        }
        if both:
            keys['arm_L'] = [(1, (D(0), 0, 0)), (3, (D(85), 0, 0)), (9, (D(80), 0, 0)), (13, (0, 0, 0))]
        if weapon == 'sign':
            keys['arm_R'] = [(1, (D(0), 0, 0)), (3, (D(-40), 0, 0)), (6, (D(110), 0, 0)), (13, (0, 0, 0))]
        act('attack', 13, keys, loop=False)

    act('super', 19, {
        'arm_L': [(1, (0, 0, 0)), (5, (D(-20), 0, D(40))), (10, (D(160), 0, D(20))), (19, (0, 0, 0))],
        'arm_R': [(1, (0, 0, 0)), (5, (D(-20), 0, D(-40))), (10, (D(160), 0, D(-20))), (19, (0, 0, 0))],
        'leg_L': [(1, (0, 0, 0)), (5, (D(30), 0, 0)), (10, (D(-10), 0, 0)), (19, (0, 0, 0))],
        'leg_R': [(1, (0, 0, 0)), (5, (D(30), 0, 0)), (10, (D(-10), 0, 0)), (19, (0, 0, 0))],
        'chest': [(1, (0, 0, 0)), (5, (D(20), 0, 0)), (10, (D(-15), 0, 0)), (19, (0, 0, 0))],
    }, [(1, 0), (5, -0.08), (10, 0.25), (19, 0)], loop=False)

    act('death', 25, {
        'root': [(1, (0, 0, 0)), (12, (D(-95), 0, 0)), (25, (D(-90), 0, 0))],
        'arm_L': [(1, (0, 0, 0)), (12, (D(-60), 0, D(50))), (25, (D(-70), 0, D(60)))],
        'arm_R': [(1, (0, 0, 0)), (12, (D(-60), 0, D(-50))), (25, (D(-70), 0, D(-60)))],
        'head': [(1, (0, 0, 0)), (25, (D(-20), 0, 0))],
    }, [(1, 0), (8, 0.15), (25, 0.05)], loop=False)
    obj.animation_data.action = bpy.data.actions['idle']


def iter_fcurves(action):
    # Blender 4.4+: слоёные действия
    if hasattr(action, 'layers') and len(action.layers):
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    yield from bag.fcurves
    elif hasattr(action, 'fcurves'):
        yield from action.fcurves


def build(c):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    B = Builder()
    dims = build_body(B, c)
    me = bpy.data.meshes.new(c['id'])
    B.bm.to_mesh(me)
    B.bm.free()
    obj = bpy.data.objects.new(c['id'], me)
    bpy.context.scene.collection.objects.link(obj)
    for n in BONES:
        obj.vertex_groups.new(name=n)
    if me.color_attributes:
        me.color_attributes.active_color = me.color_attributes[0]
        me.color_attributes.render_color_index = 0
    mat = bpy.data.materials.new(c['id'] + '_mat')
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Color'
    nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.8
    me.materials.append(mat)

    rig = make_armature(c['id'], dims)
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.parent = rig
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = rig
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='POSE')
    make_actions(rig, c.get('weapon'))
    bpy.ops.object.mode_set(mode='OBJECT')

    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, c['id'] + '.glb')
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=False,
        export_animations=True, export_animation_mode='ACTIONS', export_skins=True,
        export_vertex_color='ACTIVE', export_all_vertex_colors=False,
        export_yup=True, export_apply=False, export_force_sampling=True, export_optimize_animation_size=False,
        export_def_bones=False, export_leaf_bone=False, export_image_format='NONE', export_materials='EXPORT',
    )
    print(f'BUILT {c["id"]}: {tris} tris -> {path}')
    return tris


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    with open(os.path.join(HERE, 'characters.json'), encoding='utf-8') as f:
        data = json.load(f)
    for c in data['characters']:
        if argv and c['id'] not in argv:
            continue
        tris = build(c)
        if tris > 3000:
            print(f'WARNING {c["id"]} has {tris} tris (> 3000)')


main()
