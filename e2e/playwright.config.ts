import { defineConfig, devices } from '@playwright/test'

// Браузерный e2e коллаборации. Playwright поднимает только Vite (:5173); живой
// Laravel (:8000) и Hocuspocus-хаб (:1234) должны быть уже запущены — их поднимает
// docker-compose стенда или Makefile (см. e2e/README.md). Vite проксирует API на :8000.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5273',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5273',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
