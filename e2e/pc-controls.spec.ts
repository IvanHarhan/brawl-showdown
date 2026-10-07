import { test, expect, chromium } from '@playwright/test';

// Управление на ПК: WASD двигает, ЛКМ стреляет, зажатая ЛКМ стреляет очередями.
test('ПК: WASD и мышь', async ({ baseURL }) => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.goto(`${baseURL}/`);
  await page.locator('#nick').fill('ПК');
  await page.locator('#create').click();
  await page.locator('#start').click({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__brawl.screen()), { timeout: 20_000 }).toBe('game');
  await page.waitForTimeout(1500);
  const me = () => page.evaluate(() => { const g = (window as any).__brawl.S.game; const p = g.world.myPos(); const s = g.world.meLatest(); return { x: p.x, y: p.y, ammo: s[6] }; });
  const a = await me();
  await page.keyboard.down('KeyD'); await page.waitForTimeout(700); await page.keyboard.up('KeyD');
  await page.keyboard.down('KeyS'); await page.waitForTimeout(700); await page.keyboard.up('KeyS');
  const b1 = await me();
  expect(Math.hypot(b1.x - a.x, b1.y - a.y)).toBeGreaterThan(0.5);
  // одиночный клик по полю
  await page.mouse.move(900, 300);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(600);
  const c = await me();
  expect(c.ammo).toBeLessThan(250);
  // зажатая ЛКМ — повторные атаки (считаем отправленные на сервер)
  await page.waitForTimeout(3500);
  await page.evaluate(() => {
    const g = (window as any).__brawl.S.game;
    const orig = g.room.send.bind(g.room);
    (window as any).__atk = 0;
    g.room.send = (t: string, m: unknown) => { if (t === 'atk') (window as any).__atk++; return orig(t, m); };
  });
  await page.mouse.down(); await page.waitForTimeout(2600); await page.mouse.up();
  const sent = await page.evaluate(() => (window as any).__atk);
  expect(sent).toBeGreaterThanOrEqual(3);  await b.close();
});
