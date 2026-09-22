// Creates an authenticated Playwright storage state for the OpenParlor
// browser acceptance tests (STAB-008).
//
// Safe local usage (from the repository's tests/ directory):
//
//   ST_BASE_URL=http://127.0.0.1:8000 node openparlor/make-storage-state.js [output.json]
//
// The script opens a visible browser at the server's /login page. Complete
// the login there (or, if the local server does not require authentication,
// simply open /openparlor/). As soon as the OpenParlor UI renders, the
// script saves the session cookies + localStorage to the output path
// (default: tests/openparlor/st-auth.storage-state.json) and exits.
//
// The output file contains session credentials for your local server:
//   - it is covered by the repository .gitignore (*.storage-state.json);
//   - never commit it, push it, or copy it to shared locations;
//   - delete it when you no longer need browser acceptance runs.
import { chromium, expect } from '@playwright/test';
import path from 'node:path';
import process from 'node:process';

const baseURL = (process.env.ST_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const outputPath = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'st-auth.storage-state.json');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

console.log(`Opening ${baseURL}/login — log in, then open /openparlor/ in the opened browser.`);
console.log('The script saves the storage state automatically once the OpenParlor UI loads.');
await page.goto(`${baseURL}/login`);
await expect(page.locator('.brand-name')).toBeVisible({ timeout: 0 });
await context.storageState({ path: outputPath });
console.log(`Saved authenticated storage state to ${outputPath}`);
console.log('Remember: this file is git-ignored and must never be committed.');
await browser.close();
