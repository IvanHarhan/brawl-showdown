import './wsfix';
import './style.css';
import * as THREE from 'three';
import type { Room } from '@colyseus/sdk';
import { Net, SERVER_URL } from './net';
import { Input } from './input';
import { Audio } from './audio';
import { GameView } from './gameView';
import { CharacterView, preloadAll } from './render/characters';
import { makeBlobShadowMat } from './render/effects';
import { addOutline, toonMaterial } from './render/toon';
import { BRAWLERS, getBrawler } from '../../shared/brawlers';
import type { LobbyMsg, StartMsg, EndMsg, Snapshot } from '../../shared/protocol';

// ---------- рендерер ----------

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 200);

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// запрет зума/жестов (iOS)
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => { if ((e.target as HTMLElement)?.tagName !== 'INPUT') e.preventDefault(); }, { passive: false });

const ui = document.getElementById('ui')!;
const params = new URLSearchParams(location.search);
const audio = new Audio();
const net = new Net();
addEventListener('pointerdown', () => audio.unlock(), { capture: true });

const errors: string[] = [];
addEventListener('error', (e) => errors.push(String(e.message)));

// ---------- состояние ----------

type Screen = 'menu' | 'lobby' | 'game';
const S = {
  screen: 'menu' as Screen,
  name: localStorage.getItem('brawl_name') || '',
  brawler: localStorage.getItem('brawl_brawler') || BRAWLERS[0].id,
  room: null as Room | null,
  lobby: null as LobbyMsg | null,
  game: null as GameView | null,
  results: null as EndMsg | null,
};

const input = new Input({ fire: (k, a, m, auto) => S.game?.fire(k, a, m, auto) });

// тест-хук для Playwright
(window as unknown as Record<string, unknown>).__brawl = {
  S, errors, server: SERVER_URL,
  snapshot: () => {
    const g = S.game;
    if (!g) return null;
    const w = g.world;
    return { tick: w.latest?.t, you: w.you, alive: w.latest?.alive, players: w.latest ? [...w.latest.players.values()] : [], dead: g.dead, place: g.myPlace };
  },
  history: () => (S.game ? Object.fromEntries(S.game.history) : {}),
  results: () => S.results,
  screen: () => S.screen,
  stats: () => S.game ? { ...S.game.stats, jumps: undefined, corrections: S.game.world.corrections.slice(-500), p95: p95(S.game.stats.jumps) } : null,
};
function p95(a: number[]) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.95)]; }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

function toast(text: string, ms = 2500) {
  const t = el('div', 'toast');
  t.textContent = text;
  ui.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function clearUi() { ui.querySelectorAll(':scope > .screen, :scope > .overlay').forEach((n) => n.remove()); }

// ---------- 3D превью в меню ----------

const preview = { scene: new THREE.Scene(), char: null as CharacterView | null, id: '' };
{
  const s = preview.scene;
  s.background = new THREE.Color(0x2c1f6b);
  s.add(new THREE.HemisphereLight(0xffffff, 0x6a5aa0, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-3, 6, 5);
  s.add(sun);
  const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.85, 0.25, 32), toonMaterial({ color: 0xffd23f }));
  pod.position.y = -0.15;
  addOutline(pod);
  s.add(pod);
  const rays = new THREE.Mesh(new THREE.CircleGeometry(6, 24), new THREE.MeshBasicMaterial({ color: 0x3a2a8a }));
  rays.position.set(0, 1.5, -3);
  s.add(rays);
}
const previewShadow = makeBlobShadowMat();

function setPreview(id: string) {
  if (preview.id === id) return;
  preview.id = id;
  preview.char?.root.removeFromParent();
  const cv = new CharacterView(id, previewShadow);
  preview.char = cv;
  cv.root.position.y = 0.0;
  preview.scene.add(cv.root);
}

// ---------- экраны ----------

const DESCR: Record<string, string> = {
  drip: 'Очередь из 6 пуль. Супер — длинная очередь, ломает стены.',
  mrp: 'Табличка перепрыгивает укрытия. Супер — база с помощниками.',
  bubu: 'Дробовик вблизи, много HP. Супер — рывок сквозь стены.',
  leon: 'Веер сюрикенов. Супер — невидимость на 6 секунд.',
  iceberg: 'Серия быстрых ударов. Супер — прыжок с уроном по области.',
  ali: 'Тяжёлые удары. Супер — рывок с захватом и броском.',
};

