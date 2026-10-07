import { defineConfig } from '@playwright/test';

// BASE_URL не задан — тестируем локально: сервер раздаёт собранный клиент (сначала npm run build).
// BASE_URL=https://...netlify.app — тестируем задеплоенную версию.
const remote = !!process.env.BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  timeout: 6 * 60 * 1000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:2570', trace: 'off' },
  webServer: remote ? undefined : [
    { command: 'node server/dist/index.js', port: 2570, reuseExistingServer: true, env: { PORT: '2570' } },
    { command: 'node server/dist/index.js', port: 2571, reuseExistingServer: true, env: { PORT: '2571', SIM_LATENCY: '150' } },
  ],
});
