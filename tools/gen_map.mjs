// Однократно собирает maps/showdown1.txt (60x60): четверть карты зеркалится в 4 стороны,
// 10 спавнов по кругу, у каждого спавна ящик. Дальше карту можно править руками.
// node tools/gen_map.mjs
import { writeFileSync } from 'node:fs';

const Q = [
  '..............................',
  '.BBBB.........###.............',
  '.BBBB.........#...............',
  '.BBB....X.....#.......BBB.....',
  '..............#.......BBB.....',
  '......................BB......',
  '....####..........X...........',
  '....#.......WWW...............',
  '....#..X....WWW.....###.......',
  '............WWW.....#.........',
  '...........................BB.',
  '.WW......BBB.........X.....BB.',
  '.WW......BBB...............BB.',
  '.WW......BB.....##............',
  '................#.....BBBB....',
  '..X.....###.....#.....BBBB....',
  '........#.............BB......',
  '........#..X..................',
  '...BB.............###.....X...',
  '...BB.................#.......',
  '...BB...WW.....X.......#......',
  '........WW................BB..',
  '.....##...........BBB.....BB..',
  '.....#............BBB.........',
  '.....#....X.......B......##...',
  '...............##.............',
  '..BBB..........#.....X........',
  '..BBB..........#..........BB..',
  '......................#...BB..',
  '...........X..........#.......',
];
Q.forEach((r, i) => { if (r.length !== 30) throw new Error(`row ${i} has ${r.length}`); });

const top = Q.map((r) => r + [...r].reverse().join(''));
const rows = [...top, ...[...top].reverse()].map((r) => [...r]);
const N = rows.length, C = N / 2;
const R = 24;

for (let i = 0; i < 10; i++) {
  const a = (i / 10) * Math.PI * 2 - Math.PI / 2 + Math.PI / 10;
  const sx = Math.round(C - 0.5 + Math.cos(a) * R), sy = Math.round(C - 0.5 + Math.sin(a) * R);
  for (let y = sy - 1; y <= sy + 1; y++) for (let x = sx - 1; x <= sx + 1; x++) if (rows[y]?.[x] !== undefined) rows[y][x] = '.';
  rows[sy][sx] = 'S';
  // два ящика между спавном и центром
  for (const k of [3, 6]) {
    const bx = Math.round(sx + (C - 0.5 - sx) / R * k + (k === 6 ? Math.sin(a) * 1.5 : 0));
    const by = Math.round(sy + (C - 0.5 - sy) / R * k - (k === 6 ? Math.cos(a) * 1.5 : 0));
    if (rows[by][bx] === '.' || rows[by][bx] === 'B') rows[by][bx] = 'X';
  }
}

writeFileSync(new URL('../maps/showdown1.txt', import.meta.url), rows.map((r) => r.join('')).join('\n') + '\n');
console.log(rows.map((r) => r.join('')).join('\n'));
