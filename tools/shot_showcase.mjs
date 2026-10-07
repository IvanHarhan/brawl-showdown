import { chromium } from '@playwright/test';
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 560 }, deviceScaleFactor: 1.5 })).newPage();
await p.goto((process.argv[2] ?? 'http://localhost:5173') + '/?showcase');
await p.waitForFunction(() => window.__showcaseReady, null, { timeout: 30000 });
await p.waitForTimeout(1500);
await p.screenshot({ path: process.argv[3] ?? 'e2e/screenshots/brawlers.png' });
await b.close();
