export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
export const MAX_PLAYERS = 10;

export const PLAYER_RADIUS = 0.38;
export const REGEN_DELAY = 3;          // сек без стрельбы и урона до начала регенерации
export const REGEN_RATE = 0.14;        // доля maxHp в секунду
export const CAN_BONUS = 0.1;          // +10% HP и урона за банку
export const CAN_PICKUP_RADIUS = 0.65;
export const BOX_HP = 3000;
export const BUSH_REVEAL_DIST = 2;     // в кустах видно только ближе этого
export const REVEAL_AFTER_SHOT = 0.8;  // сколько секунд стрелявший из куста виден

export const GAS_START = 30;           // сек от старта
export const GAS_DURATION = 150;       // за сколько секунд зона сжимается до минимума
export const GAS_MIN_HALF = 3.5;       // половина стороны безопасного квадрата в конце
export const GAS_DAMAGE = 1000;        // урон в секунду

export const RECONNECT_SECONDS = 20;
export const INTERP_DELAY_MS = 70;
