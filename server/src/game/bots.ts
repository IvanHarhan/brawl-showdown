import type { Game, Player } from './Game';
import { Tile, tileAt, lineOfFire } from '../../../shared/map';
import { superAimType, superRange } from '../../../shared/brawlers';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** BFS по клеткам: следующий шаг от (sx,sy) к ближайшей клетке, где goal()=true. */
export function bfsStep(game: Game, sx: number, sy: number, goal: (tx: number, ty: number) => boolean, maxNodes = 4000) {
  const { w, h } = game.map;
  const start = sy * w + sx;
  const prev = new Int32Array(w * h).fill(-2);
  const q = new Int32Array(w * h);
  let qh = 0, qt = 0;
  q[qt++] = start; prev[start] = -1;
  let found = -1;
  while (qh < qt && qh < maxNodes) {
    const cur = q[qh++];
    const cx = cur % w, cy = (cur / w) | 0;
    if (cur !== start && goal(cx, cy)) { found = cur; break; }
    if (cur === start && goal(cx, cy)) { found = cur; break; }
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (prev[ni] !== -2 || game.isSolid(nx, ny)) continue;
      if (dx && dy && (game.isSolid(cx + dx, cy) || game.isSolid(cx, cy + dy))) continue;
      prev[ni] = cur; q[qt++] = ni;
    }
  }
  if (found < 0) return null;
  let node = found, steps = 0;
  const path: number[] = [];
  while (prev[node] >= 0) { path.push(node); node = prev[node]; steps++; }
  path.reverse();
  return { path, target: found, length: steps };
}

type Mode = 'gas' | 'flee' | 'fight' | 'can' | 'box' | 'roam';

export class BotBrain {
  mode: Mode = 'roam';
  moveX = 0; moveY = 0;
  private thinkAcc = Math.random() * 0.1;
  private path: number[] = [];
  private targetSeenAt = 0;
  private targetSlot = -1;
  private strafe = Math.random() < 0.5 ? 1 : -1;
  private strafeUntil = 0;
  private lastPos = { x: 0, y: 0, t: 0 };
  private unstuckUntil = 0;
  private aimError = (Math.random() - 0.5) * 0.1;
  private dodgeX = 0; private dodgeY = 0; private dodgeUntil = 0;
  private nextShotAt = 0;
  private badBoxes = new Map<number, number>();

  constructor(private game: Game, private p: Player) {}

  update(dt: number) {
    const g = this.game, p = this.p;
    this.thinkAcc += dt;
    if (this.thinkAcc >= 0.1) { this.thinkAcc = 0; this.think(); }
    if (g.time < this.unstuckUntil) { g.movePlayer(p, this.moveX, this.moveY, dt); return; }
    if (g.time < this.dodgeUntil) {
      const ml = Math.hypot(this.moveX, this.moveY) || 1;
      g.movePlayer(p, this.dodgeX + (this.moveX / ml) * 0.3, this.dodgeY + (this.moveY / ml) * 0.3, dt);
      return;
    }
    // следуем по пути
    if (this.path.length) {
      const w = g.map.w;
      let node = this.path[0];
      let nx = (node % w) + 0.5, ny = Math.floor(node / w) + 0.5;
      if (Math.hypot(nx - p.x, ny - p.y) < 0.3) {
        this.path.shift();
        if (this.path.length) { node = this.path[0]; nx = (node % w) + 0.5; ny = Math.floor(node / w) + 0.5; }
      }
      if (this.path.length) { this.moveX = nx - p.x; this.moveY = ny - p.y; }
    }
    const len = Math.hypot(this.moveX, this.moveY);
    if (len > 0.05) g.movePlayer(p, this.moveX / len, this.moveY / len, dt);
  }

  private goTo(goal: (tx: number, ty: number) => boolean) {
    const g = this.game, p = this.p;
    const r = bfsStep(g, Math.floor(p.x), Math.floor(p.y), goal);
    if (!r || !r.path.length) { this.path = []; this.moveX = this.moveY = 0; return false; }
    this.path = r.path.slice(0, 6);
    return true;
  }

