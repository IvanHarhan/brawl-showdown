// Все характеристики бойцов. Движок читает только эти данные:
// поменяй числа или kind атаки/супера — и боец поменяется без правок кода.
// Единицы: расстояние в клетках, время в секундах, скорость в клетках/с.

export type ProjectileLook = 'bullet' | 'pellet' | 'shuriken' | 'fist' | 'sign' | 'heavy';

/** Очередь снарядов по прямой (Кольт, кулаки). */
export interface BurstAttack {
  kind: 'burst';
  count: number;        // снарядов в очереди
  interval: number;     // пауза между снарядами
  damage: number;       // урон одного снаряда
  range: number;
  speed: number;
  radius: number;       // толщина снаряда
  jitterDeg: number;    // случайный разброс каждого снаряда
  breaksWalls?: boolean;
  look: ProjectileLook;
}

/** Веер снарядов, урон падает с расстоянием (дробовик, сюрикены). */
export interface SpreadAttack {
  kind: 'spread';
  count: number;
  spreadDeg: number;    // общий угол веера
  damage: number;       // урон вблизи
  minFalloff: number;   // множитель урона на максимальной дальности
  range: number;
  speed: number;
  radius: number;
  look: ProjectileLook;
}

/** Снаряд, который при ударе о стену перепрыгивает её и взрывается дальше (табличка Мистера Пи). */
export interface BouncerAttack {
  kind: 'bouncer';
  damage: number;
  range: number;
  speed: number;
  radius: number;
  hopDistance: number;  // сколько летит после стены
  splashRadius: number;
  splashDamage: number;
  look: ProjectileLook;
}

export type Attack = BurstAttack | SpreadAttack | BouncerAttack;

/** База, из которой выбегают помощники. */
export interface BaseSuper {
  kind: 'base';
  range: number;
  hp: number;
  lifetime: number;
  spawnEvery: number;
  maxMinions: number;
  minion: { hp: number; damage: number; speed: number; attackInterval: number; sight: number };
}

/** Рывок по прямой (Булл). */
export interface ChargeSuper {
  kind: 'charge';
  range: number;
  speed: number;
  damage: number;
  knockback: number;
  breaksWalls: boolean;
}

/** Невидимость (Леон). */
export interface InvisibleSuper { kind: 'invisible'; duration: number }

/** Прыжок в точку с уроном по области (Эль Примо). */
export interface JumpSuper {
  kind: 'jump';
  range: number;
  airTime: number;
  radius: number;
  damage: number;
  breaksWalls: boolean;
}

/** Рывок с захватом и броском врага за спину. */
export interface GrabSuper {
  kind: 'grab';
  range: number;
  speed: number;
  damage: number;
  throwDistance: number;
  stun: number;
}

export type Super = (BurstAttack & { aim?: 'line' }) | BaseSuper | ChargeSuper | InvisibleSuper | JumpSuper | GrabSuper;

export interface Brawler {
  id: string;           // имя модели assets/models/<id>.glb и папки assets/voice/<id>/
  name: string;
  color: string;        // цвет в меню
  hp: number;
  speed: number;
  ammo: number;         // ячеек патронов
  reload: number;       // секунд на одну ячейку
  cooldown: number;     // минимальная пауза между атаками
  superCharge: number;  // сколько урона нужно нанести, чтобы зарядить супер
  attack: Attack;
  super: Super;
}

// Цифры близки к базовым (1-й уровень) бойцам Brawl Stars: скорость 2.4 кл/с — «обычная»,
// перезарядка ~1.6 с, снаряды 8–12 кл/с, пауза между атаками ~0.5 с.
export const BRAWLERS: Brawler[] = [
  {
    id: 'drip', name: 'Дрип', color: '#ffb02e',
    hp: 2800, speed: 2.4, ammo: 3, reload: 1.6, cooldown: 0.5, superCharge: 3000,
    attack: { kind: 'burst', count: 6, interval: 0.1, damage: 360, range: 9.3, speed: 12, radius: 0.13, jitterDeg: 2, look: 'bullet' },
    super: { kind: 'burst', count: 12, interval: 0.08, damage: 320, range: 12, speed: 13, radius: 0.17, jitterDeg: 2, breaksWalls: true, look: 'heavy' },
  },
  {
    id: 'mrp', name: 'Мистер Пи', color: '#e9e9e9',
    hp: 3200, speed: 2.4, ammo: 3, reload: 1.6, cooldown: 0.5, superCharge: 2200,
    attack: { kind: 'bouncer', damage: 760, range: 7.7, speed: 8, radius: 0.3, hopDistance: 2.5, splashRadius: 1.3, splashDamage: 600, look: 'sign' },
    super: { kind: 'base', range: 6, hp: 2600, lifetime: 40, spawnEvery: 4, maxMinions: 2,
      minion: { hp: 1000, damage: 260, speed: 2.9, attackInterval: 0.8, sight: 9 } },
  },
  {
    id: 'bubu', name: 'Бу-бу', color: '#4a7dff',
    hp: 5000, speed: 2.4, ammo: 3, reload: 1.6, cooldown: 0.5, superCharge: 2600,
    attack: { kind: 'spread', count: 5, spreadDeg: 30, damage: 400, minFalloff: 0.35, range: 5, speed: 11, radius: 0.16, look: 'pellet' },
    super: { kind: 'charge', range: 9, speed: 8, damage: 800, knockback: 2, breaksWalls: true },
  },
  {
    id: 'leon', name: 'Леон', color: '#7fbf4a',
    hp: 3200, speed: 2.75, ammo: 3, reload: 1.9, cooldown: 0.5, superCharge: 2600,
    attack: { kind: 'spread', count: 4, spreadDeg: 26, damage: 480, minFalloff: 0.55, range: 9.7, speed: 12, radius: 0.16, look: 'shuriken' },
    super: { kind: 'invisible', duration: 6 },
  },
  {
    id: 'iceberg', name: 'Айсберг', color: '#33c3d6',
    hp: 6000, speed: 2.55, ammo: 3, reload: 1.1, cooldown: 0.5, superCharge: 2400,
    attack: { kind: 'burst', count: 4, interval: 0.12, damage: 300, range: 3, speed: 14, radius: 0.45, jitterDeg: 6, look: 'fist' },
    super: { kind: 'jump', range: 7, airTime: 0.8, radius: 1.9, damage: 800, breaksWalls: false },
  },
  {
    id: 'ali', name: 'Али', color: '#c0392b',
    hp: 5800, speed: 2.4, ammo: 3, reload: 1.3, cooldown: 0.55, superCharge: 2400,
    attack: { kind: 'burst', count: 3, interval: 0.17, damage: 440, range: 3, speed: 13, radius: 0.48, jitterDeg: 5, look: 'fist' },
    super: { kind: 'grab', range: 6, speed: 9, damage: 700, throwDistance: 3.5, stun: 0.4 },
  },
];
export const BRAWLER_BY_ID: Record<string, Brawler> = Object.fromEntries(BRAWLERS.map((b) => [b.id, b]));

export function getBrawler(id: string | undefined): Brawler {
  return (id && BRAWLER_BY_ID[id]) || BRAWLERS[0];
}

/** Как целиться суперу: линия, точка на земле или без прицела. */
export function superAimType(s: Super): 'line' | 'point' | 'self' {
  if (s.kind === 'base' || s.kind === 'jump') return 'point';
  if (s.kind === 'invisible') return 'self';
  return 'line';
}

export function superRange(s: Super): number {
  return s.kind === 'invisible' ? 0 : s.range;
}

export function attackRange(a: Attack): number {
  return a.range;
}
