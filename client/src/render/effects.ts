import * as THREE from 'three';
import { LOOKS } from '../../../shared/protocol';
import { toonMaterial, addOutline, paint } from './toon';

const UP = new THREE.Vector3(0, 1, 0);

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,240,180,0.8)');
  gr.addColorStop(1, 'rgba(255,200,80,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function signTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d32f2f'; g.fillRect(0, 0, 256, 160);
  g.fillStyle = '#fff'; g.fillRect(10, 10, 236, 140);
  g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '900 46px Arial Black, sans-serif';
  g.fillText('ИДИТЕ', 128, 56);
  g.fillText('НАФИГ', 128, 108);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let glowTex: THREE.Texture | null = null;

/** Снаряды по виду (look) из снапшотов. */
export class ProjectileViews {
  group = new THREE.Group();
  private pools = new Map<number, THREE.Object3D[]>();
  private active = new Map<number, { obj: THREE.Object3D; look: number }>();
  private seen = new Set<number>();
  private protos: THREE.Object3D[] = [];

  constructor() {
    glowTex ??= glowTexture();
    const glow = (color: number, size: number) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.scale.set(size, size, 1);
      return s;
    };
    const trail = (color: number, len: number, wid: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(wid, len), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.position.z = -len / 2;
      return m;
    };
    for (const look of LOOKS) {
      const g = new THREE.Group();
      if (look === 'bullet' || look === 'heavy') {
        const big = look === 'heavy';
        const b = new THREE.Mesh(new THREE.CapsuleGeometry(big ? 0.1 : 0.07, big ? 0.3 : 0.2, 3, 6), toonMaterial({ color: big ? 0xff7a1a : 0xffd84a, emissive: big ? 0x803000 : 0x806000 }));
        b.rotation.x = Math.PI / 2;
        addOutline(b);
        g.add(b, trail(big ? 0xff8a2a : 0xfff0a0, big ? 1.4 : 1.0, big ? 0.16 : 0.1), glow(big ? 0xff9a3a : 0xfff0a0, big ? 0.7 : 0.45));
      } else if (look === 'pellet') {
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), toonMaterial({ color: 0xffb02e, emissive: 0x803800 }));
        addOutline(b);
        g.add(b, trail(0xffc070, 0.6, 0.1), glow(0xffb040, 0.4));
      } else if (look === 'shuriken') {
        const s = new THREE.Group();
        for (const a of [0, Math.PI / 4]) {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 4), toonMaterial({ color: 0xc8d0d8 }));
          m.rotation.y = a;
          addOutline(m);
          s.add(m);
        }
        s.name = 'spin';
        g.add(s, trail(0xb0ffb0, 0.7, 0.12));
      } else if (look === 'fist') {
        const m = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.06, 6, 14, Math.PI), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }));
        m.rotation.x = -Math.PI / 2;
        g.add(m);
      } else if (look === 'sign') {
        const tex = signTexture();
        const s = new THREE.Group();
        const board = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.05, 0.4), [
          toonMaterial({ color: 0xd32f2f }), toonMaterial({ color: 0xd32f2f }),
          toonMaterial({ map: tex }), toonMaterial({ map: tex }),
          toonMaterial({ color: 0xd32f2f }), toonMaterial({ color: 0xd32f2f }),
        ]);
        addOutline(board);
        s.add(board);
        s.name = 'spin';
        g.add(s);
      }
      g.position.y = 0.55;
      this.protos.push(g);
    }
  }

  private take(look: number) {
    const pool = this.pools.get(look) ?? [];
    this.pools.set(look, pool);
    const o = pool.pop() ?? this.protos[look].clone(true);
    this.group.add(o);
    return o;
  }

  /** list: [id, look, x, y, angle] уже интерполированные. */
  sync(list: { id: number; look: number; x: number; y: number; a: number }[], now: number) {
    this.seen.clear();
    for (const p of list) {
      this.seen.add(p.id);
      let e = this.active.get(p.id);
      if (!e) { e = { obj: this.take(p.look), look: p.look }; this.active.set(p.id, e); }
      e.obj.position.x = p.x;
      e.obj.position.z = p.y;
      e.obj.rotation.y = Math.PI / 2 - p.a;
      const spin = e.obj.getObjectByName('spin');
      if (spin) spin.rotation.y = now / 60;
      if (LOOKS[p.look] === 'sign') { spin!.rotation.y = 0; spin!.rotation.z = Math.sin(now / 90) * 0.3; spin!.position.y = Math.abs(Math.sin(now / 120)) * 0.5; }
    }
    for (const [id, e] of this.active) {
      if (this.seen.has(id)) continue;
      e.obj.removeFromParent();
      this.pools.get(e.look)!.push(e.obj);
      this.active.delete(id);
    }
  }
}

