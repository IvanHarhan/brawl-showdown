import { test, expect, chromium } from '@playwright/test';

// Пинг 150 мс (сервер с SIM_LATENCY=150): своё движение не должно дёргаться.
test('пинг 150 мс: своё движение плавное', async () => {
  const base = process.env.PING_URL ?? 'http://localhost:2571';
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await b.newContext({ viewport: { width: 900, height: 900 } })).newPage();
  await page.goto(`${base}/`);
  await page.locator('#nick').fill('Пинг');
  await page.locator('#create').click();
  await expect(page.locator('#start')).toBeVisible({ timeout: 60_000 });
  await page.locator('#start').click();
  await expect.poll(() => page.evaluate(() => (window as any).__brawl.screen()), { timeout: 20_000 }).toBe('game');
  await page.waitForTimeout(1500);
  const ping = await page.evaluate(() => (window as any).__brawl.S.game.ping);
  // ходим по квадрату
  for (const key of ['KeyD', 'KeyS', 'KeyA', 'KeyW', 'KeyD', 'KeyW']) {
    await page.keyboard.down(key);
    await page.waitForTimeout(900);
    await page.keyboard.up(key);
  }
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => (window as any).__brawl.stats());
  const corr: number[] = st.corrections;
  const maxCorr = Math.max(0, ...corr);
  console.log(`ping=${Math.round(ping)}ms frames=${st.frames} snaps=${st.snaps} maxCorrection=${maxCorr.toFixed(4)} maxJump=${st.maxJump.toFixed(4)} p95Jump=${st.p95.toFixed(4)}`);
  expect(ping).toBeGreaterThan(120);
  // поправки сервера почти нулевые и рывков картинки нет
  expect(maxCorr).toBeLessThan(0.15);
  expect(st.p95).toBeLessThan(0.02);
  expect(st.maxJump).toBeLessThan(0.25);
  await b.close();
});
