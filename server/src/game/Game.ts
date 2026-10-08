import {
  Brawler, getBrawler, Attack, BurstAttack, SpreadAttack, BouncerAttack, BaseSuper, LobAttack, BoosterSuper,
} from '../../../shared/brawlers';
import {
  GameMap, Tile, parseMap, mapToText, tileAt, setTile, blocksShot, blocksMove,
} from '../../../shared/map';
import { moveCircle, stepPlayer, clampInput, nearestWalkable } from '../../../shared/physics';
import {
  PLAYER_RADIUS, REGEN_DELAY, REGEN_RATE, CAN_BONUS, CAN_PICKUP_RADIUS, BOX_HP, BUSH_REVEAL_DIST,
  REVEAL_AFTER_SHOT, GAS_START, GAS_DURATION, GAS_MIN_HALF, GAS_DAMAGE, TICK_DT,
} from '../../../shared/constants';
import {
  LOOKS, F_SHIELD, F_SEEKER, F_ALIVE, F_BUSH, F_INVIS, F_LOCKED, F_AIR, F_STUN, F_OFFLINE, F_REVEALED,
  GameEvent, Snapshot, PlayerSnap, ProjSnap, AreaSnap, MinionSnap, CanSnap, InputItem, StartMsg, RosterEntry, ResultEntry,
} from '../../../shared/protocol';
import { BotBrain } from './bots';

export type QueueItem =
  | { k: 'm'; seq: number; mx: number; my: number; dt: number }
  | { k: 'a'; angle: number; dist: number }
  | { k: 's'; angle: number; dist: number };

export type Forced =
  | { kind: 'charge' | 'grab'; dx: number; dy: number; left: number; speed: number; hit: Set<number> }
  | { kind: 'knock'; vx: number; vy: number; left: number }
  | { kind: 'jump' | 'thrown'; fx: number; fy: number; tx: number; ty: number; t: number; dur: number; by: number };

export interface Player {
  slot: number;
  sid: string;
  name: string;
  brawler: Brawler;
  bot: boolean;
  connected: boolean;
  x: number; y: number;
  vx: number; vy: number;
  hp: number;
  cans: number;
  ammo: number;
  superCharge: number;
  alive: boolean;
  place: number;
  facing: number;
  lastCombat: number;
  lastHurt: number;
  nextAttackAt: number;
  revealUntil: number;
  invisibleUntil: number;
  stunUntil: number;
  gasAcc: number;
  queue: QueueItem[];
  budget: number;
  ack: number;
  forced: Forced | null;
  kills: number;
  deaths: number;
  respawnAt: number;
  shieldUntil: number;
  seeker: boolean;
  brain: BotBrain | null;
}

export interface Projectile {
  id: number; owner: number; look: number;
  x: number; y: number; dx: number; dy: number; speed: number;
  traveled: number; range: number; damage: number; radius: number;
  minFalloff: number; breaksWalls: boolean; chargesSuper: boolean;
  bouncer: { hop: number; splashR: number; splashDmg: number; hopping: boolean; hopLeft: number } | null;
  bounces: number;
  lob: { fx: number; fy: number; tx: number; ty: number; t: number; dur: number; spec: LobAttack; mult: number } | null;
}

/** Лужа от бутылки: бьёт врагов внутри раз в tickEvery. */
export interface Area {
  id: number; owner: number; x: number; y: number; r: number;
  until: number; nextTick: number; damage: number; tickEvery: number; charges: boolean;
}

export interface Minion {
  id: number; type: 0 | 1 | 2; owner: number;
  x: number; y: number; hp: number; maxHp: number; facing: number;
  nextSpawn: number; expires: number; nextAttack: number;
  spec: BaseSuper | BoosterSuper;
}

export interface Can { id: number; x: number; y: number; readyAt: number }

interface Scheduled { at: number; slot: number; angle: number; attack: BurstAttack; charges: boolean; mult: number }

export type GameMode = 'showdown' | 'brawl' | 'hide';
/** Прятки: 20 с водящий «считает», потом 2 минуты ищет; пойманный тоже водит. */
export const HIDE_COUNT = 20;

export interface GameOptions {
  mode?: GameMode;      // showdown — до последнего; brawl — схватка с возрождениями
  duration?: number;    // схватка: длительность, с
  killGoal?: number;    // схватка: столько убийств — досрочная победа
  gasStart?: number;
  gasDuration?: number;
  seed?: number;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r100 = (v: number) => Math.round(v * 100);

export class Game {
  map: GameMap;
  players: Player[] = [];
  projectiles: Projectile[] = [];
  areas: Area[] = [];
  minions: Minion[] = [];
  cans: Can[] = [];
  boxHp = new Map<number, number>();
  scheduled: Scheduled[] = [];
  events: GameEvent[] = [];
  time = 0;
  tickNo = 0;
  started = false;
  ended = false;
  rand: () => number;
  gasStart: number;
  gasDuration: number;
  mode: GameMode;
  duration: number;
  killGoal: number;
  private nextId = 1;

  constructor(mapText: string, opts: GameOptions = {}) {
    this.map = parseMap(mapText);
    this.mode = opts.mode ?? 'showdown';
    this.duration = opts.duration ?? 180;
    this.killGoal = opts.killGoal ?? 15;
    this.gasStart = opts.gasStart ?? GAS_START;
    this.gasDuration = opts.gasDuration ?? GAS_DURATION;
    this.rand = mulberry32(opts.seed ?? (Date.now() & 0xffffffff));
    for (let i = 0; i < this.map.tiles.length; i++) if (this.map.tiles[i] === Tile.Box) this.boxHp.set(i, BOX_HP);
  }

  // ---------- игроки ----------