interface Particle { v: THREE.Vector3; life: number; max: number; spin: number }

/** Частицы, вспышки, кольца взрывов. */
export class Fx {
  group = new THREE.Group();
  private parts: THREE.InstancedMesh;
  private pdata: (Particle | null)[] = [];
  private pnext = 0;
  private flashes: { s: THREE.Sprite; until: number; start: number }[] = [];
  private rings: { m: THREE.Mesh; t: number; dur: number; r: number }[] = [];
  private markers: { s: THREE.Sprite; until: number }[] = [];
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private hitTex: THREE.Texture;

  constructor() {
    glowTex ??= glowTexture();
    const N = 260;
    this.parts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), toonMaterial({ vertexColors: false }), N);
    this.parts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < N; i++) { this.parts.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0)); this.parts.setColorAt(i, new THREE.Color(1, 1, 1)); this.pdata.push(null); }
    this.parts.frustumCulled = false;
    this.group.add(this.parts);
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.strokeStyle = '#fff'; g.lineWidth = 9; g.lineCap = 'round';
    g.beginPath(); g.moveTo(12, 12); g.lineTo(26, 26); g.moveTo(52, 12); g.lineTo(38, 26); g.moveTo(12, 52); g.lineTo(26, 38); g.moveTo(52, 52); g.lineTo(38, 38); g.stroke();
    this.hitTex = new THREE.CanvasTexture(c);
  }

  burst(x: number, y: number, z: number, color: THREE.ColorRepresentation, n: number, speed = 3, up = 3) {
    const col = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      const k = this.pnext; this.pnext = (this.pnext + 1) % this.pdata.length;
      const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random() * 0.8);
      this.pdata[k] = { v: new THREE.Vector3(Math.cos(a) * s, up * (0.5 + Math.random()), Math.sin(a) * s), life: 0, max: 0.5 + Math.random() * 0.4, spin: Math.random() * 10 };
      this.m4.makeTranslation(x, y, z);
      this.parts.setMatrixAt(k, this.m4);
      this.parts.setColorAt(k, col);
      (this.parts.userData.pos ??= [])[k] = new THREE.Vector3(x, y, z);
    }
    this.parts.instanceColor!.needsUpdate = true;
  }

  flash(x: number, y: number, z: number, color: number, size: number, now: number, dur = 80) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    s.position.set(x, y, z);
    s.scale.set(size, size, 1);
    this.group.add(s);
    this.flashes.push({ s, until: now + dur, start: now });
  }

  ring(x: number, y: number, r: number, color = 0xffffff, dur = 0.4) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.08, y);
    this.group.add(m);
    this.rings.push({ m, t: 0, dur, r });
  }

  hitMarker(x: number, y: number, now: number, big: boolean) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.hitTex, color: big ? 0xffe14d : 0xffffff, depthTest: false, transparent: true }));
    s.position.set(x, 1.0, y);
    const sz = big ? 0.75 : 0.5;
    s.scale.set(sz, sz, 1);
    s.renderOrder = 10;
    this.group.add(s);
    this.markers.push({ s, until: now + 160 });
  }

  update(dt: number, now: number) {
    const pos = this.parts.userData.pos as THREE.Vector3[] | undefined;
    let dirty = false;
    for (let k = 0; k < this.pdata.length; k++) {
      const p = this.pdata[k];
      if (!p || !pos) continue;
      p.life += dt;
      dirty = true;
      if (p.life >= p.max) { this.pdata[k] = null; this.parts.setMatrixAt(k, this.m4.makeScale(0, 0, 0)); continue; }
      p.v.y -= 12 * dt;
      const ps = pos[k];
      ps.addScaledVector(p.v, dt);
      if (ps.y < 0.06) { ps.y = 0.06; p.v.y *= -0.3; p.v.x *= 0.7; p.v.z *= 0.7; }
      const sc = 1 - p.life / p.max;
      this.q.setFromAxisAngle(UP, p.spin * p.life);
      this.m4.compose(ps, this.q, new THREE.Vector3(sc, sc, sc));
      this.parts.setMatrixAt(k, this.m4);
    }
    if (dirty) this.parts.instanceMatrix.needsUpdate = true;
    this.flashes = this.flashes.filter((f) => {
      if (now > f.until) { f.s.removeFromParent(); f.s.material.dispose(); return false; }
      f.s.material.opacity = 1 - (now - f.start) / (f.until - f.start);
      return true;
    });
    this.rings = this.rings.filter((r) => {
      r.t += dt;
      const k = r.t / r.dur;
      if (k >= 1) { r.m.removeFromParent(); r.m.geometry.dispose(); (r.m.material as THREE.Material).dispose(); return false; }
      const s = r.r * (0.3 + 0.7 * k);
      r.m.scale.set(s, s, s);
      (r.m.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
      return true;
    });
    this.markers = this.markers.filter((m) => {
      if (now > m.until) { m.s.removeFromParent(); m.s.material.dispose(); return false; }
      return true;
    });
  }
}

