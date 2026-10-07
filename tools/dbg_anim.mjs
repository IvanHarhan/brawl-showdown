import { chromium } from '@playwright/test';
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await b.newContext({ viewport: { width: 844, height: 390 } })).newPage();
await page.goto('http://localhost:2580/?fast');
await page.locator('#create').click();
await page.locator('#start').click({ timeout: 60000 });
await page.waitForFunction(() => window.__brawl?.screen() === 'game');
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(3000);
  console.log(JSON.stringify(await page.evaluate(() => {
    const g = window.__brawl.S.game;
    const views = g.world.players(performance.now());
    return views.map((v) => { const cv = g.chars.get(v.slot); return v.slot + ':' + cv.current; });
  })));
}
await b.close();
