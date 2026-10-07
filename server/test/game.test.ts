import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Game, Player } from '../src/game/Game';
import { BRAWLERS, getBrawler, BurstAttack } from '../../shared/brawlers';
import { Tile, tileAt, parseMap } from '../../shared/map';
import { GAS_DAMAGE, CAN_BONUS, REGEN_DELAY } from '../../shared/constants';

// 24x12, пол; стена в колонке 12 (строки 2..9), ящик, вода, куст
const MAP = [
  '........................',
  '........................',
  '............#...........',
  '............#...........',
  '............#.......X...',
  '..S.........#.......W...',
  '............#....BBB....',
  '............#....BBB....',
  '............#...........',
  '............#...........',
  '........................',
  '........................',
].join('\n');

function setup(ids: string[], opts = {}) {
  const g = new Game(MAP, { seed: 7, gasStart: 1000, ...opts });
  const ps = ids.map((id, i) => g.addPlayer('p' + i, id, false));
  g.start();
  return { g, ps };
}

function place(p: Player, x: number, y: number) { p.x = x; p.y = y; }

function run(g: Game, seconds: number) {
  const n = Math.round(seconds / 0.05);
  for (let i = 0; i < n && !g.ended; i++) g.tick(0.05);
}

describe('урон', () => {
  it('очередь Дрипа наносит урон по прямой', () => {
    const { g, ps: [a, b, c] } = setup(['drip', 'shop', 'shop']);
    place(a, 2, 1); place(b, 7, 1); place(c, 20, 11);
    expect(g.attack(a, 0)).toBe(true);
    run(g, 1);
    const atk = getBrawler('drip').attack as BurstAttack;
    expect(b.hp).toBe(getBrawler('shop').hp - atk.count * atk.damage);
    expect(a.ammo).toBeLessThan(3);
  });

  it('стена блокирует пули, а вода — нет', () => {
    const { g, ps: [a, b, c] } = setup(['drip', 'shop', 'shop']);
    place(a, 9, 5.5); place(b, 15, 5.5); place(c, 1, 11);
    g.attack(a, 0);
    run(g, 1);
    expect(b.hp).toBe(b.brawler.hp);
    // через воду (W в (20,5)) стреляем сверху вниз
    place(a, 20.5, 4.5 - 4); place(b, 20.5, 7.5);
    g.boxHp.clear(); g.map.tiles[4 * 24 + 20] = Tile.Floor;
    a.ammo = 3; a.nextAttackAt = 0;
    g.attack(a, Math.PI / 2);
    run(g, 1);
    expect(b.hp).toBeLessThan(b.brawler.hp);
  });

  it('дробовик бьёт сильнее вблизи', () => {
    const near = setup(['shop', 'iceberg', 'leon']);
    place(near.ps[0], 2, 1); place(near.ps[1], 3.2, 1); place(near.ps[2], 20, 11);
    near.g.attack(near.ps[0], 0); run(near.g, 0.5);
    const far = setup(['shop', 'iceberg', 'leon']);
    place(far.ps[0], 2, 1); place(far.ps[1], 6.2, 1); place(far.ps[2], 20, 11);
    far.g.attack(far.ps[0], 0); run(far.g, 0.5);
    const dNear = near.ps[1].brawler.hp - near.ps[1].hp, dFar = far.ps[1].brawler.hp - far.ps[1].hp;
    expect(dNear).toBeGreaterThan(0);
    expect(dFar).toBeGreaterThan(0);
    expect(dNear).toBeGreaterThan(dFar * 1.5);
  });

  it('регенерация после 3 секунд без боя', () => {
    const { g, ps: [a, b] } = setup(['drip', 'shop']);
    place(a, 2, 11); place(b, 22, 11);
    b.hp = 1000; b.lastCombat = g.time;
    run(g, REGEN_DELAY - 0.2);
    expect(b.hp).toBe(1000);
    run(g, 1);
    expect(b.hp).toBeGreaterThan(1000);
  });

  it('супер заряжается от попаданий', () => {
    const { g, ps: [a, b, c] } = setup(['drip', 'iceberg', 'iceberg']);
    place(a, 2, 1); place(b, 6, 1); place(c, 20, 11);
    g.attack(a, 0); run(g, 1);
    const dealt = b.brawler.hp - b.hp;
    expect(a.superCharge).toBeCloseTo(dealt / a.brawler.superCharge, 5);
  });
});

