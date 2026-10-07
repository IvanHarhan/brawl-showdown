import { chromium } from '@playwright/test';
const url = process.argv[2];
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await b.newContext({ viewport: { width: 844, height: 390 } })).newPage();
await page.goto(url + '/?autoplay');
await page.locator('#create').click({ timeout: 90000 });
await page.locator('#start').click({ timeout: 60000 });
await page.waitForFunction(() => window.__brawl?.screen() === 'game');
const pings = [];
for (let i = 0; i < 12; i++) { await page.waitForTimeout(2100); pings.push(Math.round(await page.evaluate(() => window.__brawl.S.game.ping))); }
console.log('client ping samples ms:', pings.join(','));
await b.close();