  addPlayer(name: string, brawlerId: string, bot: boolean, sid = ''): Player {
    const slot = this.players.length;
    const spawn = this.map.spawns[slot % Math.max(1, this.map.spawns.length)] ?? { x: this.map.w / 2, y: this.map.h / 2 };
    const b = getBrawler(brawlerId);
    const p: Player = {
      slot, sid, name, brawler: b, bot, connected: true,
      x: spawn.x, y: spawn.y, vx: 0, vy: 0,
      hp: b.hp, cans: 0, ammo: b.ammo, superCharge: 0,
      alive: true, place: 0, facing: Math.atan2(this.map.h / 2 - spawn.y, this.map.w / 2 - spawn.x),
      lastCombat: -99, lastHurt: -99, nextAttackAt: 0, revealUntil: 0, invisibleUntil: 0, stunUntil: 0, gasAcc: 0,
      queue: [], budget: 0, ack: 0, forced: null, kills: 0, deaths: 0, respawnAt: 0, shieldUntil: 0, seeker: false, brain: null,
    };
    if (bot) p.brain = new BotBrain(this, p);
    this.players.push(p);
    return p;
  }

  makeBot(p: Player) {
    if (p.bot) return;
    p.bot = true;
    p.queue.length = 0;
    p.brain = new BotBrain(this, p);
  }

  start() {
    this.started = true;
    if (this.mode === 'hide' && this.players.length) {
      // водящий — случайный игрок; прятки идут 20 с отсчёта + duration
      this.players[Math.floor(this.rand() * this.players.length)].seeker = true;
    }
  }

  /** Прятки: идёт ли ещё отсчёт (водящий стоит и ничего не видит). */
  counting() { return this.mode === 'hide' && this.time < HIDE_COUNT; }
  sameTeam(a: Player, b: Player) { return this.mode === 'hide' && a.seeker && b.seeker; }

  maxHp(p: Player) { return Math.round(p.brawler.hp * (1 + CAN_BONUS * p.cans)); }
  dmgMult(p: Player) {
    let k = 1 + CAN_BONUS * p.cans;
    // турель-усилитель 8-Бита: урон выше, пока стоишь рядом
    for (const m of this.minions) {
      if (m.type === 2 && m.owner === p.slot && m.spec.kind === 'booster' && Math.hypot(m.x - p.x, m.y - p.y) <= m.spec.radius) k *= m.spec.mult;
    }
    return k;
  }
  aliveCount() { let n = 0; for (const p of this.players) if (p.alive) n++; return n; }

  gasHalf(t = this.time) {
    const full = Math.max(this.map.w, this.map.h) / 2 + 1;
    if (this.mode === 'brawl' || t <= this.gasStart) return full;
    const k = Math.min(1, (t - this.gasStart) / this.gasDuration);
    return full + (GAS_MIN_HALF - full) * k;
  }

  inGas(x: number, y: number, t = this.time) {
    const h = this.gasHalf(t);
    return Math.abs(x - this.map.w / 2) > h || Math.abs(y - this.map.h / 2) > h;
  }

  inBush(p: { x: number; y: number }) { return tileAt(this.map, Math.floor(p.x), Math.floor(p.y)) === Tile.Bush; }

  /** Скрыт ли игрок p от наблюдателя viewer (кусты, невидимость). */
  hiddenFrom(p: Player, viewer: Player | null): boolean {
    if (!p.alive || (viewer && viewer.slot === p.slot)) return false;
    if (viewer && !viewer.alive) return false;
    // водящий во время отсчёта никого не видит
    if (viewer && this.counting() && viewer.seeker && !p.seeker) return true;
    const invis = this.time < p.invisibleUntil;
    const bush = this.inBush(p) && this.time >= p.revealUntil;
    if (!invis && !bush) return false;
    if (!viewer) return true;
    return Math.hypot(p.x - viewer.x, p.y - viewer.y) >= BUSH_REVEAL_DIST;
  }

  queueInputs(p: Player, items: InputItem[]) {
    if (!Array.isArray(items)) return;
    for (const it of items.slice(0, 30)) {
      if (!Array.isArray(it)) continue;
      const [seq, mx0, my0, dt0] = it;
      const [mx, my] = clampInput(+mx0, +my0);
      const dt = Math.min(0.1, Math.max(0, +dt0 || 0));
      if (!(seq > p.ack)) continue;
      p.queue.push({ k: 'm', seq: seq | 0, mx, my, dt });
    }
    if (p.queue.length > 120) p.queue.splice(0, p.queue.length - 120);
  }

  queueAttack(p: Player, angle: number, dist = NaN) { if (Number.isFinite(angle)) p.queue.push({ k: 'a', angle, dist: Number.isFinite(dist) ? dist : 99 }); }
  queueSuper(p: Player, angle: number, dist: number) {
    if (Number.isFinite(angle)) p.queue.push({ k: 's', angle, dist: Number.isFinite(dist) ? dist : 99 });
  }

  canAct(p: Player) {
    if (this.counting() && p.seeker) return false;
    return p.alive && !p.forced && this.time >= p.stunUntil;
  }

  // ---------- атаки ----------

  attack(p: Player, angle: number, dist = 99): boolean {
    if (!this.canAct(p) || p.ammo < 1 || this.time < p.nextAttackAt) return false;
    if (this.mode === 'hide' && !p.seeker) return false; // прячущиеся не стреляют
    const a = p.brawler.attack;
    p.ammo -= 1;
    const busy = a.kind === 'burst' ? a.count * a.interval : 0;
    p.nextAttackAt = this.time + Math.max(p.brawler.cooldown, busy);
    this.onCombatAction(p, angle);
    this.events.push(['shot', p.slot, r100(angle), 0]);
    this.fire(p, a, angle, true, dist);
    return true;
  }

  private onCombatAction(p: Player, angle: number) {
    p.lastCombat = this.time;
    p.revealUntil = this.time + REVEAL_AFTER_SHOT;
    p.invisibleUntil = 0;
    p.facing = angle;
  }