describe('ящики и банки', () => {
  it('ящик ломается и даёт банку, банка даёт +10% HP и урона', () => {
    const { g, ps: [a, b] } = setup(['drip', 'drip']);
    place(b, 22, 11);
    const ti = 4 * 24 + 20;
    expect(g.boxHp.has(ti)).toBe(true);
    g.damageBox(ti, 99999);
    expect(tileAt(g.map, 20, 4)).toBe(Tile.Floor);
    expect(g.cans.length).toBe(1);
    place(a, 20.5, 4.5);
    run(g, 0.5);
    expect(a.cans).toBe(1);
    expect(g.maxHp(a)).toBe(Math.round(a.brawler.hp * (1 + CAN_BONUS)));
    expect(g.dmgMult(a)).toBeCloseTo(1 + CAN_BONUS);
    // урон вырос на 10%
    place(a, 2, 1); place(b, 7, 1); a.ammo = 3; a.nextAttackAt = 0;
    const before = b.hp;
    g.attack(a, 0); run(g, 1);
    const atk = a.brawler.attack as BurstAttack;
    expect(before - b.hp).toBe(atk.count * Math.round(atk.damage * 1.1));
  });

  it('при смерти банки выпадают на землю', () => {
    const { g, ps: [a, b, c] } = setup(['drip', 'drip', 'drip']);
    place(a, 2, 1); place(b, 6, 1); place(c, 22, 11);
    b.cans = 3;
    g.damagePlayer(b, 999999, a, true);
    expect(b.alive).toBe(false);
    expect(g.cans.length).toBe(3);
    expect(a.kills).toBe(1);
  });
});

describe('газ', () => {
  it('сужается после старта и бьёт каждую секунду', () => {
    const { g, ps: [a, b] } = setup(['shop', 'shop'], { gasStart: 1, gasDuration: 10 });
    place(a, 0.5, 0.5); place(b, 12, 6);
    const full = g.gasHalf();
    run(g, 1);
    expect(g.inGas(a.x, a.y)).toBe(false);
    run(g, 6);
    expect(g.gasHalf()).toBeLessThan(full);
    expect(g.inGas(a.x, a.y)).toBe(true);
    a.hp = 50000;
    const hp = a.hp;
    run(g, 2.05);
    expect(hp - a.hp).toBeGreaterThanOrEqual(GAS_DAMAGE * 2 - 1);
    expect(b.hp).toBe(b.brawler.hp);
  });
});

describe('победа', () => {
  it('последний выживший побеждает, места 1..N', () => {
    const { g, ps } = setup(['drip', 'drip', 'drip', 'drip']);
    ps.forEach((p, i) => place(p, 2 + i * 0.1, 10));
    g.kill(ps[1], ps[0]);
    g.kill(ps[3], ps[0]);
    expect(g.ended).toBe(false);
    g.kill(ps[2], ps[0]);
    run(g, 0.05);
    expect(g.ended).toBe(true);
    const r = g.results();
    expect(r.map((x) => x.place)).toEqual([1, 2, 3, 4]);
    expect(r[0].slot).toBe(0);
    expect(ps[1].place).toBe(4);
  });
});

describe('суперы', () => {
  it('Дрип: длинная очередь ломает стены', () => {
    const { g, ps: [a, b] } = setup(['drip', 'shop']);
    place(a, 9, 4.5); place(b, 15, 4.5);
    a.superCharge = 1;
    expect(g.superAttack(a, 0, 10)).toBe(true);
    run(g, 1.5);
    expect(tileAt(g.map, 12, 4)).toBe(Tile.Floor);
    expect(b.hp).toBeLessThan(b.brawler.hp);
    expect(a.superCharge).toBe(0);
  });

  it('Мистер Пи: табличка перепрыгивает стену', () => {
    const { g, ps: [a, b] } = setup(['mrp', 'drip']);
    place(a, 9, 4.5); place(b, 14.5, 4.5);
    g.attack(a, 0);
    run(g, 1.5);
    expect(b.hp).toBeLessThan(b.brawler.hp);
    expect(tileAt(g.map, 12, 4)).toBe(Tile.Wall);
  });

  it('Мистер Пи: база выпускает помощников, они бьют врага', () => {
    const { g, ps: [a, b] } = setup(['mrp', 'leon']);
    place(a, 2, 1); place(b, 7, 3);
    a.superCharge = 1;
    g.superAttack(a, 0, 3);
    expect(g.minions.filter((m) => m.type === 0).length).toBe(1);
    run(g, 4);
    expect(g.minions.some((m) => m.type === 1)).toBe(true);
    expect(b.hp).toBeLessThan(b.brawler.hp);
  });

  it('Шоп: рывок сносит стены и бьёт врага', () => {
    const { g, ps: [a, b] } = setup(['shop', 'drip']);
    place(a, 10, 3.5); place(b, 14.5, 3.5);
    a.superCharge = 1;
    g.superAttack(a, 0, 8);
    run(g, 1);
    expect(tileAt(g.map, 12, 3)).toBe(Tile.Floor);
    expect(b.hp).toBeLessThan(b.brawler.hp);
  });

  it('Леон: невидим для дальних врагов, виден вблизи', () => {
    const { g, ps: [a, b, c] } = setup(['leon', 'drip', 'drip']);
    place(a, 5, 10); place(b, 5.5, 10); place(c, 15, 10);
    a.superCharge = 1;
    g.superAttack(a, 0, 0);
    expect(g.hiddenFrom(a, c)).toBe(true);
    expect(g.hiddenFrom(a, b)).toBe(false);
    run(g, 6.2);
    expect(g.hiddenFrom(a, c)).toBe(false);
  });

  it('куст прячет игрока дальше 2 клеток', () => {
    const { g, ps: [a, b, c] } = setup(['leon', 'drip', 'drip']);
    place(a, 18.5, 6.5); place(b, 18.5, 8.2); place(c, 18.5, 11);
    expect(g.hiddenFrom(a, c)).toBe(true);
    expect(g.hiddenFrom(a, b)).toBe(false);
  });

  it('Айсберг: прыжок в точку с уроном по области', () => {
    const { g, ps: [a, b] } = setup(['iceberg', 'drip']);
    place(a, 2, 10); place(b, 6, 10);
    a.superCharge = 1;
    g.superAttack(a, 0, 4);
    run(g, 1);
    expect(Math.hypot(a.x - 6, a.y - 10)).toBeLessThan(1);
    expect(b.hp).toBeLessThanOrEqual(b.brawler.hp - (getBrawler('iceberg').super as { damage: number }).damage);
  });

  it('Али: рывок с захватом и броском за спину', () => {
    const { g, ps: [a, b] } = setup(['ali', 'drip']);
    place(a, 4, 10); place(b, 7, 10);
    a.superCharge = 1;
    g.superAttack(a, 0, 6);
    run(g, 1.5);
    expect(b.hp).toBeLessThan(b.brawler.hp);
    expect(b.x).toBeLessThan(a.x);
  });
});

