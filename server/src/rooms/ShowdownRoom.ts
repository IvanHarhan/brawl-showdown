import { Room, Client } from '@colyseus/core';
import { readFileSync } from 'node:fs';
import { Game, Player } from '../game/Game';
import { BRAWLERS, getBrawler } from '../../../shared/brawlers';
import { MAX_PLAYERS, RECONNECT_SECONDS, TICK_DT } from '../../../shared/constants';
import type { InputItem, LobbyMsg, JoinOptions } from '../../../shared/protocol';
import { MAP_PATH } from '../paths';
import { log, liveRooms } from '../log';

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const usedCodes = new Set<string>();

function makeCode() {
  for (let i = 0; i < 1000; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    if (!usedCodes.has(c)) { usedCodes.add(c); return c; }
  }
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

const BOT_NAMES = ['Бот Шуша', 'Бот Кекс', 'Бот Гоша', 'Бот Пельмень', 'Бот Чика', 'Бот Зубр', 'Бот Кефир', 'Бот Шнур', 'Бот Пиксель', 'Бот Батон'];

interface Member { sid: string; name: string; brawler: string; connected: boolean; client: Client | null }

function cleanName(n: unknown) {
  const s = String(n ?? '').replace(/[<>]/g, '').trim().slice(0, 14);
  return s || 'Игрок';
}

export class ShowdownRoom extends Room {
  maxClients = MAX_PLAYERS;
  phase: 'lobby' | 'playing' | 'ended' = 'lobby';
  members: Member[] = [];
  host = '';
  game: Game | null = null;
  fast = false;
  private bySid = new Map<string, Player>();
  // сетевая статистика: пинг, который меряет сервер, и то, что прислал клиент
  private net = new Map<string, { name: string; rtt: number[]; cping: number; fps: number }>();
  private tickMs: number[] = [];
  private tickGap: number[] = [];
  private lastTickAt = 0;
  private createdAt = Date.now();

  onCreate(options: JoinOptions) {
    this.roomId = makeCode();
    this.fast = !!options?.fast;
    this.setPatchRate(null);
    this.autoDispose = true;

    this.onMessage('pick', (client, msg: { brawler?: string; name?: string }) => {
      const m = this.member(client.sessionId);
      if (!m || this.phase === 'playing') return;
      if (msg?.brawler && BRAWLERS.some((b) => b.id === msg.brawler)) m.brawler = msg.brawler;
      if (msg?.name !== undefined) m.name = cleanName(msg.name);
      this.sendLobby();
    });
    this.onMessage('start', (client) => {
      if (client.sessionId !== this.host || this.phase !== 'lobby') return;
      this.startGame();
    });
    this.onMessage('again', (client) => {
      if (client.sessionId !== this.host || this.phase !== 'ended') return;
      this.toLobby();
    });
    this.onMessage('in', (client, items: InputItem[]) => {
      const p = this.bySid.get(client.sessionId);
      if (p && this.game && !p.bot) this.game.queueInputs(p, items);
    });
    this.onMessage('atk', (client, msg: { a: number }) => {
      const p = this.bySid.get(client.sessionId);
      if (p && this.game && !p.bot) { this.game.queueAttack(p, +msg?.a); this.game.processNow(p); }
    });
    this.onMessage('sup', (client, msg: { a: number; d: number }) => {
      const p = this.bySid.get(client.sessionId);
      if (p && this.game && !p.bot) { this.game.queueSuper(p, +msg?.a, +msg?.d); this.game.processNow(p); }
    });
    this.onMessage('ping', (client, t: number) => client.send('pong', t));
    this.onMessage('spr', (client, t: number) => {
      const n = this.net.get(client.sessionId);
      if (n && Number.isFinite(t)) { n.rtt.push(Date.now() - t); if (n.rtt.length > 15) n.rtt.shift(); }
    });
    this.onMessage('cst', (client, s: { ping?: number; fps?: number }) => {
      const n = this.net.get(client.sessionId);
      if (n) { n.cping = Math.round(+(s?.ping ?? 0)); n.fps = Math.round(+(s?.fps ?? 0)); }
    });

    this.setSimulationInterval(() => this.update(), TICK_DT * 1000);
    this.clock.setInterval(() => { for (const c of this.clients) c.send('sp', Date.now()); }, 2000);
    this.clock.setInterval(() => this.logStats(), 10000);
    liveRooms.add(this);
    log(`[${this.roomId}] создана${this.fast ? ' (fast)' : ''}`);
  }

  onJoin(client: Client, options: JoinOptions) {
    if (this.phase !== 'lobby') throw new Error('Игра уже идёт');
    this.members.push({ sid: client.sessionId, name: cleanName(options?.name), brawler: getBrawler(options?.brawler).id, connected: true, client });
    if (!this.host) this.host = client.sessionId;
    this.net.set(client.sessionId, { name: cleanName(options?.name), rtt: [], cping: 0, fps: 0 });
    log(`[${this.roomId}] вход ${cleanName(options?.name)} [${String(options?.dev ?? '?').slice(0, 40)}] (${this.members.length} чел.)`);
    this.sendLobby();
  }

  async onDrop(client: Client) {
    const m = this.member(client.sessionId);
    if (m) { m.connected = false; m.client = null; }
    const p = this.bySid.get(client.sessionId);
    if (p) p.connected = false;
    log(`[${this.roomId}] обрыв связи ${m?.name ?? client.sessionId}`);
    this.sendLobby();
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch { /* не вернулся — onLeave */ }
  }

  onReconnect(client: Client) {
    const m = this.member(client.sessionId);
    if (m) { m.connected = true; m.client = client; }
    const p = this.bySid.get(client.sessionId);
    if (p) p.connected = true;
    log(`[${this.roomId}] переподключился ${m?.name ?? client.sessionId}`);
    this.sendLobby();
    if (this.game && p && this.phase === 'playing') client.send('start', this.game.startMsg(p.slot));
    if (this.phase === 'ended' && this.game) client.send('end', { results: this.game.results() });
  }

  onLeave(client: Client) {
    const p = this.bySid.get(client.sessionId);
    if (p && this.game) {
      p.connected = false;
      if (p.alive && this.phase === 'playing') this.game.makeBot(p);
    }
    log(`[${this.roomId}] вышел ${this.member(client.sessionId)?.name ?? client.sessionId}`);
    this.net.delete(client.sessionId);
    this.members = this.members.filter((m) => m.sid !== client.sessionId);
    if (this.host === client.sessionId) this.host = this.members.find((m) => m.connected)?.sid ?? this.members[0]?.sid ?? '';
    this.sendLobby();
  }

  onDispose() {
    usedCodes.delete(this.roomId);
    liveRooms.delete(this);
    log(`[${this.roomId}] закрыта`);
  }

  private member(sid: string) { return this.members.find((m) => m.sid === sid); }

  private lobbyMsg(): LobbyMsg {
    return {
      code: this.roomId, host: this.host, phase: this.phase,
      players: this.members.map((m) => ({ sid: m.sid, name: m.name, brawler: m.brawler, connected: m.connected })),
    };
  }

  private sendLobby() { this.broadcast('lobby', this.lobbyMsg()); }

  startGame() {
    const mapText = readFileSync(MAP_PATH, 'utf8');
    const game = new Game(mapText, this.fast ? { gasStart: 8, gasDuration: 45 } : {});
    this.bySid.clear();
    const order = [...this.members].sort(() => Math.random() - 0.5);
    for (const m of order) this.bySid.set(m.sid, game.addPlayer(m.name, m.brawler, false, m.sid));
    let bi = 0;
    while (game.players.length < MAX_PLAYERS) {
      const b = BRAWLERS[Math.floor(Math.random() * BRAWLERS.length)];
      game.addPlayer(BOT_NAMES[bi++ % BOT_NAMES.length], b.id, true);
    }
    for (const m of this.members) {
      const p = this.bySid.get(m.sid)!;
      if (!m.connected) p.connected = false;
    }
    game.start();
    this.game = game;
    log(`[${this.roomId}] старт: ${this.members.map((m) => m.name + '/' + m.brawler).join(', ')} + ${MAX_PLAYERS - this.members.length} ботов`);
    this.phase = 'playing';
    this.lock();
    this.sendLobby();
    for (const c of this.clients) {
      const p = this.bySid.get(c.sessionId);
      if (p) c.send('start', game.startMsg(p.slot));
    }
  }

  private toLobby() {
    this.phase = 'lobby';
    this.game = null;
    this.bySid.clear();
    this.unlock();
    this.sendLobby();
  }

  private update() {
    const g = this.game;
    if (!g || this.phase !== 'playing') return;
    const t0 = performance.now();
    if (this.lastTickAt) { this.tickGap.push(t0 - this.lastTickAt); if (this.tickGap.length > 300) this.tickGap.shift(); }
    this.lastTickAt = t0;
    g.tick(TICK_DT);
    const ev = g.takeEvents();
    for (const c of this.clients) {
      const p = this.bySid.get(c.sessionId) ?? null;
      c.send('s', g.snapshotFor(p, ev));
    }
    this.tickMs.push(performance.now() - t0);
    if (this.tickMs.length > 300) this.tickMs.shift();
    if (g.ended) {
      this.phase = 'ended';
      const res = g.results();
      log(`[${this.roomId}] конец, ${g.time.toFixed(0)} с, победил ${res[0]?.name} (${res[0]?.brawler})`);
      this.broadcast('end', { results: res });
      this.sendLobby();
    }
  }

  stats() {
    const avg = (a: number[]) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : 0);
    const max = (a: number[]) => (a.length ? Math.round(Math.max(...a) * 10) / 10 : 0);
    return {
      code: this.roomId, phase: this.phase, ageSec: Math.round((Date.now() - this.createdAt) / 1000),
      gameTime: this.game ? Math.round(this.game.time) : 0, alive: this.game?.aliveCount() ?? 0,
      tick: { avgMs: avg(this.tickMs), maxMs: max(this.tickMs), gapAvg: avg(this.tickGap), gapMax: max(this.tickGap) },
      players: [...this.net.entries()].map(([sid, n]) => ({
        name: n.name, connected: this.member(sid)?.connected ?? false,
        rttAvg: avg(n.rtt), rttMax: max(n.rtt), clientPing: n.cping, fps: n.fps,
      })),
    };
  }

  private logStats() {
    if (!this.clients.length) return;
    const s = this.stats();
    const ps = s.players.map((p) => `${p.name}: ${p.rttAvg}/${p.rttMax} мс, у клиента ${p.clientPing} мс, ${p.fps} fps`).join('; ');
    log(`[${this.roomId}] ${s.phase} t=${s.gameTime} живых ${s.alive} | тик ${s.tick.avgMs}/${s.tick.maxMs} мс, интервал ${s.tick.gapAvg}/${s.tick.gapMax} | ${ps}`);
  }
}