  private fire(p: Player, a: Attack, angle: number, charges: boolean, dist = 99) {
    const mult = this.dmgMult(p);
    if (a.kind === 'lob') {
      const d = Math.min(Math.max(0.5, dist), a.range);
      const cx = p.x + Math.cos(angle) * d, cy = p.y + Math.sin(angle) * d;
      for (let i = 0; i < a.count; i++) {
        // первая бутылка в прицел, остальные — кругом вокруг
        const ang = (i / Math.max(1, a.count - 1)) * Math.PI * 2;
        const tx = Math.min(this.map.w - 0.3, Math.max(0.3, cx + (i ? Math.cos(ang) * a.scatter : 0)));
        const ty = Math.min(this.map.h - 0.3, Math.max(0.3, cy + (i ? Math.sin(ang) * a.scatter : 0)));
        const len = Math.hypot(tx - p.x, ty - p.y) || 0.01;
        this.projectiles.push({
          id: this.nextId++, owner: p.slot, look: LOOKS.indexOf(a.look), x: p.x, y: p.y, dx: (tx - p.x) / len, dy: (ty - p.y) / len,
          speed: len / a.flightTime, traveled: 0, range: len, damage: a.damage * mult, radius: 0, minFalloff: 1,
          breaksWalls: false, chargesSuper: charges, bouncer: null, bounces: 0,
          lob: { fx: p.x, fy: p.y, tx, ty, t: 0, dur: a.flightTime * (i ? 1.1 : 1), spec: a, mult },
        });
      }
      return;
    }
    if (a.kind === 'burst') {
      for (let i = 0; i < a.count; i++) this.scheduled.push({ at: this.time + i * a.interval, slot: p.slot, angle, attack: a, charges, mult });
      this.runScheduled();
    } else if (a.kind === 'spread') {
      for (let i = 0; i < a.count; i++) {
        const off = a.count === 1 ? 0 : (-a.spreadDeg / 2 + (a.spreadDeg * i) / (a.count - 1)) * Math.PI / 180;
        this.spawnProjectile(p, a, angle + off, a.damage * mult, charges, 0);
      }
    } else {
      this.spawnProjectile(p, a, angle, a.damage * mult, charges, 0);
    }
  }

  private spawnProjectile(p: Player, a: Exclude<Attack, LobAttack>, angle: number, damage: number, charges: boolean, advance: number) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const pr: Projectile = {
      id: this.nextId++, owner: p.slot, look: LOOKS.indexOf(a.look),
      x: p.x + dx * 0.3, y: p.y + dy * 0.3, dx, dy, speed: a.speed,
      traveled: 0, range: a.range, damage, radius: a.radius,
      minFalloff: a.kind === 'spread' ? a.minFalloff : 1,
      breaksWalls: a.kind === 'burst' ? !!a.breaksWalls : false,
      chargesSuper: charges,
      bouncer: a.kind === 'bouncer'
        ? { hop: a.hopDistance, splashR: a.splashRadius, splashDmg: a.splashDamage * (damage / a.damage), hopping: false, hopLeft: 0 }
        : null,
      bounces: a.kind === 'burst' ? a.bounces ?? 0 : 0,
      lob: null,
    };
    this.projectiles.push(pr);
    if (advance > 0) this.moveProjectile(pr, advance);
  }