describe('новые бойцы', () => {
  it('Хуссейн: бутылка летит через стену, лужа бьёт несколько раз', () => {
    const { g, ps: [a, b] } = setup(['hussein', 'drip']);
    place(a, 9, 4.5); place(b, 15, 4.5);
    g.attack(a, 0, 6);
    run(g, 0.7);
    expect(g.areas.length).toBe(1);
    const hp1 = b.hp;
    run(g, 1.2);
    expect(b.brawler.hp - b.hp).toBeGreaterThan(0);
    expect(hp1 - b.hp).toBeGreaterThan(0);
    expect(tileAt(g.map, 12, 4)).toBe(Tile.Wall);
  });

  it('Гамас: мяч отскакивает от стены и попадает', () => {
    const { g, ps: [a, b] } = setup(['gamas', 'drip']);
    // стреляем в стену (x=12) под углом, мяч отражается вниз-влево к цели
    place(a, 9, 3.5); place(b, 9.5, 7.5);
    g.attack(a, Math.atan2(2, 2.5), 99);
    run(g, 1.5);
    expect(b.hp).toBeLessThan(b.brawler.hp);
  });

  it('8-Бит: турель усиливает урон рядом и не действует далеко', () => {
    const { g, ps: [a] } = setup(['bit8', 'drip']);
    place(a, 3, 10);
    const base = g.dmgMult(a);
    a.superCharge = 1;
    g.superAttack(a, 0, 0);
    expect(g.minions.some((m) => m.type === 2)).toBe(true);
    expect(g.dmgMult(a)).toBeCloseTo(base * 1.6);
    place(a, 20, 10);
    expect(g.dmgMult(a)).toBeCloseTo(base);
  });
});
describe('карта', () => {
  it('showdown1.txt: 60x60, 10 спавнов, ящики есть', () => {
    const m = parseMap(readFileSync(new URL('../../maps/showdown1.txt', import.meta.url), 'utf8'));
    expect(m.w).toBe(60);
    expect(m.h).toBe(60);
    expect(m.spawns.length).toBe(10);
    expect([...m.tiles].filter((t) => t === Tile.Box).length).toBeGreaterThan(20);
  });

  it('все бойцы описаны полностью', () => {
    expect(BRAWLERS.length).toBe(9);
    for (const b of BRAWLERS) {
      expect(b.hp).toBeGreaterThan(0);
      expect(b.attack.range).toBeGreaterThan(0);
      expect(b.super.kind).toBeTruthy();
    }
  });
});

describe('бой ботов', () => {
  it('10 ботов доигрывают до победителя', () => {
    const text = readFileSync(new URL('../../maps/showdown1.txt', import.meta.url), 'utf8');
    const g = new Game(text, { seed: 3 });
    for (let i = 0; i < 10; i++) g.addPlayer('b' + i, BRAWLERS[i % BRAWLERS.length].id, true);
    g.start();
    while (!g.ended && g.time < 400) g.tick();
    expect(g.ended).toBe(true);
    expect(g.results().filter((r) => r.place === 1).length).toBe(1);
    expect(new Set(g.results().map((r) => r.place)).size).toBe(10);
  });
});
