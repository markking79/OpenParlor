# Browser Test Infrastructure Follow-up

TASK-SUPERVISOR-BROWSER-001: enable the existing TASK-004 Playwright acceptance
spec on the local Ubuntu 26.04 development host. Playwright 1.63 supports this
host and its Chromium binary is installed in Playwright's normal shared cache.
The supervisor checks `playwright install --list`, rather than assuming a
repository-local cache location. Keep the lightweight spec and production
authentication/CSRF unchanged. To run the authenticated acceptance test:

```bash
OPENPARLOR_BROWSER_ACCEPTANCE=1 \
ST_AUTH_STORAGE_STATE=/absolute/path/to/authenticated-state.json \
tests/node_modules/.bin/playwright test --config tests/playwright.config.js tests/openparlor/task-004.e2e.js
```

The storage-state file is developer-local and must never be committed. The
supervisor treats unavailable browser infrastructure as a recorded deferral,
not a reason to halt normal coding work.
