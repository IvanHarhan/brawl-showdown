// Плейтест: один игрок (автопилот или ручной сценарий) + 9 ботов, скриншоты по ходу боя.
// node tools/playtest.mjs [url] [секунд]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5173';
const secs = Number(process.argv[3] ?? 40);
const out = 'e2e/playtest';
mkdirSync(out, { recursive: true });

const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await b.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: !!process.env.TOUCH, isMobile: !!process.env.TOUCH });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push('pageerror ' + e.message));
await page.goto(`${url}/?autoplay${process.env.FAST ? '&fast' : ''}`);
await page.locator('#nick').fill(process.env.BRAWLER ?? 'Тест');
if (process.env.BRAWLER) await page.evaluate((id) => localStorage.setItem('brawl_brawler', id), process.env.BRAWLER);
await page.locator('#create').click();
await page.locator('#start').click({ timeout: 60000 });
await page.waitForFunction(() => window.__brawl?.screen() === 'game');
const t0 = Date.now();
let i = 0;
while (Date.now() - t0 < secs * 1000) {
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/${String(i++).padStart(2, '0')}.png` });
  const st = await page.evaluate(() => {
    const g = window.__brawl.S.game;
    const me = g?.world.meLatest();
    return { fps: g?.stats.frames, me: me && { hp: me[3], cans: me[5], ammo: me[6] }, alive: g?.world.info().alive, dead: g?.dead, res: !!window.__brawl.results() };
  });
  console.log(i, JSON.stringify(st));
  if (st.res) break;
}
console.log('errors', errors);
await b.close();