/** Ядовитый газ: туман снаружи безопасного квадрата + светящаяся стенка по границе. */
export class GasView {
  group = new THREE.Group();
  mat: THREE.ShaderMaterial;
  wallMat: THREE.ShaderMaterial;
  walls: THREE.Mesh[] = [];

  constructor(private w: number, private h: number) {
    const uniforms = { time: { value: 0 }, safeHalf: { value: 100 }, center: { value: new THREE.Vector2(w / 2, h / 2) } };
    this.mat = new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false,
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
      fragmentShader: `varying vec3 vW; uniform float time; uniform float safeHalf; uniform vec2 center;
        float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(h2(i),h2(i+vec2(1,0)),f.x), mix(h2(i+vec2(0,1)),h2(i+vec2(1,1)),f.x), f.y); }
        void main(){
          vec2 d = abs(vW.xz - center) - vec2(safeHalf);
          float outside = max(d.x, d.y);
          if (outside < -0.4) discard;
          float n = n2(vW.xz*0.6 + vec2(time*0.35, time*0.2)) * 0.6 + n2(vW.xz*1.7 - vec2(time*0.5, -time*0.3)) * 0.4;
          float a = smoothstep(-0.4, 1.2, outside) * (0.42 + 0.3*n);
          vec3 c = mix(vec3(0.25,0.85,0.2), vec3(0.65,1.0,0.35), n);
          gl_FragColor = vec4(c, a);
        }`,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w + 20, h + 20), this.mat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(w / 2, 1.25, h / 2);
    plane.renderOrder = 5;
    this.group.add(plane);
    // нижний слой — тоже туман, чтобы было видно и под персонажами
    const plane2 = plane.clone();
    plane2.position.y = 0.3;
    this.group.add(plane2);

