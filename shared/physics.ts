// Движение круга по сетке. Один и тот же код у клиента (prediction) и сервера.
import { GameMap, blocksMove, tileAt } from './map';
import { PLAYER_RADIUS } from './constants';

export interface Vec { x: number; y: number }

function pushOut(m: GameMap, p: Vec, r: number, solid: (tx: number, ty: number) => boolean) {
  const minX = Math.floor(p.x - r), maxX = Math.floor(p.x + r);
  const minY = Math.floor(p.y - r), maxY = Math.floor(p.y + r);
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      if (!solid(tx, ty)) continue;
      const cx = Math.max(tx, Math.min(p.x, tx + 1));
      const cy = Math.max(ty, Math.min(p.y, ty + 1));
      let dx = p.x - cx, dy = p.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * r;
        p.y = cy + (dy / d) * r;
      } else {
        // центр внутри клетки — выталкиваем по кратчайшей оси
        const left = p.x - tx, right = tx + 1 - p.x, up = p.y - ty, down = ty + 1 - p.y;
        const mn = Math.min(left, right, up, down);
        if (mn === left) p.x = tx - r; else if (mn === right) p.x = tx + 1 + r;
        else if (mn === up) p.y = ty - r; else p.y = ty + 1 + r;
      }
    }
  }
}

/** Сдвинуть круг на (dx,dy) со скольжением вдоль стен. Мутирует p. */
export function moveCircle(m: GameMap, p: Vec, dx: number, dy: number, r = PLAYER_RADIUS,
  solid: (tx: number, ty: number) => boolean = (tx, ty) => blocksMove(tileAt(m, tx, ty))) {
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / 0.15));
  const sx = dx / steps, sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    p.x += sx;
    pushOut(m, p, r, solid);
    p.y += sy;
    pushOut(m, p, r, solid);
  }
  p.x = Math.min(m.w - r, Math.max(r, p.x));
  p.y = Math.min(m.h - r, Math.max(r, p.y));
}

/** Шаг игрока по вводу. mx,my — направление стика (длина ≤ 1). */
export function stepPlayer(m: GameMap, p: Vec, mx: number, my: number, speed: number, dt: number) {
  const len = Math.hypot(mx, my);
  if (len < 0.15) return;
  const k = (speed * dt) / len;
  moveCircle(m, p, mx * k, my * k);
}

export function clampInput(mx: number, my: number): [number, number] {
  if (!Number.isFinite(mx) || !Number.isFinite(my)) return [0, 0];
  const len = Math.hypot(mx, my);
  if (len > 1) return [mx / len, my / len];
  return [mx, my];
}

/** Ближайшая проходимая клетка к точке (для прыжков и бросков). */
export function nearestWalkable(m: GameMap, x: number, y: number): Vec {
  const tx0 = Math.floor(x), ty0 = Math.floor(y);
  for (let rad = 0; rad < 6; rad++) {
    let best: Vec | null = null, bd = Infinity;
    for (let ty = ty0 - rad; ty <= ty0 + rad; ty++) {
      for (let tx = tx0 - rad; tx <= tx0 + rad; tx++) {
        if (Math.max(Math.abs(tx - tx0), Math.abs(ty - ty0)) !== rad) continue;
        if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h || blocksMove(tileAt(m, tx, ty))) continue;
        const cx = rad === 0 ? x : tx + 0.5, cy = rad === 0 ? y : ty + 0.5;
        const d = (cx - x) ** 2 + (cy - y) ** 2;
        if (d < bd) { bd = d; best = { x: cx, y: cy }; }
      }
    }
    if (best) {
      const p = { ...best };
      pushOut(m, p, PLAYER_RADIUS, (tx, ty) => blocksMove(tileAt(m, tx, ty)));
      return p;
    }
  }
  return { x, y };
}
