import { Client, Room } from '@colyseus/sdk';
import type { JoinOptions } from '../../shared/protocol';
import { RECONNECT_SECONDS } from '../../shared/constants';

function defaultServer() {
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (env) return env.replace(/\/$/, '');
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q.replace(/\/$/, '');
  // vite dev (5173) / preview (4173) -> локальный сервер на 2567, иначе тот же адрес
  if (location.port === '5173' || location.port === '4173') return `${location.protocol}//${location.hostname}:2567`;
  return location.origin;
}

export const SERVER_URL = defaultServer();
const TOKEN_KEY = 'brawl_reconnect';

export class Net {
  client = new Client(SERVER_URL);
  room: Room | null = null;

  /** Ждём, пока Render-сервер проснётся. */
  async wake(onWait: (attempt: number) => void, signal?: { cancelled: boolean }) {
    for (let attempt = 0; ; attempt++) {
      if (signal?.cancelled) return false;
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), attempt === 0 ? 2500 : 6000);
        const r = await fetch(`${SERVER_URL}/health`, { signal: ctl.signal, cache: 'no-store' });
        clearTimeout(t);
        if (r.ok) return true;
      } catch { /* спит */ }
      onWait(attempt);
      await new Promise((r) => setTimeout(r, attempt === 0 ? 300 : 2000));
    }
  }

  async create(opts: JoinOptions) { return this.bind(await this.client.create('showdown', opts)); }
  async join(code: string, opts: JoinOptions) { return this.bind(await this.client.joinById(code.trim().toUpperCase(), opts)); }

  async reconnectSaved(): Promise<Room | null> {
    const saved = Net.saved();
    if (!saved) return null;
    try { return this.bind(await this.client.reconnect(saved.token)); } catch { Net.clearSaved(); return null; }
  }

  private bind(room: Room) {
    this.room = room;
    this.save();
    return room;
  }

  save() {
    if (!this.room) return;
    try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: this.room.reconnectionToken, code: this.room.roomId, at: Date.now() })); } catch { /* приватный режим */ }
  }

  static saved(): { token: string; code: string; at: number } | null {
    try {
      const s = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null');
      if (s && Date.now() - s.at < RECONNECT_SECONDS * 1000) return s;
    } catch { /* */ }
    return null;
  }

  static clearSaved() { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* */ } }

  async leave() {
    Net.clearSaved();
    const r = this.room;
    this.room = null;
    if (r) { r.removeAllListeners(); try { await r.leave(true); } catch { /* */ } }
  }
}
