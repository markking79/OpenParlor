# TASK-MODEL-001 — Settings status panel

## Goal

Add an authenticated, server-backed model status endpoint and a small OpenParlor
UI status panel. It must report only safe configuration/status information,
discover models through the configured provider, and never expose credentials.

## Acceptance criteria

- `GET /api/openparlor/model-status` requires the existing private endpoint
  authentication, loads configuration only from the authenticated user's
  directories, and returns a stable safe shape.
- Reuse `loadOpenParlorConfig(user.directories)` and `createModelProvider(config.model)`;
  do not read configuration files directly or call a provider URL with global
  `fetch`. Use the provider's `listModels()` method.
- Report configured provider, configured model, a safely displayable endpoint
  label, discovered model IDs, and connected/unavailable state. Never return
  an API key or raw provider error body.
- An unavailable/misconfigured provider yields an ordinary safe status result,
  not a route crash.
- The OpenParlor page shows model connection state, configured model, and
  discovered models or an unavailable message without making provider URLs or
  keys browser-configurable.
- Add focused router/service and UI-helper tests.
- Router tests must exercise the mounted Express route: missing `request.user`
  returns the established `401 { error: 'Authentication is required' }` shape;
  authenticated requests pass that user's exact `directories` object to the
  loader and return only the safe status shape. A valid `/models` response
  with an empty list is still connected.

## Exact allowlist

- `src/openparlor/model-status-router.js` (new)
- `src/server-startup.js`
- `public/openparlor/index.html`
- `public/openparlor/openparlor.js`
- `public/openparlor/openparlor.css`
- `tests/openparlor/model-status-router.test.js` (new)
- `tests/openparlor/openparlor-ui.test.js`

Do not edit configuration/provider implementation, OpenParlor server routes,
`src/openparlor/router.js`, package files, or other `.agent` control files.
Do not stage, reset, clean, discard, or modify unrelated existing work.
