// Простые аккаунты: ник + PIN, статистика, друзья, приглашения в комнату.
// Хранилище: Postgres, если задан DATABASE_URL (данные переживают перезапуск Render),
// иначе JSON-файл (локально; на бесплатном Render сотрётся при перезапуске).
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Application as Express, Request, Response } from 'express';
import { log } from './log';

export interface Account {
  id: string;
  name: string;
  salt: string;
  pinHash: string;
  created: number;
  stats: { games: number; wins: number; kills: number };
  friends: string[];
  requests: string[];   // входящие заявки
  tokens: string[];
}

interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

class FileStore implements Store {
  private data: Record<string, unknown> = {};
  private timer: NodeJS.Timeout | null = null;
  constructor(private file: string) {
    try { if (existsSync(file)) this.data = JSON.parse(readFileSync(file, 'utf8')); } catch { this.data = {}; }
  }
  async get<T>(key: string) { return (this.data[key] as T) ?? null; }
  async set(key: string, value: unknown) { this.data[key] = value; this.flush(); }
  async del(key: string) { delete this.data[key]; this.flush(); }
  private flush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(this.data)); } catch (e) { log('accounts: не удалось записать файл', String(e)); }
    }, 300);
  }
}

class PgStore implements Store {
  private ready: Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private pool: any) {
    this.ready = pool.query('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)');
  }
  async get<T>(key: string) {
    await this.ready;
    const r = await this.pool.query('SELECT v FROM kv WHERE k = $1', [key]);
    return (r.rows[0]?.v as T) ?? null;
  }
  async set(key: string, value: unknown) {
    await this.ready;
    await this.pool.query('INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [key, JSON.stringify(value)]);
  }
  async del(key: string) { await this.ready; await this.pool.query('DELETE FROM kv WHERE k = $1', [key]); }
}

async function makeStore(): Promise<Store> {
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      const pg = await import('pg');
      const pool = new pg.default.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 3 });
      await pool.query('SELECT 1');
      log('accounts: Postgres');
      return new PgStore(pool);
    } catch (e) { log('accounts: Postgres недоступен, беру файл', String(e)); }
  }
  const file = process.env.DATA_FILE ?? resolve(process.cwd(), 'data', 'accounts.json');
  log('accounts: файл', file);
  return new FileStore(file);
}

const storeP = makeStore();
const nameKey = (n: string) => 'name:' + n.trim().toLowerCase();
const hashPin = (pin: string, salt: string) => scryptSync(pin, salt, 32).toString('hex');

// присутствие и приглашения — только в памяти
const lastSeen = new Map<string, number>();
const inRoom = new Map<string, string>();
const invites = new Map<string, { from: string; fromName: string; code: string; at: number }[]>();
const failed = new Map<string, { n: number; until: number }>();

export function setPresenceRoom(id: string | undefined, code: string | null) {
  if (!id) return;
  if (code) inRoom.set(id, code); else inRoom.delete(id);
  lastSeen.set(id, Date.now());
}

export async function accountByToken(token: string | undefined): Promise<Account | null> {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const store = await storeP;
  const id = await store.get<string>('tok:' + token);
  return id ? store.get<Account>('acc:' + id) : null;
}

export async function addGameResult(id: string, won: boolean, kills: number) {
  const store = await storeP;
  const a = await store.get<Account>('acc:' + id);
  if (!a) return;
  a.stats.games++;
  if (won) a.stats.wins++;
  a.stats.kills += kills;
  await store.set('acc:' + id, a);
}

function cleanName(n: unknown) { return String(n ?? '').replace(/[<>]/g, '').trim().slice(0, 14); }

async function profile(a: Account) {
  const store = await storeP;
  const now = Date.now();
  const brief = async (id: string) => {
    const f = await store.get<Account>('acc:' + id);
    return f ? { id, name: f.name, online: now - (lastSeen.get(id) ?? 0) < 15000, room: inRoom.get(id) ?? null, stats: f.stats } : null;
  };
  const friends = (await Promise.all(a.friends.map(brief))).filter(Boolean);
  const requests = (await Promise.all(a.requests.map(brief))).filter(Boolean);
  const inv = (invites.get(a.id) ?? []).filter((i) => now - i.at < 60000);
  invites.delete(a.id);
  return { id: a.id, name: a.name, stats: a.stats, friends, requests, invites: inv };
}

