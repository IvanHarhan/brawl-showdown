// Аккаунт (ник + PIN), друзья и приглашения. Сервер — /api (см. server/src/accounts.ts).
import { SERVER_URL } from './net';

export interface Friend { id: string; name: string; online: boolean; room: string | null; stats: Stats }
export interface Stats { games: number; wins: number; kills: number }
export interface Profile {
  id: string; name: string; stats: Stats;
  friends: Friend[]; requests: Friend[];
  invites: { fromName: string; code: string }[];
}

const KEY = 'brawl_token';

export class Account {
  token: string | null = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  profile: Profile | null = null;
  onChange: () => void = () => {};
  onInvite: (from: string, code: string) => void = () => {};
  private timer = 0;

  constructor() {
    if (this.token) this.refresh();
    this.timer = window.setInterval(() => { if (this.token) this.refresh(); }, 5000);
  }

  async api<T = Profile>(path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${SERVER_URL}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 && path === '/me') this.logout();
      throw new Error((j as { error?: string }).error ?? `Ошибка ${r.status}`);
    }
    return j as T;
  }

  private set(p: Profile) {
    for (const inv of p.invites ?? []) this.onInvite(inv.fromName, inv.code);
    this.profile = p;
    this.onChange();
  }

  async refresh() {
    try { this.set(await this.api('/me')); } catch { /* сервер спит или токен устарел */ }
  }

  async enter(kind: 'login' | 'register', name: string, pin: string) {
    const r = await this.api<{ token: string; profile: Profile }>(`/${kind}`, { name, pin });
    this.token = r.token;
    try { localStorage.setItem(KEY, r.token); } catch { /* */ }
    this.set(r.profile);
  }

  logout() {
    this.token = null;
    this.profile = null;
    try { localStorage.removeItem(KEY); } catch { /* */ }
    this.onChange();
  }

  async addFriend(name: string) { this.set(await this.api('/friends/add', { name })); }
  async answer(id: string, accept: boolean) { this.set(await this.api('/friends/answer', { id, accept })); }
  async remove(id: string) { this.set(await this.api('/friends/remove', { id })); }
  async invite(id: string, code: string) { await this.api('/invite', { id, code }); }
}
