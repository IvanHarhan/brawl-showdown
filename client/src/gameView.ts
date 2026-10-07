import * as THREE from 'three';
import type { Room } from '@colyseus/sdk';
import { ClientWorld, PView } from './world';
import { MapView, makeCanMesh } from './render/mapView';
import { CharacterView } from './render/characters';
import { ProjectileViews, Fx, GasView, AimView, makeBlobShadowMat, makeMinionMesh } from './render/effects';
import { Input, AimKind } from './input';
import { Audio } from './audio';
import { getBrawler, superAimType, superRange, Brawler } from '../../shared/brawlers';
import { F_ALIVE, F_BUSH, F_INVIS, F_OFFLINE, F_AIR, GameEvent, StartMsg, Snapshot } from '../../shared/protocol';
import { Tile, lineOfFire, tileAt } from '../../shared/map';
import { TICK_DT } from '../../shared/constants';

const TILT = (55 * Math.PI) / 180;

interface Tag { el: HTMLElement; hpf: HTMLElement; hpt: HTMLElement; cans: HTMLElement; ammo: HTMLElement | null; last: string }

export interface GameCallbacks {
  onMyDeath(place: number): void;
}

export class GameView {
  scene = new THREE.Scene();
  world: ClientWorld;
  mapView: MapView;
  chars = new Map<number, CharacterView>();
  proj = new ProjectileViews();
  fx = new Fx();
  gas: GasView;
  aimView = new AimView();
  minionMeshes = new Map<number, THREE.Object3D>();
  canMeshes = new Map<number, THREE.Object3D>();
  tags = new Map<number, Tag>();
  minionTags = new Map<number, Tag>();
  hud: HTMLElement;
  tagLayer: HTMLElement;
  private sendAcc = 0;
  private shake = 0;
  private camTarget = new THREE.Vector3();
  private spectate = -1;
  private lastLocalShot = 0;
  private pingAt = 0;
  ping = 0;
  dead = false;
  myPlace = 0;
  private shadowMat = makeBlobShadowMat();
  private v3 = new THREE.Vector3();
  private dmgLayer: HTMLElement;
  autoplay = new URLSearchParams(location.search).has('autoplay');
  private auto = { nextThink: 0, mx: 0, my: 0, stuck: 0, lx: 0, ly: 0, turn: 1 };
  stats = { frames: 0, snaps: 0, maxJump: 0, jumps: [] as number[] };
  history = new Map<number, number[][]>();
  private lastRender = { x: 0, y: 0, has: false };

  constructor(start: StartMsg, public room: Room, public camera: THREE.PerspectiveCamera, public input: Input, public audio: Audio,
    uiRoot: HTMLElement, private cb: GameCallbacks) {
    this.world = new ClientWorld(start);
    const { map } = this.world;
    this.scene.background = new THREE.Color(0x3f8a3a);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a5a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-4, 10, 6);
    this.scene.add(sun);

    this.mapView = new MapView(map);
    this.gas = new GasView(map.w, map.h);
    this.scene.add(this.mapView.group, this.proj.group, this.fx.group, this.gas.group, this.aimView.group);

    for (const r of this.world.roster) {
      const cv = new CharacterView(r.brawler, this.shadowMat);
      this.chars.set(r.slot, cv);
      this.scene.add(cv.root);
      cv.root.visible = false;
    }

    this.hud = document.createElement('div');
    this.hud.id = 'hud';
    this.hud.innerHTML = `
      <div id="tags"></div><div id="dmgs"></div><div id="feed"></div>
      <div class="top"><span class="pill" id="aliveP">👤 10</span><span class="pill" id="gasP"></span></div>
      <div class="ping" id="ping"></div>
      <div class="zone" id="moveZone"></div>
      <div class="zone" id="supZone"><span>СУПЕР</span></div>
      <div class="zone" id="atkZone"></div>
      <div class="stick hidden" id="moveStick"><div class="knob"></div></div>
      <div class="stick hidden" id="aimStick"><div class="knob"></div></div>
      <div class="pchint"><b>WASD</b> — ходить · <b>мышь</b> — прицел · <b>ЛКМ</b> — стрелять · <b>ПКМ / Пробел</b> — супер</div>`;
    uiRoot.appendChild(this.hud);
    this.tagLayer = this.hud.querySelector('#tags') as HTMLElement;
    this.dmgLayer = this.hud.querySelector('#dmgs') as HTMLElement;
    input.mount(this.hud);
    input.enabled = true;
    audio.preloadVoice(this.world.me.id);

