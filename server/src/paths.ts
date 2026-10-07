import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Работает и из src/ (tsx), и из собранного dist/index.js.
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '../../maps/showdown1.txt'), resolve(here, '../maps/showdown1.txt'), resolve(process.cwd(), 'maps/showdown1.txt')];

export const MAP_PATH = process.env.MAP_PATH ?? candidates.find((p) => existsSync(p)) ?? candidates[0];
export const CLIENT_DIST = [resolve(here, '../../client/dist'), resolve(here, '../client/dist')].find((p) => existsSync(p));
