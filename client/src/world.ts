import { GameMap, parseMap, setTile, Tile } from '../../shared/map';
import { stepPlayer } from '../../shared/physics';
import { Brawler, getBrawler } from '../../shared/brawlers';
import { INTERP_DELAY_MS, TICK_DT } from '../../shared/constants';
import {
  Snapshot, StartMsg, RosterEntry, PlayerSnap, ProjSnap, MinionSnap, CanSnap, AreaSnap, GameEvent, InputItem,
  F_ALIVE, F_LOCKED,
} from '../../shared/protocol';

const TICK_MS = TICK_DT * 1000;

interface Snap {
  t: number;
  ms: number;
  players: Map<number, PlayerSnap>;
  proj: Map<number, ProjSnap>;
  minions: Map<number, MinionSnap>;
  cans: CanSnap[];
  areas: AreaSnap[];
  gas: number;
  alive: number;
  el: number;
}

export interface PView {
  slot: number; x: number; y: number; facing: number; hp: number; maxHp: number; cans: number;
  ammo: number; sup: number; flags: number; visible: boolean; moving: boolean;
}

function lerpAngle(a: number, b: number, k: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/** Состояние боя на клиенте: свой игрок предсказывается, чужие интерполируются. */
export class ClientWorld {
  map: GameMap;
  roster: RosterEntry[];
  you: number;
  me: Brawler;
  boxes: Map<number, number>;
  gasStart: number;
  snaps: Snap[] = [];
  latest: Snap | null = null;
  latestAt = 0;
  ping = 0;
  offset: number | null = null;
  seq = 0;
  pending: { seq: number; mx: number; my: number; dt: number }[] = [];
  outbox: InputItem[] = [];
  pred = { x: 0, y: 0 };
  smooth = { x: 0, y: 0 };
  locked = false;
  alive = true;
  hasMe = false;
  myFacing = 0;
  corrections: number[] = [];
  private events: { t: number; e: GameEvent }[] = [];
  private lastMoveAt = 0;

  constructor(start: StartMsg) {
    this.map = parseMap(start.map);
    this.roster = start.roster;
    this.you = start.you;
    this.me = getBrawler(start.roster.find((r) => r.slot === start.you)?.brawler);
    this.boxes = new Map(start.boxes);
    this.gasStart = start.gasStart;
  }

  rosterOf(slot: number) { return this.roster.find((r) => r.slot === slot); }

  onSnapshot(s: Snapshot, now: number) {
    const snap: Snap = {
      t: s.t, ms: s.t * TICK_MS,
      players: new Map(s.p.map((p) => [p[0], p])),
      proj: new Map(s.pr.map((p) => [p[0], p])),
      minions: new Map(s.mn.map((m) => [m[0], m])),
      cans: s.c, areas: s.ar ?? [], gas: s.gas / 100, alive: s.alive, el: s.el / 10,
    };
    if (this.latest && snap.t <= this.latest.t) return;
    const sample = snap.ms - now;
    if (this.offset === null || Math.abs(sample - this.offset) > 400) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.08;
    this.snaps.push(snap);
    while (this.snaps.length > 40) this.snaps.shift();
    this.latest = snap;
    this.latestAt = now;

    for (const e of s.ev) {
      if (e[0] === 'tile') setTile(this.map, e[1] % this.map.w, Math.floor(e[1] / this.map.w), e[2] as Tile);
      if (e[0] === 'box') this.boxes.set(e[1], e[2]);
      if (e[0] === 'tile') this.boxes.delete(e[1]);
      this.events.push({ t: s.t, e });
    }

    const mine = snap.players.get(this.you);
    if (!mine) return;
    const sx = mine[1] / 100, sy = mine[2] / 100;
    this.alive = (mine[8] & F_ALIVE) !== 0;
    const wasLocked = this.locked;
    this.locked = (mine[8] & F_LOCKED) !== 0 || !this.alive;
    this.pending = this.pending.filter((p) => p.seq > s.ack);
    if (!this.hasMe) { this.hasMe = true; this.pred = { x: sx, y: sy }; this.myFacing = mine[9] / 100; return; }
    if (this.locked) {
      this.pred = { x: sx, y: sy };
      this.smooth = { x: 0, y: 0 };
      return;
    }
    const p = { x: sx, y: sy };
    for (const it of this.pending) stepPlayer(this.map, p, it.mx, it.my, this.me.speed, it.dt);
    const ex = this.pred.x - p.x, ey = this.pred.y - p.y;
    const err = Math.hypot(ex, ey);
    this.corrections.push(err);
    if (this.corrections.length > 2000) this.corrections.shift();
    if (wasLocked || err > 2.5) this.smooth = { x: 0, y: 0 };
    else { this.smooth.x += ex; this.smooth.y += ey; }
    this.pred = p;
  }

  /** Шаг предсказания своего игрока. */
  predict(mx: number, my: number, dt: number, now: number) {
    dt = Math.min(dt, 0.1);
    const decay = Math.exp(-dt * 10);
    this.smooth.x *= decay; this.smooth.y *= decay;
    if (!this.hasMe || this.locked || !this.alive) return;
    const len = Math.hypot(mx, my);
    if (len < 0.15) return;
    if (len > 1) { mx /= len; my /= len; }
    const it = { seq: ++this.seq, mx: Math.round(mx * 1000) / 1000, my: Math.round(my * 1000) / 1000, dt: Math.round(dt * 10000) / 10000 };
    stepPlayer(this.map, this.pred, it.mx, it.my, this.me.speed, it.dt);
    this.pending.push(it);
    this.outbox.push([it.seq, it.mx, it.my, it.dt]);
    this.lastMoveAt = now;
    this.myFacing = Math.atan2(my, mx);
  }

  takeOutbox() { const o = this.outbox; this.outbox = []; return o; }

  myPos() { return { x: this.pred.x + this.smooth.x, y: this.pred.y + this.smooth.y }; }
  movingRecently(now: number) { return now - this.lastMoveAt < 120; }

  renderMs(now: number) { return now + (this.offset ?? 0) - INTERP_DELAY_MS; }

  private bracket(now: number): [Snap, Snap, number] | null {
    if (!this.snaps.length) return null;
    const rt = this.renderMs(now);
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      const a = this.snaps[i];
      if (a.ms <= rt) {
        const b = this.snaps[i + 1];
        if (!b) return [a, a, 0];
        return [a, b, Math.min(1, (rt - a.ms) / (b.ms - a.ms))];
      }
    }
    const f = this.snaps[0];
    return [f, f, 0];
  }

  /** Отложенные на задержку интерполяции события (чтобы попадания совпадали с картинкой). */
  dueEvents(now: number): GameEvent[] {
    // Попадания, взрывы, ящики, смерти показываем сразу (свои пули рисуются без задержки,
    // так отклик быстрее). Отложены только выстрелы/суперы других — под их интерполированную позицию.
    const rt = this.renderMs(now);
    const out: GameEvent[] = [];
    this.events = this.events.filter((x) => {
      const delayed = (x.e[0] === 'shot' || x.e[0] === 'super') && x.e[1] !== this.you;
      if (delayed && x.t * TICK_MS > rt && this.events.length < 400) return true;
      out.push(x.e);
      return false;
    });
    return out;
  }

  players(now: number): PView[] {
    const br = this.bracket(now);
    if (!br) return [];
    const [a, b, k] = br;
    const out: PView[] = [];
    for (const [slot, pb] of b.players) {
      const pa = a.players.get(slot) ?? pb;
      const x = (pa[1] + (pb[1] - pa[1]) * k) / 100, y = (pa[2] + (pb[2] - pa[2]) * k) / 100;
      const moving = Math.hypot(pb[1] - pa[1], pb[2] - pa[2]) > 2;
      out.push({
        slot, x, y, facing: lerpAngle(pa[9] / 100, pb[9] / 100, k), hp: pb[3], maxHp: pb[4], cans: pb[5],
        ammo: pb[6] / 100, sup: pb[7] / 100, flags: pb[8], visible: true, moving,
      });
    }
    return out;
  }

  /** Свежие данные о себе (без задержки интерполяции) — для HUD. */
  meLatest(): PlayerSnap | undefined { return this.latest?.players.get(this.you); }

  projectiles(now: number) {
    const br = this.bracket(now);
    if (!br) return [];
    const [a, b, k] = br;
    const out: { id: number; look: number; x: number; y: number; a: number; h: number }[] = [];
    // свои снаряды — без задержки интерполяции: последний снапшот + экстраполяция на полпинга,
    // чтобы пуля вылетала из ствола сразу после клика
    const L = this.latest!;
    const ahead = Math.min(0.3, (now - this.latestAt) / 1000 + this.ping / 2000);
    for (const [id, p] of L.proj) {
      if (p[6] !== this.you) continue;
      const ang = p[4] / 100, sp = p[5] / 10;
      out.push({ id, look: p[1], x: p[2] / 100 + Math.cos(ang) * sp * ahead, y: p[3] / 100 + Math.sin(ang) * sp * ahead, a: ang, h: p[7] / 100 });
    }
    for (const [id, pb] of b.proj) {
      if (pb[6] === this.you) continue;
      const pa = a.proj.get(id);
      if (!pa) { if (k > 0.3 || a === b) out.push({ id, look: pb[1], x: pb[2] / 100, y: pb[3] / 100, a: pb[4] / 100, h: pb[7] / 100 }); continue; }
      out.push({ id, look: pb[1], x: (pa[2] + (pb[2] - pa[2]) * k) / 100, y: (pa[3] + (pb[3] - pa[3]) * k) / 100, a: pb[4] / 100, h: (pa[7] + (pb[7] - pa[7]) * k) / 100 });
    }
    // долетающие в последний кадр снаряды
    if (a !== b) for (const [id, pa] of a.proj) if (pa[6] !== this.you && !b.proj.has(id) && k < 0.5) out.push({ id, look: pa[1], x: pa[2] / 100, y: pa[3] / 100, a: pa[4] / 100, h: pa[7] / 100 });
    return out;
  }

  minions(now: number) {
    const br = this.bracket(now);
    if (!br) return [];
    const [a, b, k] = br;
    return [...b.minions.values()].map((mb) => {
      const ma = a.minions.get(mb[0]) ?? mb;
      return { id: mb[0], type: mb[1], x: (ma[2] + (mb[2] - ma[2]) * k) / 100, y: (ma[3] + (mb[3] - ma[3]) * k) / 100, hp: mb[4], maxHp: mb[5], owner: mb[6], facing: mb[7] / 100 };
    });
  }

  /** Лужи от бутылок (из свежего снапшота). */
  areas() { return (this.latest?.areas ?? []).map((a) => ({ id: a[0], x: a[1] / 100, y: a[2] / 100, r: a[3] / 100, owner: a[4] })); }

  cans(now: number) {
    const br = this.bracket(now);
    return br ? br[1].cans : [];
  }

  gas(now: number) {
    const br = this.bracket(now);
    if (!br) return 100;
    const [a, b, k] = br;
    return a.gas + (b.gas - a.gas) * k;
  }

  info() { return this.latest ? { alive: this.latest.alive, el: this.latest.el } : { alive: 10, el: 0 }; }
}
