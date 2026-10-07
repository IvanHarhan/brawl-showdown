// Формат сообщений клиент <-> сервер. Числа координат передаются ×100 (целые).

export const LOOKS = ['bullet', 'pellet', 'shuriken', 'fist', 'sign', 'heavy'] as const;

/** Клиент -> сервер */
export type InputItem = [seq: number, mx: number, my: number, dt: number];
export interface AttackMsg { a: number }            // угол (рад)
export interface SuperMsg { a: number; d: number }  // угол и дистанция до точки
export interface JoinOptions { name: string; brawler: string; fast?: boolean }

/** Флаги игрока в снапшоте */
export const F_ALIVE = 1, F_BUSH = 2, F_INVIS = 4, F_LOCKED = 8, F_AIR = 16, F_STUN = 32, F_OFFLINE = 64, F_REVEALED = 128;

/** [slot, x, y, hp, maxHp, cans, ammo×100, super×100, flags, facing×100] */
export type PlayerSnap = [number, number, number, number, number, number, number, number, number, number];
/** [id, lookIndex, x, y, angle×100, speed×10, ownerSlot] */
export type ProjSnap = [number, number, number, number, number, number, number];
/** [id, type(0 база, 1 помощник), x, y, hp, maxHp, ownerSlot, facing×100] */
export type MinionSnap = [number, number, number, number, number, number, number, number];
/** [id, x, y] */
export type CanSnap = [number, number, number];

/** События тика. Первый элемент — тип. */
export type GameEvent =
  | ['shot', number, number, number]           // slot, angle×100, isSuper(0/1)
  | ['hit', number, number, number, number, number]    // x, y, dmg, targetSlot(-1 если не игрок), угол удара×100 (9999 — нет)
  | ['box', number, number]                    // tileIndex, hp
  | ['tile', number, number]                   // tileIndex, newTile
  | ['die', number, number, number]            // slot, place, killerSlot(-1)
  | ['can', number]                            // slot подобрал банку
  | ['super', number]                          // slot применил супер
  | ['boom', number, number, number]           // x, y, radius×100 (взрыв/приземление)
  | ['gas', number];                           // slot получил урон газом

export interface Snapshot {
  t: number;          // номер тика
  ack: number;        // последний обработанный seq ввода этого клиента
  el: number;         // секунд с начала боя ×10
  gas: number;        // половина стороны безопасного квадрата ×100
  alive: number;
  p: PlayerSnap[];
  pr: ProjSnap[];
  mn: MinionSnap[];
  c: CanSnap[];
  ev: GameEvent[];
}

export interface RosterEntry { slot: number; name: string; brawler: string; bot: boolean; sid: string }

export interface StartMsg {
  map: string;        // текущее состояние карты текстом
  boxes: [number, number][];  // tileIndex, hp
  roster: RosterEntry[];
  you: number;        // твой slot
  t: number;
  gasStart: number;
  gasDuration: number;
}

export interface LobbyPlayer { sid: string; name: string; brawler: string; connected: boolean }
export interface LobbyMsg { code: string; host: string; phase: 'lobby' | 'playing' | 'ended'; players: LobbyPlayer[] }

export interface ResultEntry { slot: number; name: string; brawler: string; place: number; bot: boolean; kills: number }
export interface EndMsg { results: ResultEntry[] }
