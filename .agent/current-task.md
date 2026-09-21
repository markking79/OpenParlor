# TASK-DATA-003 — Conversation list UI

## Goal

Replace the static demo conversation screen with an authenticated UI backed by
the accepted character and conversation APIs. Keep server-owned provider
configuration and the uncommitted broad data router out of scope.

## Acceptance criteria

- The sidebar lists stored recent conversations with title, last activity, and
  the selected character's name/avatar; no demo conversation content remains.
- Selecting a conversation loads its persisted messages and uses its ID for
  subsequent streamed chat requests.
- New conversation lets the user select one of their stored characters and
  creates a conversation through the authenticated API.
- The UI handles empty/loading/error states without exposing filesystem paths
  or provider configuration.
- Add focused browser-independent tests for pure UI helpers when practical;
  keep the existing authenticated Playwright acceptance as a recorded runtime
  follow-up if its storage state is unavailable.

## Exact allowlist

- `public/openparlor/index.html`
- `public/openparlor/openparlor.js`
- `public/openparlor/openparlor.css`
- `tests/openparlor/openparlor-ui.test.js` (new)

Do not edit OpenParlor server routes, `src/openparlor/router.js`, package files, or other
`.agent` control files. Do not stage, reset, clean, discard, or modify
unrelated existing work.
