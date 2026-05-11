#!/usr/bin/env node
// Launches a persistent Chromium instance for llmTerminal on CDP port 9225.
// This lets the browser-status API detect it and show the browser link in the UI.
import { chromium } from '/tmp/pw-test/node_modules/playwright/index.mjs';

const PORT = 9225;
const URL = 'http://localhost:7683/';

console.log(`Launching browser on CDP port ${PORT} → ${URL}`);

const browser = await chromium.launch({
  headless: true,
  args: [`--remote-debugging-port=${PORT}`],
});

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
});

const page = await context.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });
console.log(`Browser ready — CDP on port ${PORT}, viewing ${URL}`);
console.log('Press Ctrl+C to stop.');

// Keep alive
process.on('SIGINT', async () => {
  console.log('Shutting down browser...');
  await browser.close();
  process.exit(0);
});

// Refresh every 5 minutes to keep it current
setInterval(async () => {
  try { await page.reload({ waitUntil: 'networkidle' }); } catch {}
}, 5 * 60 * 1000);
