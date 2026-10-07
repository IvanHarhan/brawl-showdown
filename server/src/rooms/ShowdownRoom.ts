import { Room, Client } from '@colyseus/core';
import { readFileSync } from 'node:fs';
import { Game, Player } from '../game/Game';
import { BRAWLERS, getBrawler } from '../../../shared/brawlers';
import { MAX_PLAYERS, RECONNECT_SECONDS, TICK_DT } from '../../../shared/constants';
import type { InputItem, LobbyMsg, JoinOptions } from '../../../shared/protocol';
import { MAP_PATH } from '../paths';

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

    this.setSimulationInterval(() => this.update(), TICK_DT * 1000);
  }

  onJoin(client: Client, options: JoinOptions) {
    if (this.phase !== 'lobby') throw new Error('Игра уже идёт');
    this.members.push({ sid: client.sessionId, name: cleanName(options?.name), brawler: getBrawler(options?.brawler).id, connected: true, client });
    if (!this.host) this.host = client.sessionId;
    this.sendLobby();
  }

  async onDrop(client: Client) {
    const m = this.member(client.sessionId);
    if (m) { m.connected = false; m.client = null; }
    const p = this.bySid.get(client.sessionId);
    if (p) p.connected = false;
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
    this.members = this.members.filter((m) => m.sid !== client.sessionId);
    if (this.host === client.sessionId) this.host = this.members.find((m) => m.connected)?.sid ?? this.members[0]?.sid ?? '';
    this.sendLobby();
  }

  onDispose() {
    usedCodes.delete(this.roomId);
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
    g.tick(TICK_DT);
    const ev = g.takeEvents();
    for (const c of this.clients) {
      const p = this.bySid.get(c.sessionId) ?? null;
      c.send('s', g.snapshotFor(p, ev));
    }
    if (g.ended) {
      this.phase = 'ended';
      this.broadcast('end', { results: g.results() });
      this.sendLobby();
    }
  }
}