function showMenu() {
  S.screen = 'menu';
  clearUi();
  const scr = el('div', 'screen split');
  scr.innerHTML = `
    <div class="half">
    <div class="title">ШОУДАУН</div>
    <div class="subtitle">10 игроков · выживает один</div>
    <div class="spacer"></div>
    <div class="picker"><button class="arrow" id="prev">‹</button><div class="bname" id="bname"></div><button class="arrow" id="next">›</button></div>
    <div class="stats" id="bstats"></div>
    <div class="desc" id="bdesc"></div>
    </div>
    <div class="col half side">
      <input class="input" id="nick" maxlength="14" placeholder="Твой ник" autocomplete="off" />
      <button class="btn" id="create">Создать комнату</button>
      <div class="row"><input class="input" id="code" maxlength="4" placeholder="КОД" style="flex:1;text-transform:uppercase" autocomplete="off" /><button class="btn blue" id="join" style="flex:1">Войти</button></div>
    </div>`;
  ui.appendChild(scr);
  const nick = scr.querySelector('#nick') as HTMLInputElement;
  nick.value = S.name;
  nick.addEventListener('input', () => { S.name = nick.value; localStorage.setItem('brawl_name', S.name); });
  const render = () => {
    const b = getBrawler(S.brawler);
    (scr.querySelector('#bname') as HTMLElement).textContent = b.name;
    (scr.querySelector('#bname') as HTMLElement).style.color = b.color;
    (scr.querySelector('#bstats') as HTMLElement).innerHTML =
      `<span class="stat">❤ ${b.hp}</span><span class="stat">⚔ ${atkDamage(b.id)}</span><span class="stat">🎯 ${b.attack.range}</span><span class="stat">👟 ${b.speed}</span>`;
    (scr.querySelector('#bdesc') as HTMLElement).textContent = DESCR[b.id] ?? '';
    setPreview(b.id);
    localStorage.setItem('brawl_brawler', b.id);
  };
  const shift = (d: number) => {
    const i = BRAWLERS.findIndex((b) => b.id === S.brawler);
    S.brawler = BRAWLERS[(i + d + BRAWLERS.length) % BRAWLERS.length].id;
    audio.sfx('click');
    render();
  };
  scr.querySelector('#prev')!.addEventListener('click', () => shift(-1));
  scr.querySelector('#next')!.addEventListener('click', () => shift(1));
  scr.querySelector('#create')!.addEventListener('click', () => connect(() => net.create(joinOpts())));
  scr.querySelector('#join')!.addEventListener('click', () => {
    const code = (scr.querySelector('#code') as HTMLInputElement).value.trim().toUpperCase();
    if (code.length !== 4) { toast('Код — 4 буквы'); return; }
    connect(() => net.join(code, joinOpts()));
  });
  render();
}

function atkDamage(id: string) {
  const a = getBrawler(id).attack;
  return a.kind === 'burst' ? `${a.damage}×${a.count}` : a.kind === 'spread' ? `${a.damage}×${a.count}` : a.damage;
}

function joinOpts() {
  const name = (S.name || '').trim() || 'Игрок' + Math.floor(Math.random() * 90 + 10);
  return { name, brawler: S.brawler, fast: params.has('fast'), dev: deviceInfo() };
}

/** Устройство и тип сети — только для серверного лога пинга. */
function deviceInfo() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'other';
  const br = /CriOS|Chrome/.test(ua) ? 'Chrome' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'browser';
  const net = (navigator as unknown as { connection?: { effectiveType?: string } }).connection?.effectiveType;
  return ` `;
}

function overlay(html: string) {
  const o = el('div', 'overlay', html);
  ui.appendChild(o);
  return o;
}

async function wakeServer() {
  let o: HTMLElement | null = null;
  const ok = await net.wake((attempt) => {
    if (!o) o = overlay('<div class="spinner"></div><div style="font-size:22px">Сервер просыпается…</div><div class="subtitle" id="wk"></div>');
    const s = o.querySelector('#wk');
    if (s) s.textContent = `Бесплатный сервер спал. Попытка ${attempt + 1}, обычно до минуты.`;
  });
  (o as HTMLElement | null)?.remove();
  return ok;
}

