import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { BRAWLERS } from '../../../shared/brawlers';
import { toonMaterial, outlineMaterial, outlineGeometry } from './toon';
import { attachDecal } from './decals';

const loader = new GLTFLoader();
const cache = new Map<string, Promise<GLTF | null>>();
const outlineGeoCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

export function loadModel(id: string) {
  let p = cache.get(id);
  if (!p) {
    p = loader.loadAsync(`/models/${id}.glb`).catch((e) => { console.warn('model', id, e); return null; });
    cache.set(id, p);
  }
  return p;
}

export function preloadAll() { return Promise.all(BRAWLERS.map((b) => loadModel(b.id))); }

type AnimName = 'idle' | 'run' | 'attack' | 'super' | 'death';

/** Один боец на сцене: модель, обводка, анимации, тень. */
export class CharacterView {
  root = new THREE.Group();
  model: THREE.Object3D | null = null;
  mats: THREE.MeshToonMaterial[] = [];
  outlines: THREE.Mesh[] = [];
  mixer: THREE.AnimationMixer | null = null;
  actions: Partial<Record<AnimName, THREE.AnimationAction>> = {};
  current: AnimName | '' = '';
  private oneShotUntil = 0;
  private flashUntil = 0;
  runScale = 0.8;
  private lean = 0;
  private kick = 0;
  private hop = 0;
  opacity = 1;
  shadow: THREE.Mesh;
  ready: Promise<void>;

  constructor(public brawlerId: string, shadowMat: THREE.Material) {
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 18), shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;
    this.root.add(this.shadow);
    this.ready = loadModel(brawlerId).then((g) => { if (g) this.setup(g); });
  }

  private setup(g: GLTF) {
    const model = SkeletonUtils.clone(g.scene);
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isMesh) return;
      const mat = toonMaterial({ vertexColors: true, transparent: true });
      m.material = mat;
      this.mats.push(mat);
      m.frustumCulled = false;
      if (m.isSkinnedMesh) {
        let og = outlineGeoCache.get(m.geometry);
        if (!og) { og = outlineGeometry(m.geometry); outlineGeoCache.set(m.geometry, og); }
        const o2 = new THREE.SkinnedMesh(og, outlineMaterial());
        o2.bind(m.skeleton, m.bindMatrix);
        o2.frustumCulled = false;
        m.parent!.add(o2);
        this.outlines.push(o2);
      }
    });
    attachDecal(this.brawlerId, model);
    this.model = model;
    this.root.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of g.animations) {
      const a = this.mixer.clipAction(clip);
      const n = clip.name as AnimName;
      if (n === 'attack' || n === 'super' || n === 'death') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.actions[n] = a;
    }
    this.play('idle');
  }

  play(name: AnimName, fade = 0.12) {
    if (this.current === name) return;
    const next = this.actions[name];
    if (!next) return;
    const prev = this.current ? this.actions[this.current] : null;
    next.reset().play();
    if (prev) prev.crossFadeTo(next, fade, false);
    this.current = name;
  }

  /** Короткая анимация поверх ходьбы (атака, супер). */
  oneShot(name: 'attack' | 'super', now: number) {
    const a = this.actions[name];
    if (!a) return;
    this.current = '';
    this.play(name, 0.05);
    this.oneShotUntil = now + a.getClip().duration * 1000 * 0.9;
    if (name === 'attack') this.kick = 1; else this.hop = 1;
  }

  flash(now: number) { this.flashUntil = now + 50; }

  update(dt: number, now: number, moving: boolean, dead: boolean) {
    if (dead) this.play('death', 0.1);
    else if (now > this.oneShotUntil) this.play(moving ? 'run' : 'idle', 0.15);
    // скорость шагов под реальную скорость бойца, чтобы ноги не «буксовали»
    if (moving && !dead) this.actions.run?.setEffectiveTimeScale(this.runScale);
    this.mixer?.update(dt);
    // процедурная добавка: наклон в беге, отдача при атаке, подскок на супере
    if (this.model && !dead) {
      this.lean += ((moving ? 0.16 : 0) - this.lean) * Math.min(1, dt * 10);
      this.kick = Math.max(0, this.kick - dt * 6);
      this.hop = Math.max(0, this.hop - dt * 2.2);
      this.model.rotation.x = this.lean - this.kick * 0.25;
      this.model.position.z = -this.kick * 0.12;
      this.model.position.y = Math.sin(this.hop * Math.PI) * 0.35;
      const sq = 1 + this.kick * 0.08;
      this.model.scale.set(sq, 1 / sq, sq);
    }
    const fl = now < this.flashUntil;
    for (const m of this.mats) {
      m.emissive.setRGB(fl ? 0.9 : 0, fl ? 0.9 : 0, fl ? 0.9 : 0);
      m.opacity = this.opacity;
      m.depthWrite = this.opacity > 0.95;
    }
    for (const o of this.outlines) o.visible = this.opacity > 0.6;
    this.shadow.visible = this.opacity > 0.3;
  }

  dispose() {
    this.root.removeFromParent();
    for (const m of this.mats) m.dispose();
  }
}
