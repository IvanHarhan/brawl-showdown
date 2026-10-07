import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Работает и из src/ (tsx), и из собранного dist/index.js.
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '../../maps/showdown1.txt'), resolve(here, '../maps/showdown1.txt'), resolve(process.cwd(), 'maps/showdown1.txt')];

export const MAP_PATH = process.env.MAP_PATH ?? candidates.find((p) => existsSync(p)) ?? candidates[0];
/** Карты для выбора в лобби: id -> файл в той же папке, что showdown1.txt. */
export const MAPS: Record<string, { name: string; file: string }> = {
  desert: { name: 'Пустыня', file: 'showdown1.txt' },
  koeln: { name: 'Кёльн', file: 'koeln.txt' },
};
export const mapFile = (id: string) => resolve(dirname(MAP_PATH), (MAPS[id] ?? MAPS.desert).file);

export const CLIENT_DIST = [resolve(here, '../../client/dist'), resolve(here, '../client/dist')].find((p) => existsSync(p));
