# Browser Test Infrastructure Follow-up

TASK-SUPERVISOR-BROWSER-001: enable the existing TASK-004 Playwright acceptance
spec on the local Ubuntu 26.04 development host. Playwright 1.56 installs its
Node package successfully, but its bundled Chromium installer currently reports
that Ubuntu 26.04 x64 is unsupported. Keep the lightweight spec and production
authentication/CSRF unchanged. Supply a compatible headless Chromium (or
upgrade Playwright after compatibility review), then run with:

```bash
OPENPARLOR_BROWSER_ACCEPTANCE=1 \
ST_AUTH_STORAGE_STATE=/absolute/path/to/authenticated-state.json \
tests/node_modules/.bin/playwright test --config tests/playwright.config.js tests/openparlor/task-004.e2e.js
```

The storage-state file is developer-local and must never be committed. The
supervisor treats unavailable browser infrastructure as a recorded deferral,
not a reason to halt normal coding work.