async function connect(fn: () => Promise<Room>) {
  audio.unlock();
  await wakeServer();
  const o = overlay('<div class="spinner"></div><div>Подключение…</div>');
  try {
    const room = await fn();
    o.remove();
    enterRoom(room);
  } catch (e) {
    o.remove();
    const msg = String((e as Error)?.message ?? e);
    toast(/locked|not found|no rooms|Игра уже/i.test(msg) ? 'Комната не найдена или игра уже идёт' : 'Не удалось подключиться: ' + msg, 3500);
    if (S.screen !== 'menu') showMenu();
  }
}

let saveTimer = 0;

function enterRoom(room: Room) {
  S.room = room;
  history.replaceState(null, '', `?room=${room.roomId}${params.has('autoplay') ? '&autoplay' : ''}${params.has('fast') ? '&fast' : ''}`);
  room.onMessage('lobby', (msg: LobbyMsg) => {
    S.lobby = msg;
    if (msg.phase === 'lobby' && S.screen !== 'lobby') { endGame(); showLobby(); }
    else if (S.screen === 'lobby') renderLobby();
  });
  room.onMessage('start', (msg: StartMsg) => startGame(msg));
  room.onMessage('s', (s: Snapshot) => S.game?.onSnapshot(s));
  room.onMessage('end', (msg: EndMsg) => showResults(msg));
  room.onMessage('pong', (t: number) => { if (S.game) S.game.ping = performance.now() - t; });
  // сервер сам меряет пинг: просто отражаем его метку
  room.onMessage('sp', (t: number) => room.send('spr', t));
  let dropO: HTMLElement | null = null;
  room.onDrop(() => { dropO ??= overlay('<div class="spinner"></div><div>Связь потеряна. Переподключаемся…</div>'); });
  room.onReconnect(() => { dropO?.remove(); dropO = null; net.save(); });
  room.onLeave(async (code: number) => {
    dropO?.remove(); dropO = null;
    if (S.room !== room) return;
    if (code === 1000 || code === 4000) { backToMenu(); return; }
    // автопереподключение SDK не помогло — пробуем токен ещё раз до 20 секунд
    const o = overlay('<div class="spinner"></div><div>Переподключение…</div>');
    for (let i = 0; i < 8; i++) {
      const r = await net.reconnectSaved();
      if (r) { o.remove(); enterRoom(r); return; }
      await new Promise((res) => setTimeout(res, 2500));
    }
    o.remove();
    toast('Не удалось вернуться в игру');
    backToMenu();
  });
  clearInterval(saveTimer);
  saveTimer = window.setInterval(() => { if (S.room === room) net.save(); }, 2000);
  if (S.screen !== 'game') showLobby();
}

function showLobby() {
  S.screen = 'lobby';
  clearUi();
  const scr = el('div', 'screen split');
  scr.id = 'lobby';
  ui.appendChild(scr);
  renderLobby();
}