  private safeTile(tx: number, ty: number, ahead = 4) {
    return !this.game.inGas(tx + 0.5, ty + 0.5, this.game.time + ahead);
  }

  private think() {
    const g = this.game, p = this.p;
    if (!p.alive) return;
    const b = p.brawler;
    const range = b.attack.range;
    const maxHp = g.maxHp(p);

    // застрял — шагнуть в случайную сторону
    if (g.time - this.lastPos.t > 1) {
      const moved = Math.hypot(p.x - this.lastPos.x, p.y - this.lastPos.y);
      if (moved < 0.3 && (this.moveX || this.moveY || this.path.length) && !p.forced) {
        const a = g.rand() * Math.PI * 2;
        this.moveX = Math.cos(a); this.moveY = Math.sin(a);
        this.path = [];
        this.unstuckUntil = g.time + 0.5;
      }
      this.lastPos = { x: p.x, y: p.y, t: g.time };
    }
    if (g.time < this.unstuckUntil) return;

    const enemies = g.players.filter((o) => o.alive && o !== p && !g.hiddenFrom(o, p));
    let nearest: Player | null = null, nd = Infinity;
    for (const o of enemies) {
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < nd) { nd = d; nearest = o; }
    }

    this.checkDodge();

    // кого бить: слабее нас или уже рядом
    let target: Player | null = null, best = Infinity;
    for (const o of enemies) {
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d > 13) continue;
      // в начале катки ломаем ящики, дерёмся только с теми, кто рядом
      if (g.time < 45 && d > 6) continue;
      // первые секунды не нападаем первыми — только отвечаем
      if (g.time < 35 && g.time - p.lastHurt > 1.5) continue;
      const weaker = o.hp <= p.hp * 1.4 || o.cans < p.cans || o.hp < g.maxHp(o) * 0.5;
      if (!weaker && d > range + 1.5) continue;
      const score = d - (weaker ? 4 : 0) + (o.hp / g.maxHp(o)) * 3;
      if (score < best) { best = score; target = o; }
    }

    const outside = g.inGas(p.x, p.y, g.time + 3);
    const lowHp = p.hp < maxHp * 0.3;
    const hurt = p.hp < maxHp * 0.55 && (!nearest || nd > 8);

    if (outside) {
      this.mode = 'gas';
      this.goTo((tx, ty) => this.safeTile(tx, ty, 7) && !g.isSolid(tx, ty));
    } else if (lowHp && nearest && nd < 6.5) {
      this.mode = 'flee';
      const ex = nearest.x, ey = nearest.y;
      this.goTo((tx, ty) => {
        const d = Math.hypot(tx + 0.5 - ex, ty + 0.5 - ey);
        return d > 7 && this.safeTile(tx, ty, 6) && (tileAt(g.map, tx, ty) === Tile.Bush || d > 9);
      });
    } else if (target) {
      this.mode = 'fight';
      this.fight(target);
      return;
    } else if (hurt) {
      // отсидеться в кусте, пока регенится
      this.mode = 'flee';
      if (tileAt(g.map, Math.floor(p.x), Math.floor(p.y)) === Tile.Bush) { this.path = []; this.moveX = this.moveY = 0; }
      else if (!this.goTo((tx, ty) => tileAt(g.map, tx, ty) === Tile.Bush && this.safeTile(tx, ty, 8))) { this.moveX = this.moveY = 0; }
    } else {
      const can = this.nearestCan();
      if (can) {
        this.mode = 'can';
        const cx = Math.floor(can.x), cy = Math.floor(can.y);
        if (Math.hypot(can.x - p.x, can.y - p.y) < 1.2) { this.path = []; this.moveX = can.x - p.x; this.moveY = can.y - p.y; }
        else this.goTo((tx, ty) => tx === cx && ty === cy);
      } else if (this.boxWork(range)) {
        this.mode = 'box';
      } else {
        this.mode = 'roam';
        // охота: идём к ближайшему живому (бот примерно знает, где шумят)
        let prey: Player | null = null, pd = Infinity;
        for (const o of g.players) {
          if (!o.alive || o === p) continue;
          const d = Math.hypot(o.x - p.x, o.y - p.y);
          if (d < pd) { pd = d; prey = o; }
        }
        const c = g.map.w / 2;
        const hunt = prey && g.time > 35;
        const gx = hunt ? prey!.x : c, gy = hunt ? prey!.y : c;
        if (Math.hypot(p.x - gx, p.y - gy) > 5) {
          const tx0 = Math.floor(gx), ty0 = Math.floor(gy);
          this.goTo((tx, ty) => Math.hypot(tx - tx0, ty - ty0) < 4 && this.safeTile(tx, ty, 5));
        } else { this.path = []; this.moveX = Math.cos(g.time) * 0.3; this.moveY = Math.sin(g.time) * 0.3; }
      }
    }

    // по пути отстреливаемся
    if (nearest && nd <= range * 0.95 && (this.mode === 'gas' || this.mode === 'flee')) this.shootAt(nearest, nd, false);
  }

  private nearestCan() {
    const g = this.game, p = this.p;
    let best = null as null | { x: number; y: number }, bd = 13;
    for (const c of g.cans) {
      if (g.inGas(c.x, c.y, g.time + 3)) continue;
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  private boxWork(range: number): boolean {
    const g = this.game, p = this.p;
    let bi = -1, bd = Infinity;
    for (const ti of g.boxHp.keys()) {
      const bx = (ti % g.map.w) + 0.5, by = Math.floor(ti / g.map.w) + 0.5;
      if (g.inGas(bx, by, g.time + 6) || (this.badBoxes.get(ti) ?? 0) > g.time) continue;
      const d = Math.hypot(bx - p.x, by - p.y);
      if (d < bd) { bd = d; bi = ti; }
    }
    if (bi < 0) return false;
    const bx = (bi % g.map.w) + 0.5, by = Math.floor(bi / g.map.w) + 0.5;
    const want = Math.max(1.1, Math.min(range * 0.75, 4));
    const lob = p.brawler.attack.kind === 'lob';
    const clear = lob || this.clearShot(p.x, p.y, bx, by, bi);
    if (bd <= want && clear) {
      // не стоим столбом: пока ждём патроны, ходим вбок вокруг ящика
      this.path = [];
      if (g.time > this.strafeUntil) { this.strafe = -this.strafe; this.strafeUntil = g.time + 0.5 + g.rand() * 0.7; }
      const ux = (bx - p.x) / (bd || 1), uy = (by - p.y) / (bd || 1);
      const back = bd < want * 0.6 ? -0.6 : 0;
      this.moveX = -uy * this.strafe * 0.7 + ux * back;
      this.moveY = ux * this.strafe * 0.7 + uy * back;
      const a = Math.atan2(by - p.y, bx - p.x);
      if (p.ammo >= 1) g.attack(p, a, bd);
    } else {
      const ok = this.goTo((tx, ty) => {
        const d = Math.hypot(tx + 0.5 - bx, ty + 0.5 - by);
        return d <= want && (lob || this.clearShot(tx + 0.5, ty + 0.5, bx, by, bi));
      });
      // к ящику не подойти (за домом/водой) — забываем его на 15 с и берём другой
      if (!ok) { this.badBoxes.set(bi, g.time + 15); return this.boxWork(range); }
    }
    return true;
  }

  /** Линия до ящика не перекрыта ничем, кроме самого ящика. */
  private clearShot(x0: number, y0: number, bx: number, by: number, bi: number) {
    const g = this.game;
    const d = Math.hypot(bx - x0, by - y0);
    const steps = Math.ceil(d / 0.2);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const tx = Math.floor(x0 + (bx - x0) * t), ty = Math.floor(y0 + (by - y0) * t);
      if (ty * g.map.w + tx === bi) return true;
      const tile = tileAt(g.map, tx, ty);
      if (tile === Tile.Wall || tile === Tile.Box) return false;
    }
    return true;
  }

  private fight(t: Player) {
    const g = this.game, p = this.p;
    const b = p.brawler;
    const range = b.attack.range;
    const d = Math.hypot(t.x - p.x, t.y - p.y);
    if (this.targetSlot !== t.slot) { this.targetSlot = t.slot; this.targetSeenAt = g.time; this.aimError = (g.rand() - 0.5) * 0.6; }
    // бутылка летит над стенами — прямая видимость не нужна
    const los = b.attack.kind === 'lob' || lineOfFire(g.map, p.x, p.y, t.x, t.y);
    const melee = range < 3;
    const want = melee ? 0.8 : range * 0.7;

    if (!los || d > want + 0.5) {
      const tx0 = Math.floor(t.x), ty0 = Math.floor(t.y);
      if (!this.goTo((tx, ty) => Math.hypot(tx - tx0, ty - ty0) <= (melee ? 0 : 2) || (Math.hypot(tx + 0.5 - t.x, ty + 0.5 - t.y) < want && lineOfFire(g.map, tx + 0.5, ty + 0.5, t.x, t.y)))) {
        this.moveX = t.x - p.x; this.moveY = t.y - p.y;
      }
    } else {
      // держим дистанцию и стрейфим
      this.path = [];
      if (g.time > this.strafeUntil) { this.strafe = -this.strafe; this.strafeUntil = g.time + 0.3 + g.rand() * 0.6; }
      const ax = (t.x - p.x) / (d || 1), ay = (t.y - p.y) / (d || 1);
      const back = !melee && d < want * 0.6 ? -1 : melee ? 1 : 0;
      this.moveX = -ay * this.strafe + ax * back;
      this.moveY = ax * this.strafe + ay * back;
    }

    if (g.time - this.targetSeenAt < 0.5) return;
    if (p.superCharge >= 1 && this.trySuper(t, d, los)) return;
    if (d <= range * 0.97 && los) this.shootAt(t, d, true);
  }

  /** Уклонение: если чужой снаряд летит в нас — шаг вбок. */
  private checkDodge() {
    const g = this.game, p = this.p;
    if (g.time < this.dodgeUntil || g.rand() < 0.8) return;
    for (const pr of g.projectiles) {
      if (pr.owner === p.slot) continue;
      const rx = p.x - pr.x, ry = p.y - pr.y;
      const along = rx * pr.dx + ry * pr.dy;
      if (along < 0 || along > 5) continue;
      const side = rx * -pr.dy + ry * pr.dx;
      if (Math.abs(side) > 0.9) continue;
      const s = side >= 0 ? 1 : -1;
      this.dodgeX = -pr.dy * s; this.dodgeY = pr.dx * s;
      this.dodgeUntil = g.time + 0.25;
      return;
    }
  }

  private shootAt(t: Player, d: number, lead: boolean) {
    const g = this.game, p = this.p;
    // боты не стреляют на каждом откате: пауза между выстрелами как у живого игрока
    if (p.ammo < 1 || g.time < p.nextAttackAt || g.time < this.nextShotAt) return;
    this.nextShotAt = g.time + 0.7 + g.rand() * 0.7;
    const a = p.brawler.attack;
    const travel = a.kind === 'lob' ? a.flightTime : d / a.speed;
    const lf = lead ? g.rand() * 0.7 : 0;
    const ex = t.x + t.vx * travel * lf, ey = t.y + t.vy * travel * lf;
    const angle = Math.atan2(ey - p.y, ex - p.x) + this.aimError * (0.5 + g.rand());
    g.attack(p, angle, Math.hypot(ex - p.x, ey - p.y));
  }

  private trySuper(t: Player, d: number, los: boolean): boolean {
    const g = this.game, p = this.p;
    const s = p.brawler.super;
    const aim = superAimType(s);
    const angle = Math.atan2(t.y - p.y, t.x - p.x);
    if (aim === 'self') { if (d < 9) return g.superAttack(p, angle, 0); return false; }
    const r = superRange(s);
    if (aim === 'point') { if (d <= r) return g.superAttack(p, angle, d); return false; }
    if (los && d <= r * 0.85) return g.superAttack(p, angle, d);
    return false;
  }
}
