import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '.env') });

const API_URL = process.env.API_URL ?? 'http://localhost:8000';
const WEB_URL = process.env.WEB_URL ?? 'http://localhost:3000';

export default defineConfig({
  globalSetup: './global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  // Two concurrent runs sharing test-results/ wipe each other's traces (ENOENT failures): point a
  // second run at its own folders with PW_OUTPUT_DIR / PW_REPORT_DIR.
  outputDir: process.env.PW_OUTPUT_DIR ?? 'test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: process.env.PW_REPORT_DIR ?? 'playwright-report' }]],
  projects: [
    {
      name: 'api',
      testDir: './api',
      use: { baseURL: API_URL },
    },
    {
      name: 'web',
      testDir: './web',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: WEB_URL,
        storageState: '.auth/state.json',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
      },
    },
  ],
});
