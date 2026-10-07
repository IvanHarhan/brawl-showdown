// Карта — текст: # стена, B куст, X ящик, W вода, . пол, S спавн.

export enum Tile { Floor = 0, Wall = 1, Bush = 2, Box = 3, Water = 4 }

export interface GameMap {
  w: number;
  h: number;
  tiles: Uint8Array;
  spawns: { x: number; y: number }[];
}

export function parseMap(text: string): GameMap {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0 && !l.startsWith(';'));
  const h = lines.length;
  const w = Math.max(...lines.map((l) => l.length));
  const tiles = new Uint8Array(w * h);
  const spawns: { x: number; y: number }[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = lines[y][x] ?? '.';
      let t = Tile.Floor;
      if (c === '#') t = Tile.Wall;
      else if (c === 'B') t = Tile.Bush;
      else if (c === 'X') t = Tile.Box;
      else if (c === 'W') t = Tile.Water;
      else if (c === 'S') spawns.push({ x: x + 0.5, y: y + 0.5 });
      tiles[y * w + x] = t;
    }
  }
  return { w, h, tiles, spawns };
}

const CHARS = ['.', '#', 'B', 'X', 'W'];

/** Текущее состояние карты обратно в текст (сломанные стены/ящики уже пол). */
export function mapToText(m: GameMap): string {
  const rows: string[] = [];
  for (let y = 0; y < m.h; y++) {
    let r = '';
    for (let x = 0; x < m.w; x++) r += CHARS[m.tiles[y * m.w + x]];
    rows.push(r);
  }
  for (const s of m.spawns) {
    const x = Math.floor(s.x), y = Math.floor(s.y);
    rows[y] = rows[y].slice(0, x) + 'S' + rows[y].slice(x + 1);
  }
  return rows.join('\n');
}

export function tileAt(m: GameMap, tx: number, ty: number): Tile {
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return Tile.Wall;
  return m.tiles[ty * m.w + tx];
}

export function setTile(m: GameMap, tx: number, ty: number, t: Tile) {
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return;
  m.tiles[ty * m.w + tx] = t;
}

export function blocksMove(t: Tile) {
  return t === Tile.Wall || t === Tile.Box || t === Tile.Water;
}

export function blocksShot(t: Tile) {
  return t === Tile.Wall || t === Tile.Box;
}

export function isWalkable(m: GameMap, tx: number, ty: number) {
  return !blocksMove(tileAt(m, tx, ty));
}

/** Есть ли прямая видимость для снаряда между точками. */
export function lineOfFire(m: GameMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(d / 0.2);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (blocksShot(tileAt(m, Math.floor(x0 + (x1 - x0) * t), Math.floor(y0 + (y1 - y0) * t)))) return false;
  }
  return true;
}
