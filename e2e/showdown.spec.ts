import { test, expect, devices, chromium, webkit, Browser, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// 4 живых клиента (2 — эмуляция iPhone в WebKit) + 6 ботов играют шоудаун до победителя.
const SHOTS = process.env.SHOTS_DIR ?? `e2e/screenshots/${process.env.BASE_URL ? 'deployed' : 'local'}`;
mkdirSync(SHOTS, { recursive: true });

type Hook = {
  history: () => Record<string, number[][]>;
  results: () => { results: { slot: number; place: number; name: string }[] } | null;
  screen: () => string;
  errors: string[];
  snapshot: () => { tick: number; you: number } | null;
};

async function hook<T>(p: Page, fn: (h: Hook) => T): Promise<T> {
  return p.evaluate((src) => {
    const h = (window as unknown as { __brawl: Hook }).__brawl;
    return new Function('h', `return (${src})(h)`)(h);
  }, fn.toString()) as Promise<T>;
}

test('шоудаун: 4 клиента + 6 ботов до победителя', async ({ baseURL }) => {
  const browsers: Browser[] = [];
  const pages: Page[] = [];
  const consoleErrors: string[] = [];
  const iphone = devices['iPhone 13 landscape'];
  let wk: Browser | null = null;
  try { wk = await webkit.launch(); browsers.push(wk); } catch { /* нет webkit — эмулируем в chromium */ }
  const ch = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  browsers.push(ch);

  const names = ['Хост', 'Айфон', 'Комп1', 'Комп2'];
  for (let i = 0; i < 4; i++) {
    const phone = i < 2;
    const b = phone && wk ? wk : ch;
    const { defaultBrowserType: _d, ...phoneOpts } = iphone;
    const ctx = await b.newContext(phone ? phoneOpts : { viewport: { width: 1100, height: 800 } });
    await ctx.addInitScript((n) => { localStorage.setItem('brawl_name', n); }, names[i]);
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${names[i]}] ${m.text()}`); });
    page.on('pageerror', (e) => consoleErrors.push(`[${names[i]}] pageerror ${e.message}`));
    pages.push(page);
  }
  const [host, ...others] = pages;

  await host.goto(`${baseURL}/?fast&autoplay`);
  await expect(host.locator('#create')).toBeVisible({ timeout: 90_000 });
  await host.waitForTimeout(1500);
  await host.screenshot({ path: `${SHOTS}/1-menu.png` });
  await host.locator('#create').click();
  await expect(host.locator('.code')).toBeVisible({ timeout: 90_000 });
  const code = (await host.locator('.code').textContent())!.trim();
  expect(code).toMatch(/^[A-Z]{4}$/);

  for (const p of others) await p.goto(`${baseURL}/?room=${code}&autoplay`);
  await expect(host.locator('.pl')).toHaveCount(4, { timeout: 60_000 });
  await host.waitForTimeout(800);
  await host.screenshot({ path: `${SHOTS}/2-lobby.png` });
  await host.locator('#start').click();

  // все в бою
  for (const p of pages) await expect.poll(() => hook(p, (h) => h.screen()), { timeout: 20_000 }).toBe('game');

  // скриншот боя, когда газ уже видно
  let battleShot = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 4 * 60_000) {
    await host.waitForTimeout(2000);
    const done = await Promise.all(pages.map((p) => hook(p, (h) => !!h.results())));
    if (!battleShot && Date.now() - t0 > 16_000) {
      // скрин с живого айфона (если хост уже выбит — с того, кто жив)
      for (const p of pages.slice(0, 3)) {
        const alive = await hook(p, (h) => { const s = h.snapshot(); return !!s && !(s as unknown as { dead: boolean }).dead; });
        if (alive) { await p.screenshot({ path: `${SHOTS}/3-battle.png` }); battleShot = true; break; }
      }
      if (!battleShot) { await pages[0].screenshot({ path: `${SHOTS}/3-battle.png` }); battleShot = true; }
    }
    if (done.every(Boolean)) break;
  }

  const results = await Promise.all(pages.map((p) => hook(p, (h) => h.results())));
  for (const r of results) expect(r, 'каждый клиент получил итог').toBeTruthy();
  const r0 = results[0]!.results;
  expect(r0.length).toBe(10);
  expect(r0.filter((x) => x.place === 1).length).toBe(1);
  expect(new Set(r0.map((x) => x.place)).size).toBe(10);
  for (const r of results) expect(JSON.stringify(r!.results)).toBe(JSON.stringify(r0));
  await pages[1].waitForTimeout(1200);
  await pages[1].screenshot({ path: `${SHOTS}/4-result.png` });

  // совпадение состояния: на общих тиках данные видимых всем игроков одинаковы
  const hist = await Promise.all(pages.map((p) => hook(p, (h) => h.history())));
  const ticks = Object.keys(hist[0]).filter((t) => hist.every((h) => h[t]));
  expect(ticks.length, 'есть общие тики').toBeGreaterThan(50);
  let compared = 0, mismatches = 0;
  for (const t of ticks) {
    const maps = hist.map((h) => new Map(h[t].map((row) => [row[0], row.join(',')])));
    for (const [slot, row] of maps[0]) {
      for (const m of maps.slice(1)) {
        const other = m.get(slot);
        if (other === undefined) continue; // скрыт кустом/невидимостью у этого клиента
        compared++;
        if (other !== row) mismatches++;
      }
    }
  }
  console.log(`state compare: ${ticks.length} ticks, ${compared} pairs, ${mismatches} mismatches; winner: ${r0[0].name}`);
  expect(compared).toBeGreaterThan(500);
  expect(mismatches).toBe(0);

  const pageErrors = (await Promise.all(pages.map((p) => hook(p, (h) => h.errors)))).flat();
  const relevant = consoleErrors.filter((e) => !/favicon|GPU stall|Autoplay/i.test(e));
  console.log('console errors:', relevant);
  expect(pageErrors).toEqual([]);
  expect(relevant).toEqual([]);

  for (const b of browsers) await b.close();
});
