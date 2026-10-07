import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GameMap, Tile } from '../../../shared/map';
import { toonMaterial, instancedOutline, paint, paintTopSide, addOutline } from './toon';

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Блок стены: скруглённый куб с градиентом по высоте и светлой «крышкой». */
function wallGeometry() {
  const body = new RoundedBoxGeometry(0.98, 1.0, 0.98, 2, 0.07).translate(0, 0.5, 0);
  const cap = new RoundedBoxGeometry(0.8, 0.14, 0.8, 2, 0.05).translate(0, 1.04, 0);
  const top = new THREE.Color('#a77ee8'), side = new THREE.Color('#8a62d0'), low = new THREE.Color('#4f3390'), capC = new THREE.Color('#bf9df5');
  const shade = (g: THREE.BufferGeometry, isCap: boolean) => {
    const pos = g.attributes.position, nrm = g.attributes.normal;
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      if (isCap) c.copy(nrm.getY(i) > 0.5 ? capC : top);
      else if (nrm.getY(i) > 0.6) c.copy(top);
      else c.copy(low).lerp(side, Math.min(1, pos.getY(i) / 0.95));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    return g;
  };
  return mergeGeometries([shade(body, false), shade(cap, true)])!;
}

function colorize(g: THREE.BufferGeometry, fn: (y: number, ny: number) => THREE.Color) {
  const pos = g.attributes.position, nrm = g.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = fn(pos.getY(i), nrm.getY(i));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

const FACADES = ['#e8a87c', '#d4673a', '#f2d0a4', '#8fb9d9', '#a8d5ba', '#f4d35e', '#e07a5f', '#c9b79c', '#b5838d', '#f6bd60'];

/** Дом старого города: корпус (красится instanceColor). */
function houseBody() {
  return colorize(new RoundedBoxGeometry(0.96, 1.25, 0.96, 1, 0.04).translate(0, 0.625, 0).toNonIndexed(), (_y, ny) => new THREE.Color(ny > 0.5 ? '#ffffff' : '#ffffff').multiplyScalar(ny > 0.5 ? 1 : 0.92));
}

/** Крыша-щипец, окна, дверь — не красятся. */
function houseDetail() {
  const parts: THREE.BufferGeometry[] = [];
  const roof = new THREE.CylinderGeometry(0.62, 0.62, 1.0, 3).rotateZ(Math.PI / 2).rotateX(Math.PI / 6).scale(1, 0.75, 1).translate(0, 1.25 + 0.2, 0);
  parts.push(colorize(roof.toNonIndexed(), () => new THREE.Color('#4a4450')));
  for (const s of [-1, 1]) {
    for (const wy of [0.42, 0.88]) for (const wx of [-0.22, 0.22]) {
      parts.push(colorize(new THREE.BoxGeometry(0.17, 0.22, 0.04).translate(wx, wy, s * 0.49).toNonIndexed(), () => new THREE.Color('#2b3a4a')));
    }
  }
  return mergeGeometries(parts)!;
}

/** Две бочки с обручами. */
function barrelGeometry() {
  const wood = new THREE.Color('#b0652e'), dark = new THREE.Color('#7a3f17'), lid = new THREE.Color('#c98a4b'), hoop = new THREE.Color('#4a4a52');
  const parts: THREE.BufferGeometry[] = [];
  for (const [bx, bz, s] of [[-0.2, -0.12, 1], [0.24, 0.18, 0.86]] as const) {
    const body = new THREE.CylinderGeometry(0.27 * s, 0.24 * s, 0.95 * s, 14, 1).translate(bx, 0.475 * s, bz);
    parts.push(colorize(body, (y, ny) => (ny > 0.5 ? lid : dark.clone().lerp(wood, Math.min(1, y / 0.6)))));
    for (const hy of [0.18, 0.77]) {
      const ring = new THREE.CylinderGeometry(0.28 * s, 0.28 * s, 0.07, 14, 1, true).translate(bx, hy * s, bz);
      parts.push(colorize(ring, () => hoop));
    }
  }
  return mergeGeometries(parts.map((p) => p.toNonIndexed()))!;
}

/** Деревянный забор: два столба и три доски вдоль X. */
function fenceGeometry() {
  const post = new THREE.Color('#8a5a2b'), plank = new THREE.Color('#c88a4a'), top = new THREE.Color('#e0a865');
  const parts: THREE.BufferGeometry[] = [];
  for (const px of [-0.4, 0.4]) parts.push(colorize(new RoundedBoxGeometry(0.18, 1.1, 0.18, 1, 0.03).translate(px, 0.55, 0), (_y, ny) => (ny > 0.5 ? top : post)));
  for (const py of [0.28, 0.58, 0.88]) parts.push(colorize(new RoundedBoxGeometry(1.02, 0.2, 0.1, 1, 0.03).translate(0, py, 0), (_y, ny) => (ny > 0.5 ? top : plank)));
  return mergeGeometries(parts.map((p) => p.toNonIndexed()))!;
}

function rnd(i: number) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

/** Пол, стены, кусты, вода, ящики. Повторяющееся — через InstancedMesh. */
export class MapView {
  group = new THREE.Group();
  wallMeshes: { mesh: THREE.InstancedMesh; index: Map<number, number> }[] = [];
  wallShadows!: THREE.InstancedMesh;
  shadowIndex = new Map<number, number>();
  bushes!: THREE.InstancedMesh;
  bushIndex: { ti: number; x: number; y: number; s: number; rot: number }[] = [];
  boxes!: THREE.InstancedMesh;
  boxIndex = new Map<number, number>();
  boxFlash = new Map<number, number>();
  water: THREE.Mesh | null = null;
  waterMat!: THREE.ShaderMaterial;
  private bushNearKey = '';
  cathedral: { mesh: THREE.Mesh; x0: number; y0: number; x1: number; y1: number } | null = null;
  private cathedralMat!: THREE.MeshToonMaterial;

  constructor(public map: GameMap) {
    this.buildFloor();
    this.buildWalls();
    this.buildBushes();
    this.buildBoxes();
    this.buildWater();
    this.buildCathedral();
  }

  private buildFloor() {
    const { w, h, tiles } = this.map;
    const S = 16;
    const cv = document.createElement('canvas');
    cv.width = w * S; cv.height = h * S;
    const g = cv.getContext('2d')!;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const odd = (x + y) % 2 === 0;
        const t = tiles[y * w + x];
        const kl = this.map.theme === 'koeln';
        g.fillStyle = t === Tile.Water ? (kl ? '#7f7a70' : '#b89a5c') : kl ? (odd ? '#b8b2a6' : '#aca598') : odd ? '#e6c98a' : '#dcbd7c';
        g.fillRect(x * S, y * S, S, S);
        if (t !== Tile.Water && rnd(x * 31 + y * 17) > 0.86) {
          g.fillStyle = this.map.theme === 'koeln' ? '#99938a' : '#c9a866';
          g.fillRect(x * S + 4 + rnd(x + y) * 6, y * S + 5 + rnd(x * y) * 6, 3, 2);
        }
      }
    }
    // пол темнее у краёв карты
    const edge = 3 * S;
    for (const [x0, y0, x1, y1] of [[0, 0, edge, 0], [w * S, 0, w * S - edge, 0], [0, 0, 0, edge], [0, h * S, 0, h * S - edge]]) {
      const lg = g.createLinearGradient(x0, y0, x1, y1);
      lg.addColorStop(0, 'rgba(90,60,20,0.35)');
      lg.addColorStop(1, 'rgba(90,60,20,0)');
      g.fillStyle = lg;
      g.fillRect(0, 0, w * S, h * S);
    }
    // край карты
    g.strokeStyle = '#7a5a2e'; g.lineWidth = 4; g.strokeRect(2, 2, w * S - 4, h * S - 4);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, h), toonMaterial({ map: tex }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(w / 2, 0, h / 2);
    this.group.add(floor);
    // земля вокруг карты
    const out = new THREE.Mesh(new THREE.PlaneGeometry(w + 80, h + 80), toonMaterial({ color: 0x3f8a3a }));
    out.rotation.x = -Math.PI / 2;
    out.position.set(w / 2, -0.02, h / 2);
    this.group.add(out);
    // бортик
    const kl = this.map.theme === 'koeln';
    const rimGeo = paintTopSide(new THREE.BoxGeometry(1, 0.35, 1), kl ? '#8d877d' : '#8a6b3e', kl ? '#6b665e' : '#6b4f2a');
    const rimCount = 2 * (w + 2) + 2 * h;
    const rim = new THREE.InstancedMesh(rimGeo, toonMaterial({ vertexColors: true }), rimCount);
    let k = 0;
    for (let x = -1; x <= w; x++) {
      rim.setMatrixAt(k++, tmpM.makeTranslation(x + 0.5, 0.17, -0.5));
      rim.setMatrixAt(k++, tmpM.makeTranslation(x + 0.5, 0.17, h + 0.5));
    }
    for (let y = 0; y < h; y++) {
      rim.setMatrixAt(k++, tmpM.makeTranslation(-0.5, 0.17, y + 0.5));
      rim.setMatrixAt(k++, tmpM.makeTranslation(w + 0.5, 0.17, y + 0.5));
    }
    this.group.add(rim, instancedOutline(rim));
  }

  /** Стены трёх видов (камень, бочки, забор): вид выбирается на весь связный кусок стены. Плюс мягкие тени на пол. */
  private buildWalls() {
    const { w, h, tiles } = this.map;
    const list: number[] = [];
    tiles.forEach((t, i) => { if (t === Tile.Wall) list.push(i); });
    // связные группы стен
    const group = new Map<number, number>();
    for (const ti of list) {
      if (group.has(ti)) continue;
      const stack = [ti];
      group.set(ti, ti);
      while (stack.length) {
        const cur = stack.pop()!;
        const cx = cur % w, cy = Math.floor(cur / w);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (tiles[ni] === Tile.Wall && !group.has(ni)) { group.set(ni, ti); stack.push(ni); }
        }
      }
    }
    const variantOf = (ti: number) => {
      const root = group.get(ti)!;
      // симметричная карта: вид зависит от размера и положения группы относительно центра
      const rx = Math.abs((root % w) + 0.5 - w / 2), ry = Math.abs(Math.floor(root / w) + 0.5 - h / 2);
      return Math.floor(rnd(Math.round(Math.min(rx, ry) * 7 + Math.max(rx, ry) * 13)) * 3);
    };
    // Кёльн: стены — цветные дома старого города (корпус красится, крыша и окна — нет)
    const koeln = this.map.theme === 'koeln';
    const geos = koeln ? [houseBody(), houseDetail()] : [wallGeometry(), barrelGeometry(), fenceGeometry()];
    const per: number[][] = koeln ? [list, list] : [[], [], []];
    if (!koeln) for (const ti of list) per[variantOf(ti)].push(ti);
    this.wallMeshes = per.map((tis, v) => {
      const mesh = new THREE.InstancedMesh(geos[v], toonMaterial({ vertexColors: true }), Math.max(1, tis.length));
      mesh.count = tis.length;
      const index = new Map<number, number>();
      tis.forEach((ti, k) => {
        const x = ti % w, y = Math.floor(ti / w);
        // забор вдоль линии стены
        const horiz = tiles[ti - 1] === Tile.Wall || tiles[ti + 1] === Tile.Wall;
        if (koeln) {
          tmpQ.setFromAxisAngle(UP, horiz ? 0 : Math.PI / 2);
          tmpP.set(x + 0.5, 0, y + 0.5);
          tmpS.set(1, 0.85 + rnd(ti) * 0.45, 1);
          mesh.setMatrixAt(k, tmpM.compose(tmpP, tmpQ, tmpS));
          mesh.setColorAt(k, v === 0 ? new THREE.Color(FACADES[Math.floor(rnd(ti + 3) * FACADES.length)]) : new THREE.Color(1, 1, 1));
        } else {
          tmpQ.setFromAxisAngle(UP, v === 2 && !horiz ? Math.PI / 2 : v === 1 ? rnd(ti) * 6.28 : 0);
          tmpP.set(x + 0.5, 0, y + 0.5);
          tmpS.set(1, v === 0 ? 0.92 + rnd(ti) * 0.16 : 1, 1);
          mesh.setMatrixAt(k, tmpM.compose(tmpP, tmpQ, tmpS));
          const s = 0.9 + rnd(ti + 7) * 0.15;
          mesh.setColorAt(k, new THREE.Color(s, s, s));
        }
        index.set(ti, k);
      });
      const o = instancedOutline(mesh);
      o.count = tis.length;
      this.group.add(mesh, o);
      return { mesh, index };
    });
    // тени: тёмные пятна со сдвигом от солнца
    const sc = document.createElement('canvas');
    sc.width = sc.height = 64;
    const sg = sc.getContext('2d')!;
    const gr = sg.createRadialGradient(32, 32, 10, 32, 32, 32);
    gr.addColorStop(0, 'rgba(40,20,60,0.42)');
    gr.addColorStop(1, 'rgba(40,20,60,0)');
    sg.fillStyle = gr; sg.fillRect(0, 0, 64, 64);
    const shadowGeo = new THREE.PlaneGeometry(1.7, 1.7).rotateX(-Math.PI / 2);
    this.wallShadows = new THREE.InstancedMesh(shadowGeo, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }), Math.max(1, list.length));
    this.wallShadows.count = list.length;
    list.forEach((ti, k) => {
      this.wallShadows.setMatrixAt(k, tmpM.makeTranslation(ti % w + 0.5 + 0.35, 0.01, Math.floor(ti / w) + 0.5 + 0.3));
      this.shadowIndex.set(ti, k);
    });
    this.wallShadows.renderOrder = 0;
    this.group.add(this.wallShadows);
  }
  private buildBushes() {
    const { w, tiles } = this.map;
    const parts: THREE.BufferGeometry[] = [];
    const blobs: [number, number, number, number, string][] = [
      [0, 0.38, 0, 0.42, '#3fae4a'], [0.22, 0.3, 0.12, 0.3, '#4cc457'], [-0.2, 0.3, -0.1, 0.32, '#37a043'], [0.05, 0.62, -0.05, 0.28, '#5fd86a'],
    ];
    for (const [x, y, z, r, c] of blobs) {
      const g = new THREE.IcosahedronGeometry(r, 1);
      g.translate(x, y, z);
      parts.push(paint(g.toNonIndexed(), c));
    }
    const geo = mergeGeometries(parts)!;
    geo.computeVertexNormals();
    const list: number[] = [];
    tiles.forEach((t, i) => { if (t === Tile.Bush) list.push(i); });
    this.bushes = new THREE.InstancedMesh(geo, toonMaterial({ vertexColors: true }), Math.max(1, list.length));
    this.bushes.count = list.length;
    list.forEach((ti, k) => {
      const x = ti % w + 0.5, y = Math.floor(ti / w) + 0.5;
      this.bushIndex.push({ ti, x, y, s: 1.05 + rnd(ti) * 0.2, rot: rnd(ti + 3) * Math.PI * 2 });
      this.setBush(k, 1);
    });
    const o = instancedOutline(this.bushes);
    o.count = list.length;
    this.group.add(this.bushes, o);
  }

  private setBush(k: number, squash: number) {
    const b = this.bushIndex[k];
    tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rot);
    tmpS.set(b.s, b.s * squash, b.s);
    tmpP.set(b.x, 0, b.y);
    this.bushes.setMatrixAt(k, tmpM.compose(tmpP, tmpQ, tmpS));
  }

  /** Кусты рядом со своим игроком приплюснуты, чтобы его было видно. */
  updateBushesNear(px: number, py: number) {
    const key = `${Math.round(px * 2)},${Math.round(py * 2)}`;
    if (key === this.bushNearKey) return;
    this.bushNearKey = key;
    this.bushIndex.forEach((b, k) => {
      const d = Math.hypot(b.x - px, b.y - py);
      this.setBush(k, d < 1.6 ? 0.35 : d < 2.3 ? 0.7 : 1);
    });
    this.bushes.instanceMatrix.needsUpdate = true;
  }

  private buildBoxes() {
    const { w, tiles } = this.map;
    const parts = [
      paintTopSide(new THREE.BoxGeometry(0.86, 0.8, 0.86).translate(0, 0.4, 0).toNonIndexed(), '#d39a4f', '#b57a35'),
      paint(new THREE.BoxGeometry(0.92, 0.1, 0.92).translate(0, 0.76, 0).toNonIndexed(), '#7a4a1f'),
      paint(new THREE.BoxGeometry(0.92, 0.1, 0.92).translate(0, 0.05, 0).toNonIndexed(), '#7a4a1f'),
      paint(new THREE.BoxGeometry(0.1, 0.8, 0.92).translate(0.41, 0.4, 0).toNonIndexed(), '#8a5524'),
      paint(new THREE.BoxGeometry(0.1, 0.8, 0.92).translate(-0.41, 0.4, 0).toNonIndexed(), '#8a5524'),
      // значок сверху — маленькая банка
      paint(new THREE.CylinderGeometry(0.12, 0.12, 0.26, 12).translate(0, 0.94, 0).toNonIndexed(), '#36e07a'),
      paint(new THREE.CylinderGeometry(0.125, 0.125, 0.07, 12).translate(0, 0.93, 0).toNonIndexed(), '#1b1b1b'),
      paint(new THREE.CylinderGeometry(0.1, 0.12, 0.04, 12).translate(0, 1.09, 0).toNonIndexed(), '#d8d8d8'),
    ];
    const geo = mergeGeometries(parts)!;
    const list: number[] = [];
    tiles.forEach((t, i) => { if (t === Tile.Box) list.push(i); });
    this.boxes = new THREE.InstancedMesh(geo, toonMaterial({ vertexColors: true }), Math.max(1, list.length));
    this.boxes.count = list.length;
    list.forEach((ti, k) => {
      const x = ti % w + 0.5, y = Math.floor(ti / w) + 0.5;
      this.boxes.setMatrixAt(k, tmpM.makeTranslation(x, 0, y));
      this.boxes.setColorAt(k, new THREE.Color(1, 1, 1));
      this.boxIndex.set(ti, k);
    });
    const o = instancedOutline(this.boxes);
    o.count = list.length;
    this.group.add(this.boxes, o);
  }

  private buildWater() {
    const { w, h, tiles } = this.map;
    if (!tiles.some((t) => t === Tile.Water)) return;
    // маска воды с размытием: по ней шейдер рисует пену у берега
    const S = 6, W = w * S, H = h * S;
    let a = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = tiles[Math.floor(y / S) * w + Math.floor(x / S)] === Tile.Water ? 1 : 0;
    const blur = (src: Float32Array, dx: number, dy: number) => {
      const out = new Float32Array(W * H), R = 3;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let k = -R; k <= R; k++) {
          const xx = x + dx * k, yy = y + dy * k;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          s += src[yy * W + xx]; n++;
        }
        out[y * W + x] = s / n;
      }
      return out;
    };
    a = blur(blur(a, 1, 0), 0, 1);
    const bytes = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { const v = Math.round(a[i] * 255); bytes[i * 4] = v; bytes[i * 4 + 3] = 255; }
    const mask = new THREE.DataTexture(bytes, W, H, THREE.RGBAFormat);
    mask.magFilter = THREE.LinearFilter; mask.minFilter = THREE.LinearFilter;
    mask.needsUpdate = true;
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, mask: { value: mask }, size: { value: new THREE.Vector2(w, h) } },
      transparent: true,
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`,
      fragmentShader: `varying vec3 vW; uniform float time; uniform sampler2D mask; uniform vec2 size;
        void main(){
          float m = texture2D(mask, vW.xz / size).r;
          if (m < 0.42) discard;
          float shore = 1.0 - smoothstep(0.42, 0.9, m);
          float w1 = sin(vW.x*1.7 + time*1.3 + sin(vW.z*1.1 + time)*1.5);
          float w2 = sin(vW.z*2.3 - time*1.1 + sin(vW.x*0.8 + time*0.7)*2.0);
          float caus = smoothstep(1.15, 1.8, w1 + w2);
          vec3 deep = vec3(0.07, 0.36, 0.78), light = vec3(0.2, 0.62, 0.97);
          vec3 c = mix(light, deep, smoothstep(0.6, 1.0, m));
          c = mix(c, vec3(0.7, 0.92, 1.0), caus * 0.55);
          float foam = step(0.55, shore + 0.18 * sin(time * 2.2 + (vW.x - vW.z) * 4.0));
          c = mix(c, vec3(0.97, 1.0, 1.0), foam);
          float spark = step(0.995, fract(sin(dot(floor(vW.xz * 6.0), vec2(12.9898, 78.233))) * 43758.5453 + time * 0.3));
          c += spark * 0.5;
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const g = new THREE.PlaneGeometry(w, h).rotateX(-Math.PI / 2).translate(w / 2, 0.015, h / 2);
    this.water = new THREE.Mesh(g, this.waterMat);
    this.water.renderOrder = 1;
    this.group.add(this.water);
  }
  removeTile(ti: number) {
    for (const wm of this.wallMeshes) {
      const wk = wm.index.get(ti);
      if (wk === undefined) continue;
      wm.mesh.setMatrixAt(wk, HIDDEN);
      wm.mesh.instanceMatrix.needsUpdate = true;
      wm.index.delete(ti);
    }
    const sk = this.shadowIndex.get(ti);
    if (sk !== undefined) {
      this.wallShadows.setMatrixAt(sk, HIDDEN);
      this.wallShadows.instanceMatrix.needsUpdate = true;
      this.shadowIndex.delete(ti);
    }
    const bk = this.boxIndex.get(ti);
    if (bk !== undefined) {
      this.boxes.setMatrixAt(bk, HIDDEN);
      this.boxes.instanceMatrix.needsUpdate = true;
      this.boxIndex.delete(ti);
    }
  }

  hitBox(ti: number, now: number) {
    const k = this.boxIndex.get(ti);
    if (k === undefined) return;
    this.boxFlash.set(k, now + 100);
    this.boxes.setColorAt(k, new THREE.Color(2.2, 2.2, 2.2));
    this.boxes.instanceColor!.needsUpdate = true;
  }

  /** Кёльнский собор по прямоугольнику клеток D: две западные башни со шпилями, неф с контрфорсами, апсида. */
  private buildCathedral() {
    const { w, tiles } = this.map;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    tiles.forEach((t, i) => {
      if (t !== Tile.Solid) return;
      const x = i % w, y = Math.floor(i / w);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
    });
    if (!Number.isFinite(x0)) return;
    const stone = new THREE.Color('#6b6157'), dark = new THREE.Color('#4b443e'), roof = new THREE.Color('#5d5a66'), glass = new THREE.Color('#2c3e66');
    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, c: THREE.Color, top?: THREE.Color) => parts.push(colorize(g.toNonIndexed(), (yy, ny) => (top && ny > 0.5 ? top : c.clone().lerp(dark, Math.max(0, 0.6 - yy / 8)))));
    const cz = (y0 + y1) / 2;
    const towerW = 4;
    // башни-близнецы
    for (const tz of [y0 + 1.9, y1 - 1.9]) {
      const tx = x0 + towerW / 2;
      add(new THREE.BoxGeometry(towerW - 0.3, 6, 3.4).translate(tx, 3, tz), stone);
      add(new THREE.BoxGeometry(towerW - 0.9, 1.6, 2.8).translate(tx, 6.8, tz), stone);
      add(new THREE.ConeGeometry(1.7, 4.2, 4).rotateY(Math.PI / 4).translate(tx, 9.7, tz), stone);
      add(new THREE.ConeGeometry(0.22, 0.9, 4).translate(tx, 12.2, tz), dark);
      for (const [px, pz] of [[-1.6, -1.4], [1.6, -1.4], [-1.6, 1.4], [1.6, 1.4]]) add(new THREE.ConeGeometry(0.22, 1.4, 4).translate(tx + px, 6.7, tz + pz), dark);
      for (const wy of [1.6, 3.6]) add(new THREE.BoxGeometry(0.5, 1.4, 3.45).translate(tx, wy, tz), glass);
    }
    // неф и крыша
    const nx0 = x0 + towerW - 0.2, nx1 = x1 - 1.6;
    const nLen = nx1 - nx0, nDepth = Math.min(5.4, y1 - y0 - 1.4);
    add(new THREE.BoxGeometry(nLen, 3.4, nDepth).translate((nx0 + nx1) / 2, 1.7, cz), stone);
    add(new THREE.CylinderGeometry(nDepth * 0.58, nDepth * 0.58, nLen, 3).rotateZ(Math.PI / 2).rotateX(Math.PI / 6).scale(1, 0.7, 1).translate((nx0 + nx1) / 2, 3.4 + nDepth * 0.2, cz), roof);
    // контрфорсы с пинаклями и окна
    for (let x = nx0 + 0.8; x < nx1 - 0.3; x += 1.5) {
      for (const s of [-1, 1]) {
        add(new THREE.BoxGeometry(0.35, 3.0, 0.7).translate(x, 1.5, cz + s * (nDepth / 2 + 0.3)), stone);
        add(new THREE.ConeGeometry(0.16, 0.9, 4).translate(x, 3.4, cz + s * (nDepth / 2 + 0.3)), dark);
        add(new THREE.BoxGeometry(0.5, 1.8, 0.06).translate(x + 0.75, 1.9, cz + s * (nDepth / 2 + 0.01)), glass);
      }
    }
    // апсида и башенка над средокрестием
    add(new THREE.CylinderGeometry(nDepth / 2, nDepth / 2, 3.2, 10, 1, false, 0, Math.PI).translate(nx1, 1.6, cz), stone);
    add(new THREE.ConeGeometry(0.4, 2.4, 6).translate((nx0 + nx1) / 2 + 1, 5.6, cz), dark);
    // по высоте сжимаем: вид сверху, собор не должен закрывать пол-экрана
    const geo = mergeGeometries(parts)!.scale(1, 0.55, 1);
    geo.computeVertexNormals();
    this.cathedralMat = toonMaterial({ vertexColors: true, transparent: true });
    const mesh = new THREE.Mesh(geo, this.cathedralMat);
    addOutline(mesh);
    this.cathedral = { mesh, x0, y0, x1, y1 };
    this.group.add(mesh);
  }

  /** Собор полупрозрачный, когда за ним (дальше от камеры) стоит свой игрок. */
  fadeOcclusion(px: number, py: number) {
    const c = this.cathedral;
    if (!c) return;
    const behind = px > c.x0 - 1 && px < c.x1 + 1 && py > c.y0 - 5 && py < c.y1;
    const target = behind ? 0.3 : 1;
    this.cathedralMat.opacity += (target - this.cathedralMat.opacity) * 0.15;
    this.cathedralMat.depthWrite = this.cathedralMat.opacity > 0.95;
    const o = c.mesh.children[0];
    if (o) o.visible = this.cathedralMat.opacity > 0.6;
  }

  update(now: number) {
    if (this.waterMat) this.waterMat.uniforms.time.value = now / 1000;
    for (const [k, until] of this.boxFlash) {
      if (now > until) {
        this.boxes.setColorAt(k, new THREE.Color(1, 1, 1));
        this.boxes.instanceColor!.needsUpdate = true;
        this.boxFlash.delete(k);
      }
    }
  }
}

/** Банка (подбираемый бонус). */
export function makeCanMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(paint(new THREE.CylinderGeometry(0.16, 0.16, 0.42, 12), '#36e07a'), toonMaterial({ vertexColors: true, emissive: 0x0a5a22 }));
  const band = new THREE.Mesh(paint(new THREE.CylinderGeometry(0.165, 0.165, 0.12, 12), '#1b1b1b'), toonMaterial({ vertexColors: true }));
  const top = new THREE.Mesh(paint(new THREE.CylinderGeometry(0.13, 0.16, 0.05, 12).translate(0, 0.235, 0), '#d8d8d8'), toonMaterial({ vertexColors: true }));
  addOutline(body);
  g.add(body, band, top);
  return g;
}