    this.wallMat = new THREE.ShaderMaterial({
      uniforms: { time: uniforms.time }, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform float time;
        void main(){ float s = 0.5+0.5*sin(vUv.x*60.0 - time*3.0);
          float a = (1.0 - vUv.y) * (0.35 + 0.25*s);
          gl_FragColor = vec4(0.5, 1.0, 0.3, a); }`,
    });
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1.8), this.wallMat);
      m.renderOrder = 6;
      this.walls.push(m);
      this.group.add(m);
    }
  }

  update(half: number, now: number) {
    this.mat.uniforms.time.value = now / 1000;
    this.mat.uniforms.safeHalf.value = half;
    const cx = this.w / 2, cy = this.h / 2;
    const vis = half < Math.max(this.w, this.h) / 2;
    const len = half * 2;
    const pos: [number, number, number][] = [[cx, cy - half, 0], [cx, cy + half, 0], [cx - half, cy, Math.PI / 2], [cx + half, cy, Math.PI / 2]];
    this.walls.forEach((m, i) => {
      m.visible = vis;
      m.scale.x = len;
      m.position.set(pos[i][0], 0.9, pos[i][1]);
      m.rotation.y = pos[i][2];
    });
  }
}

/** Прицел на земле: полоса, веер или дуга с кругом. */
export class AimView {
  group = new THREE.Group();
  private strip: THREE.Mesh;
  private fan: THREE.Mesh;
  private dots: THREE.Mesh[] = [];
  private circle: THREE.Mesh;

  constructor() {
    const mat = (c: number, o: number) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, side: THREE.DoubleSide });
    // полоса длиной 1 вдоль +Z от точки игрока
    const sg = new THREE.PlaneGeometry(1, 1).translate(0, -0.5, 0).rotateX(-Math.PI / 2);
    this.strip = new THREE.Mesh(sg, mat(0xffffff, 0.35));
    this.fan = new THREE.Mesh(new THREE.CircleGeometry(1, 24, 0, 1), mat(0xffffff, 0.3));
    this.fan.rotation.x = -Math.PI / 2;
    this.circle = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32), mat(0xffd23f, 0.8));
    this.circle.rotation.x = -Math.PI / 2;
    for (let i = 0; i < 12; i++) {
      const d = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), mat(0xffd23f, 0.9));
      this.dots.push(d);
      this.group.add(d);
    }
    this.group.add(this.strip, this.fan, this.circle);
    this.hide();
    this.group.renderOrder = 4;
  }

  hide() { this.group.visible = false; }

  /** kind: line/spread/point; color: белый для атаки, жёлтый для супера. */
  show(kind: 'line' | 'spread' | 'point', x: number, y: number, angle: number, range: number, width: number, spreadDeg: number, dist: number, isSuper: boolean) {
    this.group.visible = true;
    const col = isSuper ? 0xffd23f : 0xffffff;
    (this.strip.material as THREE.MeshBasicMaterial).color.setHex(col);
    (this.fan.material as THREE.MeshBasicMaterial).color.setHex(col);
    this.strip.visible = kind === 'line';
    this.fan.visible = kind === 'spread';
    this.circle.visible = kind === 'point';
    for (const d of this.dots) d.visible = kind === 'point';
    if (kind === 'line') {
      this.strip.position.set(x, 0.06, y);
      this.strip.rotation.set(0, Math.PI / 2 - angle, 0);
      this.strip.scale.set(width, 1, range);
    } else if (kind === 'spread') {
      const th = (spreadDeg * Math.PI) / 180 + 0.08;
      this.fan.geometry.dispose();
      this.fan.geometry = new THREE.CircleGeometry(range, 24, -th / 2, th);
      this.fan.position.set(x, 0.06, y);
      this.fan.rotation.set(-Math.PI / 2, 0, -angle);
    } else {
      const tx = x + Math.cos(angle) * dist, ty = y + Math.sin(angle) * dist;
      this.circle.position.set(tx, 0.07, ty);
      this.circle.scale.setScalar(Math.max(0.6, width));
      this.dots.forEach((d, i) => {
        const k = (i + 1) / (this.dots.length + 1);
        d.position.set(x + (tx - x) * k, 0.2 + Math.sin(k * Math.PI) * Math.min(2.5, dist * 0.45), y + (ty - y) * k);
      });
    }
  }
}

export function makeBlobShadowMat() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  gr.addColorStop(0, 'rgba(0,0,0,0.45)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false });
}

/** Помощник Мистера Пи и его база. */
export function makeMinionMesh(type: number) {
  const g = new THREE.Group();
  if (type === 0) {
    const base = new THREE.Mesh(paint(new THREE.CylinderGeometry(0.45, 0.5, 0.5, 8).translate(0, 0.25, 0), '#e9e9e9'), toonMaterial({ vertexColors: true }));
    const roof = new THREE.Mesh(paint(new THREE.ConeGeometry(0.55, 0.45, 8).translate(0, 0.72, 0), '#111111'), toonMaterial({ vertexColors: true }));
    const door = new THREE.Mesh(paint(new THREE.BoxGeometry(0.22, 0.3, 0.05).translate(0, 0.17, 0.46), '#d32f2f'), toonMaterial({ vertexColors: true }));
    addOutline(base); addOutline(roof);
    g.add(base, roof, door);
  } else {
    const body = new THREE.Mesh(paint(new THREE.SphereGeometry(0.22, 10, 8).translate(0, 0.3, 0), '#f4f4f4'), toonMaterial({ vertexColors: true }));
    const stripe = new THREE.Mesh(paint(new THREE.CylinderGeometry(0.205, 0.205, 0.08, 10).translate(0, 0.3, 0), '#111111'), toonMaterial({ vertexColors: true }));
    const head = new THREE.Mesh(paint(new THREE.SphereGeometry(0.15, 10, 8).translate(0, 0.6, 0), '#2b1d14'), toonMaterial({ vertexColors: true }));
    addOutline(body); addOutline(head);
    g.add(body, stripe, head);
  }
  return g;
}