function renderLobby() {
  const scr = ui.querySelector('#lobby') as HTMLElement;
  if (!scr || !S.room) return;
  const L = S.lobby;
  const code = S.room.roomId;
  const isHost = L?.host === S.room.sessionId;
  const me = L?.players.find((p) => p.sid === S.room!.sessionId);
  const link = `${location.origin}${location.pathname}?room=${code}`;
  scr.innerHTML = `
    <div class="half side">
    <div class="subtitle">Код комнаты</div>
    <div class="code">${code}</div>
    <div class="row"><button class="btn small blue" id="share" style="flex:1">Поделиться ссылкой</button><button class="btn small gray" id="leave">Выйти</button></div>
    <div class="subtitle" style="margin-top:10px">Игроки ${L?.players.length ?? 0}/10 — остальных заменят боты</div>
    <div class="plist" id="plist"></div>
    </div>
    <div class="half">
    <div class="subtitle">Твой боец</div>
    <div class="chips" id="chips"></div>
    <div class="spacer"></div>
    ${isHost ? '<button class="btn" id="start">Старт</button>' : '<div class="subtitle">Ждём, пока хост нажмёт «Старт»…</div>'}
    </div>`;
  const plist = scr.querySelector('#plist')!;
  for (const p of L?.players ?? []) {
    const b = getBrawler(p.brawler);
    const row = el('div', 'pl');
    row.innerHTML = `<span class="dot" style="background:${b.color}"></span><span class="who"></span><span class="tag">${b.name}</span>${p.sid === L!.host ? '<span class="tag">хост</span>' : ''}`;
    (row.querySelector('.who') as HTMLElement).textContent = p.name + (p.connected ? '' : ' (нет связи)');
    plist.appendChild(row);
  }
  const chips = scr.querySelector('#chips')!;
  for (const b of BRAWLERS) {
    const c = el('button', 'chip' + (me?.brawler === b.id ? ' on' : ''));
    c.textContent = b.name;
    c.addEventListener('click', () => { S.brawler = b.id; localStorage.setItem('brawl_brawler', b.id); S.room?.send('pick', { brawler: b.id }); setPreview(b.id); });
    chips.appendChild(c);
  }
  if (me) setPreview(me.brawler);
  scr.querySelector('#start')?.addEventListener('click', () => { audio.unlock(); S.room?.send('start'); });
  scr.querySelector('#leave')!.addEventListener('click', () => backToMenu());
  scr.querySelector('#share')!.addEventListener('click', async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'Шоудаун', text: `Залетай в катку! Код ${code}`, url: link });
      else { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); }
    } catch { /* отменили */ }
  });
}

function startGame(msg: StartMsg) {
  if (S.game && S.screen === 'game') { S.game.restart(msg); return; }
  clearUi();
  S.screen = 'game';
  S.results = null;
  S.game = new GameView(msg, S.room!, camera, input, audio, ui, { onMyDeath: (place) => showDeath(place) });
}

function endGame() {
  S.game?.dispose();
  S.game = null;
}

function showDeath(place: number) {
  if (S.results) return;
  const o = el('div', 'screen');
  o.id = 'death';
  o.style.pointerEvents = 'none';
  o.innerHTML = `<div class="panel compact" style="pointer-events:auto"><div class="verdict">Тебя выбили! <span style="color:var(--yellow)">#${place}</span></div>
    <div class="row"><button class="btn small" id="watch" style="flex:1">Смотреть</button><button class="btn small gray" id="menu" style="flex:1">В меню</button></div></div>`;
  ui.appendChild(o);
  o.querySelector('#watch')!.addEventListener('click', () => o.remove());
  o.querySelector('#menu')!.addEventListener('click', () => backToMenu());
}

function showResults(msg: EndMsg) {
  S.results = msg;
  ui.querySelector('#death')?.remove();
  const you = S.game?.world.you ?? -1;
  const mine = msg.results.find((r) => r.slot === you);
  const won = mine?.place === 1;
  if (S.game) {
    const b = S.game.world.me.id;
    if (won) { audio.voice(b, 'win', 1, true); audio.sfx('win'); }
  }
  const isHost = S.lobby?.host === S.room?.sessionId;
  const o = el('div', 'screen');
  o.id = 'results';
  o.className = 'screen split';
  o.innerHTML = `<div class="half side"><div class="verdict">${won ? 'ПОБЕДА!' : 'Катка окончена'}</div><div class="place">#${mine?.place ?? '-'}</div>
    ${isHost ? '<button class="btn" id="again">Ещё раз</button>' : '<div class="subtitle">Хост может начать заново</div>'}
    <button class="btn gray" id="menu">В меню</button></div>
    <div class="half side"><div class="rlist panel" id="rlist"></div></div>`;
  ui.appendChild(o);
  const list = o.querySelector('#rlist')!;
  for (const r of msg.results) {
    const row = el('div', 'pl' + (r.slot === you ? ' me' : ''));
    row.innerHTML = `<b>#${r.place}</b><span class="who"></span><span class="tag">${getBrawler(r.brawler).name}</span>${r.kills ? `<span class="tag">💀${r.kills}</span>` : ''}`;
    (row.querySelector('.who') as HTMLElement).textContent = r.name;
    list.appendChild(row);
  }
  o.querySelector('#again')?.addEventListener('click', () => S.room?.send('again'));
  o.querySelector('#menu')!.addEventListener('click', () => backToMenu());
}