    const mp = this.world.map.spawns[0];
    this.camTarget.set(mp?.x ?? 20, 0, mp?.y ?? 20);
  }

  /** Повторный 'start' после переподключения: пересобрать мир, но оставить вид. */
  restart(start: StartMsg) {
    const old = this.world;
    this.world = new ClientWorld(start);
    this.world.seq = old.seq;
    this.mapView.group.removeFromParent();
    this.mapView = new MapView(this.world.map);
    this.scene.add(this.mapView.group);
  }

  onSnapshot(s: Snapshot) {
    this.world.onSnapshot(s, performance.now());
    this.stats.snaps++;
    // история для e2e-сравнения состояния между клиентами
    const h = this.history;
    h.set(s.t, s.p.map((p) => [p[0], p[1], p[2], p[3], p[5], p[8] & F_ALIVE]));
    if (h.size > 600) h.delete(h.keys().next().value!);
  }

  // ---------- стрельба ----------

  fire(kind: AimKind, screenAngle: number, mag: number, auto: boolean) {
    this.audio.unlock();
    const w = this.world;
    if (!w.alive || this.dead) return;
    const me = w.meLatest();
    if (!me) return;
    const b = w.me;
    const pos = w.myPos();
    let angle = screenAngle;
    let dist = 0;
    const sKind = kind === 'super' ? superAimType(b.super) : 'line';
    const range = kind === 'super' ? superRange(b.super) : b.attack.range;
    if (Number.isNaN(screenAngle)) {
      const m = this.mouseGround();
      if (m) { angle = Math.atan2(m.y - pos.y, m.x - pos.x); dist = Math.hypot(m.x - pos.x, m.y - pos.y); }
      else angle = w.myFacing;
    } else if (auto) {
      const t = this.autoTarget(range + 0.5);
      angle = t ? Math.atan2(t.y - pos.y, t.x - pos.x) : w.myFacing;
      dist = t ? Math.hypot(t.x - pos.x, t.y - pos.y) : range * 0.7;
    } else {
      dist = mag * range;
    }
    if (sKind === 'point') dist = Math.min(dist || range, range);
    this.flushInputs();
    if (kind === 'attack') {
      if (me[6] < 100) { this.audio.sfx('click', 0.6); return; }
      this.room.send('atk', { a: angle });
      this.localShotFx(angle, false);
    } else {
      if (me[7] < 100) return;
      this.room.send('sup', { a: angle, d: dist });
      this.localShotFx(angle, true);
    }
    w.myFacing = angle;
  }

  private localShotFx(angle: number, isSuper: boolean) {
    const now = performance.now();
    this.lastLocalShot = now;
    const cv = this.chars.get(this.world.you);
    cv?.oneShot(isSuper ? 'super' : 'attack', now);
    const p = this.world.myPos();
    const b = this.world.me;
    this.shotFx(p.x, p.y, angle, b, isSuper, 1, now);
    if (isSuper) { this.audio.voice(b.id, 'super', 1, true); this.shake = Math.max(this.shake, 0.35); this.audio.sfx('super'); }
    else if (Math.random() < 0.3) this.audio.voice(b.id, 'attack', 0.9);
  }

  private shotFx(x: number, y: number, angle: number, b: Brawler, isSuper: boolean, vol: number, now: number) {
    const a = isSuper && b.super.kind === 'burst' ? b.super : b.attack;
    const look = a.kind === 'burst' || a.kind === 'spread' || a.kind === 'bouncer' ? a.look : 'bullet';
    if (isSuper && b.super.kind !== 'burst') return;
    const fx = x + Math.cos(angle) * 0.55, fy = y + Math.sin(angle) * 0.55;
    if (look !== 'fist' && look !== 'sign') this.fx.flash(fx, 0.6, fy, 0xffe08a, 0.9, now);
    const snd = look === 'pellet' ? 'shotgun' : look === 'fist' ? 'punch' : look === 'sign' || look === 'shuriken' ? 'throw' : 'shot';
    this.audio.sfx(snd, vol);
  }

  private autoTarget(range: number) {
    const w = this.world, pos = w.myPos();
    let best: { x: number; y: number } | null = null, bd = range;
    for (const p of w.players(performance.now())) {
      if (p.slot === w.you || !(p.flags & F_ALIVE)) continue;
      const d = Math.hypot(p.x - pos.x, p.y - pos.y);
      if (d < bd) { bd = d; best = p; }
    }
    for (const m of w.minions(performance.now())) {
      if (m.owner === w.you) continue;
      const d = Math.hypot(m.x - pos.x, m.y - pos.y);
      if (d < bd) { bd = d; best = m; }
    }
    if (best) return best;
    for (const ti of w.boxes.keys()) {
      const bx = ti % w.map.w + 0.5, by = Math.floor(ti / w.map.w) + 0.5;
      const d = Math.hypot(bx - pos.x, by - pos.y);
      if (d < bd) { bd = d; best = { x: bx, y: by }; }
    }
    return best;
  }

  private mouseGround() {
    if (!this.input.mouse.has) return null;
    const ndc = new THREE.Vector2((this.input.mouse.x / innerWidth) * 2 - 1, -(this.input.mouse.y / innerHeight) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.3), hit)) return null;
    return { x: hit.x, y: hit.z };
  }

  private flushInputs() {
    const items = this.world.takeOutbox();
    if (items.length) this.room.send('in', items);
  }

  // ---------- события ----------

  private handleEvents(now: number) {
    const w = this.world;
    const me = w.myPos();
    const near = (x: number, y: number) => Math.max(0, 1 - Math.hypot(x - me.x, y - me.y) / 14);
    for (const e of w.dueEvents(now)) this.handleEvent(e, now, near);
  }

  private handleEvent(e: GameEvent, now: number, near: (x: number, y: number) => number) {
    const w = this.world;
    switch (e[0]) {
      case 'shot': {
        const [, slot, a100, sup] = e;
        if (slot === w.you && now - this.lastLocalShot < 1500) break;
        const cv = this.chars.get(slot);
        const pv = cv?.root.visible ? cv.root.position : null;
        cv?.oneShot(sup ? 'super' : 'attack', now);
        const r = w.rosterOf(slot);
        if (pv && r) this.shotFx(pv.x, pv.z, a100 / 100, getBrawler(r.brawler), !!sup, near(pv.x, pv.z) * 0.7, now);
        break;
      }
      case 'hit': {
        const [, x100, y100, dmg, target] = e;
        const x = x100 / 100, y = y100 / 100;
        const isMe = target === w.you;
        if (target >= 0) {
          this.chars.get(target)?.flash(now);
          this.fx.burst(x, 0.7, y, isMe ? 0xff4d4d : 0xffffff, 4, 2.5, 2);
          this.fx.hitMarker(x, y, now, !isMe);
          this.audio.sfx(isMe ? 'hitme' : 'hit', isMe ? 0.9 : near(x, y));
          if (isMe) this.shake = Math.max(this.shake, 0.12);
        }
        this.damageNumber(x, y, dmg, isMe ? 'hurt' : target >= 0 ? 'mine' : '');
        break;
      }
      case 'box': {
        const [, ti] = e;
        this.mapView.hitBox(ti, now);
        const x = ti % w.map.w + 0.5, y = Math.floor(ti / w.map.w) + 0.5;
        this.fx.burst(x, 0.6, y, 0xb57a35, 3, 2, 2);
        this.audio.sfx('box', near(x, y) * 0.8);
        break;
      }
      case 'tile': {
        const [, ti] = e;
        const x = ti % w.map.w + 0.5, y = Math.floor(ti / w.map.w) + 0.5;
        const wasBox = this.mapView.boxIndex.has(ti);
        this.mapView.removeTile(ti);
        this.fx.burst(x, 0.5, y, wasBox ? 0xb57a35 : 0x9a6fe0, 16, 4, 4);
        this.audio.sfx('boxbreak', near(x, y));
        break;
      }
      case 'die': {
        const [, slot, place, killer] = e;
        this.killFeed(slot, killer);
        const cv = this.chars.get(slot);
        if (cv) { const p = cv.root.position; this.fx.burst(p.x, 0.8, p.z, 0xffffff, 18, 4, 5); this.fx.ring(p.x, p.z, 1.6, 0xffffff); }
        const r = w.rosterOf(slot);
        if (slot === w.you) {
          this.dead = true;
          this.myPlace = place;
          if (r) this.audio.voice(r.brawler, 'death', 1, true);
          this.audio.sfx('lose');
          this.cb.onMyDeath(place);
        } else {
          this.audio.sfx('death', cv ? near(cv.root.position.x, cv.root.position.z) : 0.3);
          if (cv && r && near(cv.root.position.x, cv.root.position.z) > 0.4) this.audio.voice(r.brawler, 'death', 0.6);
        }
        break;
      }
      case 'can': {
        const [, slot] = e;
        const cv = this.chars.get(slot);
        if (cv) this.fx.burst(cv.root.position.x, 1, cv.root.position.z, 0x36e07a, 10, 2, 4);
        if (slot === w.you) this.audio.sfx('can');
        break;
      }
      case 'super': {
        const [, slot] = e;
        if (slot === w.you) break;
        const cv = this.chars.get(slot);
        cv?.oneShot('super', now);
        const r = w.rosterOf(slot);
        if (cv && cv.root.visible) {
          const n = near(cv.root.position.x, cv.root.position.z);
          if (r && n > 0.3) this.audio.voice(r.brawler, 'super', n, true);
          this.audio.sfx('super', n * 0.6);
          if (n > 0.5) this.shake = Math.max(this.shake, 0.2 * n);
        }
        break;
      }
      case 'boom': {
        const [, x100, y100, r100] = e;
        const x = x100 / 100, y = y100 / 100, r = r100 / 100;
        if (r > 0) {
          this.fx.ring(x, y, r, 0xffe08a);
          this.fx.burst(x, 0.3, y, 0xe6c98a, 14, 3.5, 3);
          this.audio.sfx('boom', near(x, y));
          const n = near(x, y);
          if (n > 0.6) this.shake = Math.max(this.shake, 0.3 * n);
        } else {
          this.fx.burst(x, 0.6, y, 0xffffff, 3, 1.5, 1.5);
        }
        break;
      }
      case 'gas': {
        if (e[1] === w.you) { this.audio.sfx('gas'); this.shake = Math.max(this.shake, 0.08); }
        break;
      }
    }
  }

  private killFeed(victim: number, killer: number) {
    const feed = this.hud.querySelector('#feed') as HTMLElement;
    const v = this.world.rosterOf(victim), k = killer >= 0 ? this.world.rosterOf(killer) : null;
    const row = document.createElement('div');
    row.className = 'kf' + (victim === this.world.you || killer === this.world.you ? ' me' : '');
    row.textContent = k ? `${k.name} 💥 ${v?.name ?? '?'}` : `☁ ${v?.name ?? '?'}`;
    feed.prepend(row);
    while (feed.children.length > 4) feed.lastElementChild!.remove();
    setTimeout(() => row.remove(), 5000);
  }

  private damageNumber(x: number, y: number, dmg: number, cls: string) {
    this.v3.set(x, 1.6, y).project(this.camera);
    if (this.v3.z > 1) return;
    const el = document.createElement('div');
    el.className = 'dmg ' + cls;
    el.textContent = String(dmg);
    el.style.transform = `translate(${(this.v3.x * 0.5 + 0.5) * innerWidth - 14 + (Math.random() * 16 - 8)}px, ${(-this.v3.y * 0.5 + 0.5) * innerHeight}px)`;
    this.dmgLayer.appendChild(el);
    setTimeout(() => el.remove(), 800);
  }

  // ---------- кадр ----------

  update(now: number, dt: number) {
    const w = this.world;
    // ввод и предсказание
    let [mx, my] = this.input.move();
    if (this.autoplay) [mx, my] = this.autopilot(now);
    w.predict(mx, my, dt, now);
    this.sendAcc += dt;
    if (this.sendAcc >= TICK_DT) { this.sendAcc = 0; this.flushInputs(); }
    if (now - this.pingAt > 2000) { this.pingAt = now; this.room.send('ping', now); }

    this.handleEvents(now);

    // игроки
    const views = w.players(now);
    const seen = new Set<number>();
    const meSnap = w.meLatest();
    for (const v of views) {
      seen.add(v.slot);
      if (v.slot === w.you) {
        const p = w.myPos();
        if (!w.locked) { v.x = p.x; v.y = p.y; v.moving = w.movingRecently(now); v.facing = w.myFacing; }
        if (meSnap) { v.ammo = meSnap[6] / 100; v.sup = meSnap[7] / 100; v.hp = meSnap[3]; v.maxHp = meSnap[4]; v.cans = meSnap[5]; }
      }
      this.updateChar(v, dt, now);
    }
    for (const [slot, cv] of this.chars) {
      if (!seen.has(slot)) { cv.root.visible = false; this.tags.get(slot)?.el.classList.add('hidden'); }
    }

    this.proj.sync(w.projectiles(now), now);
    this.updateMinions(now);
    this.updateCans(now);
    this.gas.update(w.gas(now), now);
    this.mapView.update(now);
    this.fx.update(dt, now);

    // камера
    const meV = views.find((v) => v.slot === w.you);
    let tx: number, ty: number;
    if (meV && !this.dead) { tx = meV.x; ty = meV.y; }
    else {
      const alive = views.filter((v) => v.flags & F_ALIVE);
      let t = alive.find((v) => v.slot === this.spectate);
      if (!t && alive.length) { t = alive[0]; this.spectate = t.slot; }
      tx = t ? t.x : this.camTarget.x; ty = t ? t.y : this.camTarget.z;
    }
    if (meV) this.mapView.updateBushesNear(meV.x, meV.y);
    const k = 1 - Math.exp(-dt * 12);
    this.camTarget.x += (tx - this.camTarget.x) * k;
    this.camTarget.z += (ty - this.camTarget.z) * k;
    this.placeCamera(dt);

    this.updateAim(now);
    this.updateHud(meSnap);
    this.hud.classList.toggle('dead', this.dead || !w.alive);

    // плавность своего движения (для теста с пингом)
    if (meV) {
      if (this.lastRender.has) {
        const jump = Math.hypot(meV.x - this.lastRender.x, meV.y - this.lastRender.y);
        const expected = w.me.speed * dt;
        const extra = Math.max(0, jump - expected);
        this.stats.jumps.push(extra);
        if (this.stats.jumps.length > 3000) this.stats.jumps.shift();
        this.stats.maxJump = Math.max(this.stats.maxJump, extra);
      }
      this.lastRender = { x: meV.x, y: meV.y, has: true };
    }
    this.stats.frames++;
  }

  private placeCamera(dt: number) {
    const aspect = innerWidth / innerHeight;
    const fovV = (this.camera.fov * Math.PI) / 180;
    const tanV = Math.tan(fovV / 2);
    // горизонтальный экран: ~17 клеток в ширину, не меньше ~9.5 в высоту
    const wantW = 17, wantH = 9.5;
    const dist = Math.max(wantW / (2 * tanV * aspect), wantH / (2 * tanV)) * 0.95;
    this.shake = Math.max(0, this.shake - dt * 1.2);
    const sx = (Math.random() - 0.5) * this.shake, sz = (Math.random() - 0.5) * this.shake;
    const target = new THREE.Vector3(this.camTarget.x + sx, 0, this.camTarget.z - 0.6 + sz);
    this.camera.position.set(target.x, Math.sin(TILT) * dist, target.z + Math.cos(TILT) * dist);
    this.camera.lookAt(target);
  }

  private updateChar(v: PView, dt: number, now: number) {
    const cv = this.chars.get(v.slot)!;
    const w = this.world;
    const alive = (v.flags & F_ALIVE) !== 0;
    cv.root.visible = true;
    cv.root.scale.setScalar(1.35);
    cv.root.position.set(v.x, (v.flags & F_AIR) ? 0.9 : 0, v.y);
    cv.root.rotation.y = Math.PI / 2 - v.facing;
    const isMe = v.slot === w.you;
    let op = 1;
    if (v.flags & F_INVIS) op = isMe ? 0.4 : 0.18 + 0.15 * Math.sin(now / 50);
    else if (isMe && (v.flags & F_BUSH)) op = 0.55;
    cv.opacity = op;
    cv.update(dt, now, v.moving, !alive);
    this.updateTag(v, alive, isMe);
  }

  private updateTag(v: PView, alive: boolean, isMe: boolean) {
    let t = this.tags.get(v.slot);
    if (!t) {
      const r = this.world.rosterOf(v.slot);
      const el = document.createElement('div');
      el.className = 'tag3d' + (isMe ? ' me' : '');
      el.innerHTML = `<div class="nm"></div><div class="hpb"><div class="hpf"></div><div class="hpt"></div></div>${isMe ? '<div class="ammo"><i><b></b></i><i><b></b></i><i><b></b></i></div>' : ''}<div class="cans">0</div>`;
      (el.querySelector('.nm') as HTMLElement).textContent = r ? r.name : '?';
      this.tagLayer.appendChild(el);
      t = { el, hpf: el.querySelector('.hpf')!, hpt: el.querySelector('.hpt')!, cans: el.querySelector('.cans')!, ammo: el.querySelector('.ammo'), last: '' };
      this.tags.set(v.slot, t);
    }
    if (!alive) { t.el.classList.add('hidden'); return; }
    this.v3.set(v.x, 2.3, v.y).project(this.camera);
    const sx = (this.v3.x * 0.5 + 0.5) * innerWidth, sy = (-this.v3.y * 0.5 + 0.5) * innerHeight;
    t.el.classList.toggle('hidden', this.v3.z > 1 || (v.flags & F_INVIS && !isMe && false) as boolean);
    t.el.style.transform = `translate(${sx - 31}px, ${sy - 40}px)`;
    t.el.style.opacity = v.flags & F_OFFLINE ? '0.5' : '1';
    const key = `${v.hp}|${v.maxHp}|${v.cans}|${isMe ? Math.round(v.ammo * 20) : 0}`;
    if (key !== t.last) {
      t.last = key;
      t.hpf.style.width = `${Math.max(0, Math.min(100, (v.hp / v.maxHp) * 100))}%`;
      t.hpt.textContent = String(Math.max(0, v.hp));
      t.cans.textContent = String(v.cans);
      t.cans.style.display = v.cans > 0 ? '' : 'none';
      if (t.ammo) {
        const bars = t.ammo.querySelectorAll('b');
        bars.forEach((b, i) => { (b as HTMLElement).style.width = `${Math.max(0, Math.min(1, v.ammo - i)) * 100}%`; });
      }
    }
  }

  private updateMinions(now: number) {
    const list = this.world.minions(now);
    const seen = new Set<number>();
    for (const m of list) {
      seen.add(m.id);
      let o = this.minionMeshes.get(m.id);
      if (!o) { o = makeMinionMesh(m.type); this.minionMeshes.set(m.id, o); this.scene.add(o); }
      o.position.set(m.x, m.type === 1 ? Math.abs(Math.sin(now / 90)) * 0.08 : 0, m.y);
      o.rotation.y = Math.PI / 2 - m.facing;
      let t = this.minionTags.get(m.id);
      if (!t) {
        const el = document.createElement('div');
        el.className = 'tag3d' + (m.owner === this.world.you ? ' me' : '');
        el.innerHTML = '<div class="hpb" style="width:40px;height:7px"><div class="hpf"></div></div>';
        this.tagLayer.appendChild(el);
        t = { el, hpf: el.querySelector('.hpf')!, hpt: el, cans: el, ammo: null, last: '' };
        this.minionTags.set(m.id, t);
      }
      this.v3.set(m.x, m.type === 0 ? 1.4 : 1.0, m.y).project(this.camera);
      t.el.style.transform = `translate(${(this.v3.x * 0.5 + 0.5) * innerWidth - 20}px, ${(-this.v3.y * 0.5 + 0.5) * innerHeight - 8}px)`;
      t.hpf.style.width = `${(m.hp / m.maxHp) * 100}%`;
    }
    for (const [id, o] of this.minionMeshes) {
      if (seen.has(id)) continue;
      this.fx.burst(o.position.x, 0.4, o.position.z, 0xffffff, 8, 2.5, 3);
      o.removeFromParent();
      this.minionMeshes.delete(id);
      this.minionTags.get(id)?.el.remove();
      this.minionTags.delete(id);
    }
  }

  private updateCans(now: number) {
    const seen = new Set<number>();
    for (const [id, x100, y100] of this.world.cans(now)) {
      seen.add(id);
      let o = this.canMeshes.get(id);
      if (!o) { o = makeCanMesh(); this.canMeshes.set(id, o); this.scene.add(o); }
      o.position.set(x100 / 100, 0.35 + Math.sin(now / 250 + id) * 0.08, y100 / 100);
      o.rotation.y = now / 600 + id;
    }
    for (const [id, o] of this.canMeshes) if (!seen.has(id)) { o.removeFromParent(); this.canMeshes.delete(id); }
  }

  private updateAim(now: number) {
    const w = this.world;
    const b = w.me;
    const pos = w.myPos();
    const a = this.input.aim;
    let kind: AimKind | null = null, angle = 0, mag = 1;
    if (this.input.isTouch) {
      if (a.active) { kind = a.kind; angle = Math.atan2(a.ay, a.ax); mag = a.mag; }
    } else if (this.input.mouse.has && !this.dead) {
      const m = this.mouseGround();
      if (m) {
        kind = this.input.keys.has('ShiftLeft') ? 'super' : 'attack';
        angle = Math.atan2(m.y - pos.y, m.x - pos.x);
        mag = Math.min(1, Math.hypot(m.x - pos.x, m.y - pos.y) / Math.max(1, superRange(b.super)));
      }
    }
    if (!kind || !w.alive) { this.aimView.hide(); return; }
    if (kind === 'attack') {
      const at = b.attack;
      if (at.kind === 'spread') this.aimView.show('spread', pos.x, pos.y, angle, at.range, 0, at.spreadDeg, 0, false);
      else this.aimView.show('line', pos.x, pos.y, angle, at.range, at.kind === 'burst' && at.range < 3 ? 0.9 : 0.35, 0, 0, false);
    } else {
      const s = b.super;
      const t = superAimType(s);
      if (t === 'point') this.aimView.show('point', pos.x, pos.y, angle, superRange(s), s.kind === 'jump' ? s.radius : 0.7, 0, mag * superRange(s), true);
      else if (t === 'line') this.aimView.show('line', pos.x, pos.y, angle, superRange(s), 0.6, 0, 0, true);
      else this.aimView.show('point', pos.x, pos.y, 0, 0, 1.2, 0, 0, true);
    }
  }

  private updateHud(me: ReturnType<ClientWorld['meLatest']>) {
    const info = this.world.info();
    const alive = this.hud.querySelector('#aliveP') as HTMLElement;
    alive.textContent = `👤 ${info.alive}`;
    const gasP = this.hud.querySelector('#gasP') as HTMLElement;
    const left = Math.ceil(this.world.gasStart - info.el);
    gasP.textContent = left > 0 ? `☁ газ через ${left}` : '☁ газ сжимается';
    gasP.classList.toggle('gaswarn', left <= 0);
    (this.hud.querySelector('#ping') as HTMLElement).textContent = this.ping ? `${Math.round(this.ping)} мс` : '';
    const sup = this.hud.querySelector('#supZone') as HTMLElement;
    const charge = me ? me[7] / 100 : 0;
    sup.classList.toggle('ready', charge >= 1);
    (sup.firstElementChild as HTMLElement).textContent = charge >= 1 ? 'СУПЕР!' : `${Math.floor(charge * 100)}%`;
    sup.style.background = charge >= 1 ? '' : `conic-gradient(#ffd23f ${charge * 360}deg, #444a 0)`;
  }

  // ---------- автопилот для тестов ----------

  private autopilot(now: number): [number, number] {
    const w = this.world;
    const A = this.auto;
    if (!w.alive || this.dead) return [0, 0];
    if (now < A.nextThink) return [A.mx, A.my];
    A.nextThink = now + 150;
    const pos = w.myPos();
    const c = w.map.w / 2;
    const gasHalf = w.gas(now);
    const b = w.me;
    const views = w.players(now).filter((v) => v.slot !== w.you && v.flags & F_ALIVE);
    let target: { x: number; y: number } | null = null, td = Infinity;
    for (const v of views) { const d = Math.hypot(v.x - pos.x, v.y - pos.y); if (d < td) { td = d; target = v; } }
    let gx = c, gy = c;
    const inDanger = Math.abs(pos.x - c) > gasHalf - 2.5 || Math.abs(pos.y - c) > gasHalf - 2.5;
    if (!inDanger && target && td < 9) { gx = target.x; gy = target.y; }
    else if (!inDanger) {
      const t = this.autoTarget(12);
      if (t) { gx = t.x; gy = t.y; td = Math.hypot(t.x - pos.x, t.y - pos.y); target = t; }
    }
    // атака
    const me = w.meLatest();
    const losTo = target && lineOfFire(w.map, pos.x, pos.y, target.x - (target.x - pos.x) / (td || 1) * 0.7, target.y - (target.y - pos.y) / (td || 1) * 0.7);
    if (target && td <= b.attack.range * 0.9 && me && me[6] >= 100 && losTo) {
      const a = Math.atan2(target.y - pos.y, target.x - pos.x);
      this.room.send('atk', { a });
      this.localShotFx(a, false);
      if (me[7] >= 100) { this.room.send('sup', { a, d: td }); this.localShotFx(a, true); }
    }
    let dx = gx - pos.x, dy = gy - pos.y;
    const d = Math.hypot(dx, dy);
    if (d < (target ? Math.min(b.attack.range * 0.6, 3) : 0.5)) { A.mx = A.my = 0; return [0, 0]; }
    dx /= d; dy /= d;
    // обход стен: если впереди непроходимо — поворачиваем
    const ahead = (ax: number, ay: number) => {
      const t = tileAt(w.map, Math.floor(pos.x + ax * 0.8), Math.floor(pos.y + ay * 0.8));
      return t === Tile.Wall || t === Tile.Water || t === Tile.Box;
    };
    if (Math.hypot(pos.x - A.lx, pos.y - A.ly) < 0.05) A.stuck++; else A.stuck = 0;
    A.lx = pos.x; A.ly = pos.y;
    if (A.stuck > 3) A.turn = -A.turn;
    let ang = Math.atan2(dy, dx);
    for (let i = 0; i < 8 && ahead(Math.cos(ang), Math.sin(ang)); i++) ang += A.turn * Math.PI / 4;
    A.mx = Math.cos(ang); A.my = Math.sin(ang);
    return [A.mx, A.my];
  }

  dispose() {
    this.input.enabled = false;
    this.input.reset();
    this.hud.remove();
    for (const cv of this.chars.values()) cv.dispose();
    this.scene.clear();
  }
}