  private runScheduled() {
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      const s = this.scheduled[i];
      if (s.at > this.time + 1e-6) continue;
      this.scheduled.splice(i, 1);
      const p = this.players[s.slot];
      if (!p || !p.alive || p.forced) continue;
      const jit = (this.rand() - 0.5) * s.attack.jitterDeg * Math.PI / 180;
      this.spawnProjectile(p, s.attack, s.angle + jit, s.attack.damage * s.mult, s.charges, (this.time - s.at) * s.attack.speed);
    }
  }

  superAttack(p: Player, angle: number, dist: number): boolean {
    if (!this.canAct(p) || p.superCharge < 1) return false;
    if (this.mode === 'hide' && !p.seeker) return false;
    const s = p.brawler.super;
    p.superCharge = 0;
    p.lastCombat = this.time;
    p.facing = angle;
    this.events.push(['super', p.slot]);
    const dx = Math.cos(angle), dy = Math.sin(angle);
    switch (s.kind) {
      case 'burst':
        this.onCombatAction(p, angle);
        this.events.push(['shot', p.slot, r100(angle), 1]);
        this.fire(p, s, angle, false);
        p.nextAttackAt = Math.max(p.nextAttackAt, this.time + s.count * s.interval);
        break;
      case 'lob':
        this.onCombatAction(p, angle);
        this.events.push(['shot', p.slot, r100(angle), 1]);
        this.fire(p, s, angle, false, dist);
        break;
      case 'booster': {
        const pos = nearestWalkable(this.map, p.x, p.y);
        this.minions = this.minions.filter((m) => !(m.type === 2 && m.owner === p.slot));
        this.minions.push({
          id: this.nextId++, type: 2, owner: p.slot, x: pos.x, y: pos.y, hp: s.hp, maxHp: s.hp, facing: angle,
          nextSpawn: 0, expires: this.time + s.lifetime, nextAttack: 0, spec: s,
        });
        break;
      }
      case 'base': {
        const d = Math.min(Math.max(0, dist), s.range);
        const pos = nearestWalkable(this.map, p.x + dx * d, p.y + dy * d);
        this.minions = this.minions.filter((m) => !(m.type === 0 && m.owner === p.slot));
        this.minions.push({
          id: this.nextId++, type: 0, owner: p.slot, x: pos.x, y: pos.y, hp: s.hp, maxHp: s.hp, facing: angle,
          nextSpawn: this.time + 0.6, expires: this.time + s.lifetime, nextAttack: 0, spec: s,
        });
        break;
      }
      case 'charge':
        p.forced = { kind: 'charge', dx, dy, left: s.range, speed: s.speed, hit: new Set() };
        p.revealUntil = this.time + 1;
        p.invisibleUntil = 0;
        break;
      case 'grab':
        p.forced = { kind: 'grab', dx, dy, left: s.range, speed: s.speed, hit: new Set() };
        p.revealUntil = this.time + 1;
        p.invisibleUntil = 0;
        break;
      case 'invisible':
        p.invisibleUntil = this.time + s.duration;
        break;
      case 'jump': {
        const d = Math.min(Math.max(0, dist), s.range);
        const to = nearestWalkable(this.map, Math.min(this.map.w - 0.5, Math.max(0.5, p.x + dx * d)), Math.min(this.map.h - 0.5, Math.max(0.5, p.y + dy * d)));
        p.forced = { kind: 'jump', fx: p.x, fy: p.y, tx: to.x, ty: to.y, t: 0, dur: s.airTime, by: p.slot };
        p.invisibleUntil = 0;
        break;
      }
    }
    return true;
  }

  // ---------- урон ----------

  damagePlayer(t: Player, amount: number, src: Player | null, chargesSuper: boolean, angle = NaN) {
    if (!t.alive || amount <= 0 || this.time < t.shieldUntil) return;
    if (src && this.sameTeam(src, t)) return;
    if (this.mode === 'hide' && src?.seeker) amount *= 2.5;
    if (t.forced && (t.forced.kind === 'jump')) return; // в прыжке не попасть
    const dmg = Math.round(amount);
    t.hp -= dmg;
    t.lastCombat = this.time;
    t.lastHurt = this.time;
    if (this.inBush(t)) t.revealUntil = Math.max(t.revealUntil, this.time + 0.5);
    this.events.push(['hit', r100(t.x), r100(t.y), dmg, t.slot, Number.isFinite(angle) ? r100(angle) : 9999]);
    if (src && src !== t && chargesSuper) src.superCharge = Math.min(1, src.superCharge + dmg / src.brawler.superCharge);
    if (src && src !== t) src.lastCombat = this.time;
    if (t.hp <= 0) this.kill(t, src);
  }

  damageMinion(m: Minion, amount: number, src: Player | null, chargesSuper: boolean) {
    const dmg = Math.round(amount);
    m.hp -= dmg;
    this.events.push(['hit', r100(m.x), r100(m.y), dmg, -1, 9999]);
    if (src && chargesSuper) src.superCharge = Math.min(1, src.superCharge + (dmg * 0.5) / src.brawler.superCharge);
  }

  damageBox(ti: number, amount: number) {
    const hp = this.boxHp.get(ti);
    if (hp === undefined) return;
    const left = hp - Math.round(amount);
    const x = ti % this.map.w, y = Math.floor(ti / this.map.w);
    this.events.push(['hit', r100(x + 0.5), r100(y + 0.5), Math.round(amount), -1, 9999]);
    if (left <= 0) {
      this.boxHp.delete(ti);
      setTile(this.map, x, y, Tile.Floor);
      this.events.push(['tile', ti, Tile.Floor]);
      this.cans.push({ id: this.nextId++, x: x + 0.5, y: y + 0.5, readyAt: this.time + 0.3 });
    } else {
      this.boxHp.set(ti, left);
      this.events.push(['box', ti, left]);
    }
  }

  breakWall(tx: number, ty: number) {
    if (tileAt(this.map, tx, ty) !== Tile.Wall || tx < 0 || ty < 0 || tx >= this.map.w || ty >= this.map.h) return;
    setTile(this.map, tx, ty, Tile.Floor);
    this.events.push(['tile', ty * this.map.w + tx, Tile.Floor]);
  }

  kill(p: Player, killer: Player | null) {
    if (!p.alive) return;
    const place = this.aliveCount();
    p.alive = false;
    p.hp = 0;
    p.place = place;
    p.forced = null;
    p.queue.length = 0;
    p.deaths++;
    if (this.mode === 'brawl') { p.place = 0; p.respawnAt = this.time + 3; }
    if (this.mode === 'hide') { p.place = 0; p.respawnAt = this.time + 3; p.seeker = true; }
    if (killer && killer !== p) killer.kills++;
    this.events.push(['die', p.slot, place, killer ? killer.slot : -1]);
    for (let i = 0; i < p.cans; i++) {
      const a = this.rand() * Math.PI * 2, r = 0.3 + this.rand() * 1.1;
      const pos = nearestWalkable(this.map, p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
      this.cans.push({ id: this.nextId++, x: pos.x, y: pos.y, readyAt: this.time + 0.4 });
    }
    p.cans = 0;
    this.minions = this.minions.filter((m) => m.owner !== p.slot);
  }

  // ---------- тик ----------

  tick(dt = TICK_DT) {
    if (!this.started || this.ended) return;
    this.time += dt;
    this.tickNo++;
    for (const p of this.players) {
      const ox = p.x, oy = p.y;
      if (p.bot && p.brain && p.alive) p.brain.update(dt);
      else this.processQueue(p, dt);
      this.updateForced(p, dt);
      p.vx = (p.x - ox) / dt; p.vy = (p.y - oy) / dt;
    }
    this.runScheduled();
    this.updateProjectiles(dt);
    this.updateMinions(dt);
    this.updateStatus(dt);
    this.pickups();
    if (this.mode !== 'showdown') for (const p of this.players) if (!p.alive && p.respawnAt && this.time >= p.respawnAt) this.respawn(p);
    this.checkWin();
  }

  /** Схватка: возрождение на спавне подальше от врагов, полное HP, 1.5 с неуязвимости. */
  respawn(p: Player) {
    let best = this.map.spawns[0] ?? { x: this.map.w / 2, y: this.map.h / 2 }, bd = -1;
    for (const s of this.map.spawns) {
      let d = Infinity;
      for (const o of this.players) if (o.alive && o !== p) d = Math.min(d, Math.hypot(o.x - s.x, o.y - s.y));
      if (d > bd) { bd = d; best = s; }
    }
    p.x = best.x; p.y = best.y; p.vx = p.vy = 0;
    p.alive = true; p.hp = p.brawler.hp; p.cans = 0; p.ammo = p.brawler.ammo;
    p.forced = null; p.stunUntil = 0; p.invisibleUntil = 0; p.respawnAt = 0; p.place = 0;
    p.shieldUntil = this.time + 1.5; p.lastCombat = this.time; p.queue.length = 0;
    this.events.push(['spawn', p.slot]);
  }

  /** Сколько секунд в начале боты не нападают: в схватке почти сразу. */
  calm(t: number) { return this.mode === 'brawl' ? Math.min(t, 6) : this.mode === 'hide' ? 0 : t; }

  timeLeft() {
    if (this.mode === 'brawl') return Math.max(0, this.duration - this.time);
    if (this.mode === 'hide') return Math.max(0, HIDE_COUNT + this.duration - this.time);
    return 0;
  }

  /** Сразу обработать пришедший ввод (атака не ждёт следующего тика). */
  processNow(p: Player) { if (this.started && !this.ended && !p.bot) this.processQueue(p, 0); }

  private processQueue(p: Player, dt: number) {
    p.budget = Math.min(0.35, p.budget + dt);
    while (p.queue.length) {
      const it = p.queue[0];
      if (it.k === 'm') {
        if (it.dt > p.budget + 1e-6) break;
        p.budget -= it.dt;
        if (this.canAct(p)) {
          stepPlayer(this.map, p, it.mx, it.my, p.brawler.speed, it.dt);
          if (Math.abs(it.mx) + Math.abs(it.my) > 0.15) p.facing = this.time < p.lastCombat + 0.4 ? p.facing : Math.atan2(it.my, it.mx);
        }
        p.ack = it.seq;
      } else if (it.k === 'a') this.attack(p, it.angle, it.dist);
      else this.superAttack(p, it.angle, it.dist);
      p.queue.shift();
    }
  }

  /** Бот (или тест) двигает игрока напрямую. */
  movePlayer(p: Player, mx: number, my: number, dt: number) {
    if (!this.canAct(p)) return;
    [mx, my] = clampInput(mx, my);
    stepPlayer(this.map, p, mx, my, p.brawler.speed, dt);
    if (Math.abs(mx) + Math.abs(my) > 0.15 && this.time > p.lastCombat + 0.4) p.facing = Math.atan2(my, mx);
  }

  private enemiesNear(x: number, y: number, r: number, except: number): Player[] {
    return this.players.filter((o) => o.alive && o.slot !== except && Math.hypot(o.x - x, o.y - y) < r);
  }

  private updateForced(p: Player, dt: number) {
    const f = p.forced;
    if (!f || !p.alive) return;
    if (f.kind === 'charge' || f.kind === 'grab') {
      const s = p.brawler.super;
      const step = Math.min(f.left, f.speed * dt);
      const sub = Math.ceil(step / 0.2);
      let blocked = false;
      for (let i = 0; i < sub && p.forced; i++) {
        const st = step / sub;
        if (f.kind === 'charge' && s.kind === 'charge' && s.breaksWalls) {
          const nx = p.x + f.dx * (st + PLAYER_RADIUS), ny = p.y + f.dy * (st + PLAYER_RADIUS);
          for (const [ox, oy] of [[0, 0], [f.dy * 0.35, -f.dx * 0.35], [-f.dy * 0.35, f.dx * 0.35]]) {
            const tx = Math.floor(nx + ox), ty = Math.floor(ny + oy);
            const t = tileAt(this.map, tx, ty);
            if (t === Tile.Wall) this.breakWall(tx, ty);
            else if (t === Tile.Box && !f.hit.has(-1 - (ty * this.map.w + tx))) {
              f.hit.add(-1 - (ty * this.map.w + tx));
              this.damageBox(ty * this.map.w + tx, s.damage);
            }
          }
        }
        const bx = p.x, by = p.y;
        moveCircle(this.map, p, f.dx * st, f.dy * st);
        const moved = Math.hypot(p.x - bx, p.y - by);
        if (moved < st * 0.35) { blocked = true; break; }
        for (const o of this.enemiesNear(p.x, p.y, PLAYER_RADIUS * 2.2, p.slot)) {
          if (f.hit.has(o.slot) || (o.forced && o.forced.kind === 'jump')) continue;
          f.hit.add(o.slot);
          if (f.kind === 'charge' && s.kind === 'charge') {
            this.damagePlayer(o, s.damage * this.dmgMult(p), p, false, Math.atan2(f.dy, f.dx));
            if (o.alive) o.forced = { kind: 'knock', vx: f.dx * 9, vy: f.dy * 9, left: s.knockback / 9 };
            p.forced = null;
          } else if (s.kind === 'grab') {
            const to = nearestWalkable(this.map,
              Math.min(this.map.w - 0.5, Math.max(0.5, p.x - f.dx * s.throwDistance)),
              Math.min(this.map.h - 0.5, Math.max(0.5, p.y - f.dy * s.throwDistance)));
            o.forced = { kind: 'thrown', fx: o.x, fy: o.y, tx: to.x, ty: to.y, t: 0, dur: 0.45, by: p.slot };
            o.invisibleUntil = 0;
            p.forced = null;
          }
          break;
        }
        for (const m of this.minions) {
          if (m.owner === p.slot || f.hit.has(100000 + m.id)) continue;
          if (Math.hypot(m.x - p.x, m.y - p.y) < PLAYER_RADIUS * 2) {
            f.hit.add(100000 + m.id);
            if (s.kind === 'charge' || s.kind === 'grab') this.damageMinion(m, s.damage * 0.6, p, false);
          }
        }
      }
      if (p.forced === f) {
        f.left -= step;
        if (f.left <= 1e-4 || blocked) p.forced = null;
      }
    } else if (f.kind === 'knock') {
      const st = Math.min(dt, f.left);
      moveCircle(this.map, p, f.vx * st, f.vy * st);
      f.left -= st;
      if (f.left <= 1e-4) p.forced = null;
    } else if (f.kind === 'jump' || f.kind === 'thrown') {
      f.t += dt;
      const k = Math.min(1, f.t / f.dur);
      p.x = f.fx + (f.tx - f.fx) * k;
      p.y = f.fy + (f.ty - f.fy) * k;
      if (k >= 1) {
        p.forced = null;
        const pos = nearestWalkable(this.map, p.x, p.y);
        p.x = pos.x; p.y = pos.y;
        const src = this.players[f.by];
        if (f.kind === 'jump') {
          const s = p.brawler.super;
          if (s.kind === 'jump') {
            this.events.push(['boom', r100(p.x), r100(p.y), r100(s.radius)]);
            if (s.breaksWalls) {
              for (let ty = Math.floor(p.y - s.radius); ty <= Math.floor(p.y + s.radius); ty++)
                for (let tx = Math.floor(p.x - s.radius); tx <= Math.floor(p.x + s.radius); tx++)
                  if (Math.hypot(tx + 0.5 - p.x, ty + 0.5 - p.y) <= s.radius) this.breakWall(tx, ty);
            }
            for (const o of this.enemiesNear(p.x, p.y, s.radius + PLAYER_RADIUS, p.slot)) {
              const a = Math.atan2(o.y - p.y, o.x - p.x);
              this.damagePlayer(o, s.damage * this.dmgMult(p), p, false, a);
              if (o.alive && !o.forced) o.forced = { kind: 'knock', vx: Math.cos(a) * 8, vy: Math.sin(a) * 8, left: 0.12 };
            }
            for (const m of this.minions) if (m.owner !== p.slot && Math.hypot(m.x - p.x, m.y - p.y) < s.radius) this.damageMinion(m, s.damage, p, false);
          }
        } else if (src) {
          const s = src.brawler.super;
          if (s.kind === 'grab') {
            this.events.push(['boom', r100(p.x), r100(p.y), 80]);
            this.damagePlayer(p, s.damage * this.dmgMult(src), src, false);
            p.stunUntil = this.time + s.stun;
          }
        }
      }
    }
  }

  private moveProjectile(pr: Projectile, dist: number): boolean {
    const sub = Math.max(1, Math.ceil(dist / 0.2));
    const st = dist / sub;
    for (let i = 0; i < sub; i++) {
      pr.x += pr.dx * st; pr.y += pr.dy * st;
      pr.traveled += st;
      const owner = this.players[pr.owner];
      if (pr.bouncer && pr.bouncer.hopping) {
        pr.bouncer.hopLeft -= st;
        if (pr.bouncer.hopLeft <= 0) {
          const pos = nearestWalkable(this.map, pr.x, pr.y);
          this.splash(pr, pos.x, pos.y);
          return false;
        }
        continue;
      }
      const tx = Math.floor(pr.x), ty = Math.floor(pr.y);
      if (tx < 0 || ty < 0 || tx >= this.map.w || ty >= this.map.h) return false;
      const t = tileAt(this.map, tx, ty);
      if (blocksShot(t)) {
        if (t === Tile.Box) { this.damageBox(ty * this.map.w + tx, pr.damage * this.falloff(pr)); return false; }
        if (pr.breaksWalls) { this.breakWall(tx, ty); continue; }
        if (pr.bounces > 0) {
          // рикошет: откатываемся и отражаем ту ось, по которой вошли в стену
          const px = pr.x - pr.dx * st, py = pr.y - pr.dy * st;
          const hitX = blocksShot(tileAt(this.map, Math.floor(pr.x), Math.floor(py)));
          const hitY = blocksShot(tileAt(this.map, Math.floor(px), Math.floor(pr.y)));
          if (hitX || !hitY) pr.dx = -pr.dx;
          if (hitY || !hitX) pr.dy = -pr.dy;
          pr.x = px; pr.y = py; pr.bounces--;
          continue;
        }
        if (pr.bouncer) { pr.bouncer.hopping = true; pr.bouncer.hopLeft = pr.bouncer.hop; continue; }
        this.events.push(['boom', r100(pr.x - pr.dx * 0.2), r100(pr.y - pr.dy * 0.2), 0]);
        return false;
      }
      for (const o of this.players) {
        if (!o.alive || o.slot === pr.owner || (o.forced && o.forced.kind === 'jump')) continue;
        if (owner && this.sameTeam(owner, o)) continue;
        if ((o.x - pr.x) ** 2 + (o.y - pr.y) ** 2 < (PLAYER_RADIUS + pr.radius) ** 2) {
          this.damagePlayer(o, pr.damage * this.falloff(pr), owner ?? null, pr.chargesSuper, Math.atan2(pr.dy, pr.dx));
          return false;
        }
      }
      for (const m of this.minions) {
        if (m.owner === pr.owner) continue;
        const mr = m.type === 1 ? 0.28 : 0.5;
        if ((m.x - pr.x) ** 2 + (m.y - pr.y) ** 2 < (mr + pr.radius) ** 2) {
          this.damageMinion(m, pr.damage * this.falloff(pr), owner ?? null, pr.chargesSuper);
          return false;
        }
      }
      if (pr.traveled >= pr.range) return false;
    }
    return true;
  }

  private falloff(pr: Projectile) {
    if (pr.minFalloff >= 1) return 1;
    const k = Math.min(1, pr.traveled / pr.range);
    return 1 - (1 - pr.minFalloff) * k;
  }

  private splash(pr: Projectile, x: number, y: number) {
    const b = pr.bouncer!;
    this.events.push(['boom', r100(x), r100(y), r100(b.splashR)]);
    const owner = this.players[pr.owner] ?? null;
    for (const o of this.enemiesNear(x, y, b.splashR + PLAYER_RADIUS, pr.owner)) this.damagePlayer(o, b.splashDmg, owner, pr.chargesSuper, Math.atan2(o.y - y, o.x - x));
    for (const m of this.minions) if (m.owner !== pr.owner && Math.hypot(m.x - x, m.y - y) < b.splashR) this.damageMinion(m, b.splashDmg, owner, pr.chargesSuper);
  }

  private updateProjectiles(dt: number) {
    this.projectiles = this.projectiles.filter((pr) => {
      if (!pr.lob) return this.moveProjectile(pr, pr.speed * dt);
      const L = pr.lob;
      L.t += dt;
      const k = Math.min(1, L.t / L.dur);
      pr.x = L.fx + (L.tx - L.fx) * k; pr.y = L.fy + (L.ty - L.fy) * k;
      if (k < 1) return true;
      this.events.push(['boom', r100(L.tx), r100(L.ty), r100(L.spec.radius)]);
      this.areas.push({ id: this.nextId++, owner: pr.owner, x: L.tx, y: L.ty, r: L.spec.radius, until: this.time + L.spec.duration,
        nextTick: this.time, damage: L.spec.damage * L.mult, tickEvery: L.spec.tickEvery, charges: pr.chargesSuper });
      return false;
    });
    this.areas = this.areas.filter((a) => {
      if (this.time >= a.nextTick) {
        a.nextTick += a.tickEvery;
        const owner = this.players[a.owner] ?? null;
        for (const o of this.enemiesNear(a.x, a.y, a.r + PLAYER_RADIUS * 0.5, a.owner)) this.damagePlayer(o, a.damage, owner, a.charges);
        for (const m of this.minions) if (m.owner !== a.owner && Math.hypot(m.x - a.x, m.y - a.y) < a.r) this.damageMinion(m, a.damage, owner, a.charges);
        // лужа разъедает ящики под собой
        for (let ty = Math.floor(a.y - a.r); ty <= Math.floor(a.y + a.r); ty++)
          for (let tx = Math.floor(a.x - a.r); tx <= Math.floor(a.x + a.r); tx++)
            if (tileAt(this.map, tx, ty) === Tile.Box && Math.hypot(tx + 0.5 - a.x, ty + 0.5 - a.y) < a.r + 0.5) this.damageBox(ty * this.map.w + tx, a.damage);
      }
      return this.time < a.until;
    });
  }

  private updateMinions(dt: number) {
    const spawned: Minion[] = [];
    for (const m of this.minions) {
      if (m.type === 2) { if (this.time >= m.expires) m.hp = 0; continue; }
      if (m.spec.kind !== 'base') continue;
      if (m.type === 0) {
        if (this.time >= m.expires) { m.hp = 0; continue; }
        const mine = this.minions.filter((o) => o.type === 1 && o.owner === m.owner && o.hp > 0).length;
        if (this.time >= m.nextSpawn && mine < m.spec.maxMinions) {
          m.nextSpawn = this.time + m.spec.spawnEvery;
          const mm = m.spec.minion;
          spawned.push({
            id: this.nextId++, type: 1, owner: m.owner, x: m.x, y: m.y + 0.4, hp: mm.hp, maxHp: mm.hp, facing: 0,
            nextSpawn: 0, expires: this.time + 25, nextAttack: 0, spec: m.spec,
          });
        }
      } else {
        if (this.time >= m.expires) { m.hp = 0; continue; }
        const mm = m.spec.minion;
        let best: Player | null = null, bd = mm.sight;
        for (const p of this.players) {
          if (!p.alive || p.slot === m.owner || this.time < p.invisibleUntil) continue;
          const d = Math.hypot(p.x - m.x, p.y - m.y);
          if (d < bd) { bd = d; best = p; }
        }
        if (best) {
          const a = Math.atan2(best.y - m.y, best.x - m.x);
          m.facing = a;
          if (bd > 0.75) moveCircle(this.map, m, Math.cos(a) * mm.speed * dt, Math.sin(a) * mm.speed * dt, 0.25);
          else if (this.time >= m.nextAttack) {
            m.nextAttack = this.time + mm.attackInterval;
            const owner = this.players[m.owner];
            this.damagePlayer(best, mm.damage * (owner ? this.dmgMult(owner) : 1), owner ?? null, true, Math.atan2(best.y - m.y, best.x - m.x));
          }
        }
      }
      if (this.inGas(m.x, m.y)) m.hp -= GAS_DAMAGE * dt * 0.5;
    }
    this.minions.push(...spawned);
    this.minions = this.minions.filter((m) => m.hp > 0);
  }

  private updateStatus(dt: number) {
    for (const p of this.players) {
      if (!p.alive) continue;
      const mx = this.maxHp(p);
      p.ammo = Math.min(p.brawler.ammo, p.ammo + dt / p.brawler.reload);
      if (this.time - p.lastCombat >= REGEN_DELAY && p.hp < mx) p.hp = Math.min(mx, p.hp + mx * REGEN_RATE * dt);
      if (this.inGas(p.x, p.y)) {
        p.gasAcc += dt;
        if (p.gasAcc >= 1) {
          p.gasAcc -= 1;
          this.events.push(['gas', p.slot]);
          this.damagePlayer(p, GAS_DAMAGE, null, false);
        }
      } else p.gasAcc = Math.min(p.gasAcc, 0.5);
    }
  }

  private pickups() {
    if (!this.cans.length) return;
    this.cans = this.cans.filter((c) => {
      if (this.time < c.readyAt) return true;
      // банка притягивается к ближайшему живому игроку
      let near: Player | null = null, nd = 1.7;
      for (const p of this.players) {
        if (!p.alive) continue;
        const d = Math.hypot(p.x - c.x, p.y - c.y);
        if (d < nd) { nd = d; near = p; }
      }
      if (near && nd > 0.05) { const st = Math.min(nd, 7 * TICK_DT); c.x += ((near.x - c.x) / nd) * st; c.y += ((near.y - c.y) / nd) * st; }
      for (const p of this.players) {
        if (!p.alive || (p.forced && p.forced.kind !== 'knock')) continue;
        if ((p.x - c.x) ** 2 + (p.y - c.y) ** 2 < CAN_PICKUP_RADIUS ** 2) {
          p.cans++;
          p.hp = Math.min(this.maxHp(p), p.hp + p.brawler.hp * CAN_BONUS);
          this.events.push(['can', p.slot]);
          return false;
        }
      }
      return true;
    });
  }

  private checkWin() {
    if (this.ended || this.players.length < 2) return;
    if (this.mode === 'hide') {
      const hiders = this.players.filter((p) => !p.seeker);
      if (!hiders.length || this.time >= HIDE_COUNT + this.duration) {
        // выжившие прячущиеся — 1-е место; иначе побеждают водящие, лучший по поимкам первый
        const order = hiders.length ? [...hiders, ...this.players.filter((p) => p.seeker)] : [...this.players].sort((a, b) => b.kills - a.kills);
        order.forEach((p, i) => { p.place = hiders.length ? (p.seeker ? 2 : 1) : i + 1; });
        this.ended = true;
      }
      return;
    }
    if (this.mode === 'brawl') {
      if (this.time >= this.duration || this.players.some((p) => p.kills >= this.killGoal)) {
        // места по убийствам, при равенстве — у кого меньше смертей
        [...this.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).forEach((p, i) => { p.place = i + 1; });
        this.ended = true;
      }
      return;
    }
    const alive = this.players.filter((p) => p.alive);
    if (alive.length <= 1) {
      for (const p of alive) p.place = 1;
      this.ended = true;
    }
  }

  results(): ResultEntry[] {
    return this.players
      .map((p) => ({ slot: p.slot, name: p.name, brawler: p.brawler.id, place: p.place || 1, bot: p.bot, kills: p.kills, deaths: p.deaths }))
      .sort((a, b) => a.place - b.place);
  }

  // ---------- сеть ----------

  roster(): RosterEntry[] {
    return this.players.map((p) => ({ slot: p.slot, name: p.name, brawler: p.brawler.id, bot: p.bot, sid: p.sid }));
  }

  startMsg(you: number): StartMsg {
    return {
      map: mapToText(this.map), boxes: [...this.boxHp.entries()], roster: this.roster(), you, t: this.tickNo,
      gasStart: this.gasStart, gasDuration: this.gasDuration, mode: this.mode, duration: this.duration, killGoal: this.killGoal,
    };
  }

  snapshotFor(viewer: Player | null, events: GameEvent[]): Snapshot {
    const p: PlayerSnap[] = [];
    for (const o of this.players) {
      if (o.alive && this.hiddenFrom(o, viewer)) continue;
      let flags = 0;
      if (o.alive) flags |= F_ALIVE;
      if (this.inBush(o)) flags |= F_BUSH;
      if (this.time < o.invisibleUntil) flags |= F_INVIS;
      if (o.forced || this.time < o.stunUntil || !o.alive) flags |= F_LOCKED;
      if (o.forced && (o.forced.kind === 'jump' || o.forced.kind === 'thrown')) flags |= F_AIR;
      if (this.time < o.stunUntil) flags |= F_STUN;
      if (!o.connected && !o.bot) flags |= F_OFFLINE;
      if (this.time < o.revealUntil) flags |= F_REVEALED;
      if (this.time < o.shieldUntil) flags |= F_SHIELD;
      if (o.seeker) flags |= F_SEEKER;
      p.push([o.slot, r100(o.x), r100(o.y), Math.ceil(o.hp), this.maxHp(o), o.cans, r100(o.ammo), r100(o.superCharge), flags, r100(o.facing)]);
    }
    const pr: ProjSnap[] = this.projectiles.map((q) => [q.id, q.look, r100(q.x), r100(q.y), r100(Math.atan2(q.dy, q.dx)), Math.round(q.speed * 10), q.owner,
      q.lob ? r100(Math.sin(Math.min(1, q.lob.t / q.lob.dur) * Math.PI) * 2.2) : 0]);
    const ar: AreaSnap[] = this.areas.map((a) => [a.id, r100(a.x), r100(a.y), r100(a.r), a.owner]);
    const mn: MinionSnap[] = this.minions.map((m) => [m.id, m.type, r100(m.x), r100(m.y), Math.ceil(m.hp), m.maxHp, m.owner, r100(m.facing)]);
    const c: CanSnap[] = this.cans.map((k) => [k.id, r100(k.x), r100(k.y)]);
    return {
      t: this.tickNo, ack: viewer ? viewer.ack : 0, el: Math.round(this.time * 10), gas: r100(this.gasHalf()),
      alive: this.aliveCount(), p, pr, mn, c, ar, ev: events,
      ...(this.mode !== 'showdown' ? { tl: Math.round(this.timeLeft() * 10), sc: this.players.map((o) => [o.slot, o.kills, o.deaths] as [number, number, number]), hd: this.players.filter((o) => !o.seeker).length } : {}),
    };
  }

  takeEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  isSolid(tx: number, ty: number) { return blocksMove(tileAt(this.map, tx, ty)); }
}
