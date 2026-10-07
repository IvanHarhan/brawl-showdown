import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GameMap, Tile } from '../../../shared/map';
import { toonMaterial, instancedOutline, paint, paintTopSide, addOutline } from './toon';

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();

function rnd(i: number) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

/** Пол, стены, кусты, вода, ящики. Повторяющееся — через InstancedMesh. */
export class MapView {
  group = new THREE.Group();
  walls!: THREE.InstancedMesh;
  wallIndex = new Map<number, number>();
  bushes!: THREE.InstancedMesh;
  bushIndex: { ti: number; x: number; y: number; s: number; rot: number }[] = [];
  boxes!: THREE.InstancedMesh;
  boxIndex = new Map<number, number>();
  boxFlash = new Map<number, number>();
  water: THREE.Mesh | null = null;
  waterMat!: THREE.ShaderMaterial;
  private bushNearKey = '';

  constructor(public map: GameMap) {
    this.buildFloor();
    this.buildWalls();
    this.buildBushes();
    this.buildBoxes();
    this.buildWater();
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
        g.fillStyle = t === Tile.Water ? '#2a5a8a' : odd ? '#e6c98a' : '#dcbd7c';
        g.fillRect(x * S, y * S, S, S);
        if (t !== Tile.Water && rnd(x * 31 + y * 17) > 0.86) {
          g.fillStyle = '#c9a866';
          g.fillRect(x * S + 4 + rnd(x + y) * 6, y * S + 5 + rnd(x * y) * 6, 3, 2);
        }
      }
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
    const rimGeo = paintTopSide(new THREE.BoxGeometry(1, 0.35, 1), '#8a6b3e', '#6b4f2a');
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

  private buildWalls() {
    const { w, tiles } = this.map;
    const list: number[] = [];
    tiles.forEach((t, i) => { if (t === Tile.Wall) list.push(i); });
    const geo = paintTopSide(new THREE.BoxGeometry(1, 1.15, 1), '#b98cf0', '#7a56b8');
    const mat = toonMaterial({ vertexColors: true });
    this.walls = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
    this.walls.count = list.length;
    list.forEach((ti, k) => {
      const x = ti % w, y = Math.floor(ti / w);
      this.walls.setMatrixAt(k, tmpM.makeTranslation(x + 0.5, 0.575, y + 0.5));
      const v = 0.88 + rnd(ti) * 0.18;
      this.walls.setColorAt(k, new THREE.Color(v, v, v));
      this.wallIndex.set(ti, k);
    });
    const o = instancedOutline(this.walls);
    o.count = list.length;
    this.group.add(this.walls, o);
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
      // значок банки сверху
      paint(new THREE.CylinderGeometry(0.13, 0.13, 0.06, 10).translate(0, 0.83, 0).toNonIndexed(), '#36e07a'),
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
    const { w, tiles } = this.map;
    const parts: THREE.BufferGeometry[] = [];
    tiles.forEach((t, i) => {
      if (t !== Tile.Water) return;
      const g = new THREE.PlaneGeometry(1, 1);
      g.rotateX(-Math.PI / 2);
      g.translate(i % w + 0.5, -0.08, Math.floor(i / w) + 0.5);
      parts.push(g);
    });
    if (!parts.length) return;
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 } },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`,
      fragmentShader: `varying vec3 vW; uniform float time;
        void main(){
          float s = sin(vW.x*2.3+time*1.6)+sin(vW.z*2.9-time*1.2)+sin((vW.x+vW.z)*1.7+time);
          vec3 c = mix(vec3(0.16,0.55,0.9), vec3(0.3,0.75,1.0), step(1.2, s));
          c = mix(c, vec3(0.85,0.95,1.0), step(2.4, s));
          gl_FragColor = vec4(c,1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.water = new THREE.Mesh(mergeGeometries(parts)!, this.waterMat);
    this.group.add(this.water);
  }

  removeTile(ti: number) {
    const wk = this.wallIndex.get(ti);
    if (wk !== undefined) {
      this.walls.setMatrixAt(wk, HIDDEN);
      this.walls.instanceMatrix.needsUpdate = true;
      this.wallIndex.delete(ti);
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