async function backToMenu() {
  clearInterval(saveTimer);
  endGame();
  const r = S.room;
  S.room = null;
  S.lobby = null;
  if (r) await net.leave();
  history.replaceState(null, '', location.pathname);
  showMenu();
}

// ---------- витрина бойцов (?showcase) ----------

function showcase() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2c1f6b);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6a5aa0, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-3, 6, 5);
  scene.add(sun);
  const shadow = makeBlobShadowMat();
  const n = BRAWLERS.length;
  const labels: HTMLElement[] = [];
  const v = new THREE.Vector3();
  const chars = BRAWLERS.map((b, i) => {
    const cv = new CharacterView(b.id, shadow);
    cv.root.position.set((i - (n - 1) / 2) * 1.25, 0, 0);
    scene.add(cv.root);
    const lab = el('div', '', b.name);
    lab.style.cssText = `position:absolute;left:0;top:0;font-size:15px;white-space:nowrap;color:${b.color};text-shadow:0 2px 0 #000,1px 0 0 #000,-1px 0 0 #000`;
    ui.appendChild(lab);
    labels.push(lab);
    return cv;
  });
  const anim = params.get('anim') as 'run' | 'attack' | 'super' | null;
  camera.fov = 30;
  let last = performance.now();
  const loop = () => {
    const now = performance.now();
    const dt = (now - last) / 1000; last = now;
    const aspect = innerWidth / innerHeight;
    const dist = Math.max(8 / (2 * Math.tan((15 * Math.PI) / 180) * aspect), 3.5);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.position.set(0, 1.2 + dist * 0.12, dist);
    camera.lookAt(0, 0.75, 0);
    chars.forEach((cv, i) => {
      v.set(cv.root.position.x, -0.15, 0).project(camera);
      labels[i].style.transform = `translate(calc(${(v.x * 0.5 + 0.5) * innerWidth}px - 50%), ${(-v.y * 0.5 + 0.5) * innerHeight}px)`;
    });
    for (const cv of chars) {
      if (anim === 'attack' || anim === 'super') { if (Math.floor(now / 1200) !== (cv as unknown as { _k?: number })._k) { (cv as unknown as { _k?: number })._k = Math.floor(now / 1200); cv.oneShot(anim, now); } }
      cv.update(dt, now, anim === 'run', false);
      cv.root.rotation.y = params.has('spin') ? now / 1500 : 0.35;
    }
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  Promise.all(chars.map((c) => c.ready)).then(() => { (window as unknown as Record<string, unknown>).__showcaseReady = true; });
  loop();
}

// ---------- главный цикл ----------

let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (S.game && S.screen === 'game') {
    camera.fov = 40;
    camera.updateProjectionMatrix();
    S.game.update(now, dt);
    renderer.render(S.game.scene, camera);
  } else {
    const aspect = innerWidth / innerHeight;
    camera.fov = 35;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    if (aspect < 1) {
      // узкое окно: модель над кнопками (меню) или между списком и «Старт» (лобби)
      camera.position.set(0, 1.3, 6.8);
      camera.lookAt(0, S.screen === 'lobby' ? 1.25 : -0.25, 0);
    } else {
      // горизонтально: в меню модель в левой половине, в лобби — в правой
      const dist = 5.5;
      const halfW = dist * Math.tan((35 * Math.PI) / 360) * aspect;
      const cx = (S.screen === 'lobby' ? -0.5 : 0.5) * halfW;
      camera.position.set(cx, 1.3, dist);
      camera.lookAt(cx, 0.75, 0);
    }
    if (preview.char) {
      preview.char.root.rotation.y = now / 1400;
      preview.char.update(dt, now, false, false);
    }
    renderer.render(preview.scene, camera);
  }
  requestAnimationFrame(frame);
}

async function boot() {
  if (params.has('showcase')) { showcase(); return; }
  preloadAll();
  showMenu();
  requestAnimationFrame(frame);
  const saved = Net.saved();
  const code = params.get('room');
  if (saved && (!code || code.toUpperCase() === saved.code)) {
    await wakeServer();
    const o = overlay('<div class="spinner"></div><div>Возвращаемся в катку…</div>');
    const r = await net.reconnectSaved();
    o.remove();
    if (r) { enterRoom(r); return; }
  }
  if (code && code.length === 4) connect(() => net.join(code, joinOpts()));
}

boot();