export function mountAccounts(app: Express) {
  // json-парсер только для /api
  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => { try { (req as Request & { body: unknown }).body = body ? JSON.parse(body) : {}; } catch { (req as Request & { body: unknown }).body = {}; } next(); });
  });

  const auth = async (req: Request, res: Response) => {
    const tok = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const a = await accountByToken(tok);
    if (!a) { res.status(401).json({ error: 'Нужно войти' }); return null; }
    lastSeen.set(a.id, Date.now());
    return a;
  };
  const issueToken = async (a: Account) => {
    const store = await storeP;
    const t = randomBytes(24).toString('hex');
    a.tokens = [...a.tokens, t].slice(-5);
    await store.set('acc:' + a.id, a);
    await store.set('tok:' + t, a.id);
    return t;
  };

  app.post('/api/register', async (req, res) => {
    const { name: rawName, pin } = (req as Request & { body: { name?: string; pin?: string } }).body;
    const name = cleanName(rawName);
    if (name.length < 2) { res.status(400).json({ error: 'Ник от 2 символов' }); return; }
    if (!/^\d{4,8}$/.test(String(pin ?? ''))) { res.status(400).json({ error: 'PIN — от 4 до 8 цифр' }); return; }
    const store = await storeP;
    if (await store.get(nameKey(name))) { res.status(409).json({ error: 'Ник занят' }); return; }
    const salt = randomBytes(12).toString('hex');
    const a: Account = { id: randomBytes(8).toString('hex'), name, salt, pinHash: hashPin(String(pin), salt), created: Date.now(), stats: { games: 0, wins: 0, kills: 0 }, friends: [], requests: [], tokens: [] };
    await store.set(nameKey(name), a.id);
    const token = await issueToken(a);
    log(`аккаунт создан: ${name}`);
    res.json({ token, profile: await profile(a) });
  });

  app.post('/api/login', async (req, res) => {
    const { name: rawName, pin } = (req as Request & { body: { name?: string; pin?: string } }).body;
    const name = cleanName(rawName);
    const f = failed.get(name.toLowerCase());
    if (f && f.until > Date.now() && f.n >= 5) { res.status(429).json({ error: 'Слишком много попыток, подожди минуту' }); return; }
    const store = await storeP;
    const id = await store.get<string>(nameKey(name));
    const a = id ? await store.get<Account>('acc:' + id) : null;
    const ok = a && timingSafeEqual(Buffer.from(hashPin(String(pin ?? ''), a.salt), 'hex'), Buffer.from(a.pinHash, 'hex'));
    if (!a || !ok) {
      const cur = failed.get(name.toLowerCase());
      failed.set(name.toLowerCase(), { n: (cur && cur.until > Date.now() ? cur.n : 0) + 1, until: Date.now() + 60000 });
      res.status(401).json({ error: 'Неверный ник или PIN' });
      return;
    }
    failed.delete(name.toLowerCase());
    res.json({ token: await issueToken(a), profile: await profile(a) });
  });

  app.get('/api/me', async (req, res) => {
    const a = await auth(req, res);
    if (a) res.json(await profile(a));
  });

  app.post('/api/friends/add', async (req, res) => {
    const a = await auth(req, res);
    if (!a) return;
    const store = await storeP;
    const name = cleanName((req as Request & { body: { name?: string } }).body.name);
    const id = await store.get<string>(nameKey(name));
    const b = id ? await store.get<Account>('acc:' + id) : null;
    if (!b || b.id === a.id) { res.status(404).json({ error: 'Нет такого игрока' }); return; }
    if (a.friends.includes(b.id)) { res.json(await profile(a)); return; }
    if (a.requests.includes(b.id)) {
      // он уже звал нас — сразу друзья
      a.requests = a.requests.filter((x) => x !== b.id);
      a.friends.push(b.id); b.friends = [...new Set([...b.friends, a.id])];
      await store.set('acc:' + b.id, b);
    } else if (!b.requests.includes(a.id)) {
      b.requests.push(a.id);
      await store.set('acc:' + b.id, b);
    }
    await store.set('acc:' + a.id, a);
    res.json(await profile(a));
  });

  app.post('/api/friends/answer', async (req, res) => {
    const a = await auth(req, res);
    if (!a) return;
    const store = await storeP;
    const { id, accept } = (req as Request & { body: { id?: string; accept?: boolean } }).body;
    if (!id || !a.requests.includes(id)) { res.json(await profile(a)); return; }
    a.requests = a.requests.filter((x) => x !== id);
    const b = await store.get<Account>('acc:' + id);
    if (accept && b) {
      a.friends = [...new Set([...a.friends, id])];
      b.friends = [...new Set([...b.friends, a.id])];
      await store.set('acc:' + b.id, b);
    }
    await store.set('acc:' + a.id, a);
    res.json(await profile(a));
  });

  app.post('/api/friends/remove', async (req, res) => {
    const a = await auth(req, res);
    if (!a) return;
    const store = await storeP;
    const id = String((req as Request & { body: { id?: string } }).body.id ?? '');
    a.friends = a.friends.filter((x) => x !== id);
    const b = await store.get<Account>('acc:' + id);
    if (b) { b.friends = b.friends.filter((x) => x !== a.id); await store.set('acc:' + b.id, b); }
    await store.set('acc:' + a.id, a);
    res.json(await profile(a));
  });

  app.post('/api/invite', async (req, res) => {
    const a = await auth(req, res);
    if (!a) return;
    const { id, code } = (req as Request & { body: { id?: string; code?: string } }).body;
    if (!id || !a.friends.includes(id) || !/^[A-Z]{4}$/.test(String(code))) { res.status(400).json({ error: 'Нельзя пригласить' }); return; }
    const list = invites.get(id) ?? [];
    list.push({ from: a.id, fromName: a.name, code: String(code), at: Date.now() });
    invites.set(id, list.slice(-5));
    res.json({ ok: true });
  });
}
