import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:5173/GR2Lite/',
    headless: true,
    launchOptions: {args: ['--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader']}
  },
  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 90000
  }
});
