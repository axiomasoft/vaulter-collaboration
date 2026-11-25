import { defineConfig, devices } from '@playwright/test'

// Браузерный e2e коллаборации. Playwright поднимает только Vite (:5173); живой
// Laravel (:8000) и Hocuspocus-хаб (:1234) должны быть уже запущены — их поднимает
// docker-compose стенда или Makefile (см. e2e/README.md). Vite проксирует API на :8000.
const vitePort = Number(process.env.VAULTER_E2E_VITE_PORT ?? 5273)
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${vitePort}`

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
