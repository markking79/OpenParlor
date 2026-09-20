# TASK-001 — Add machine-local OpenParlor configuration loading

## Goal

Provide a small, server-only configuration module that reads the active user's
OpenParlor configuration from their SillyTavern data directory. It must expose
a validated configuration shape for the next task's model-provider adapter.

## Why this task exists

The OpenParlor browser UI must never contain developer-local model, STT, or
TTS endpoints. A stable per-user configuration boundary is the first dependency
for the model, speech-to-text, and text-to-speech providers.

## Relevant existing files

- `src/users.js` — each authenticated request has `request.user.directories.root`.
- `src/server-main.js` — `/api/*` routes run after `requireLoginMiddleware`.
- `src/util.js` — SillyTavern's global `config.yaml` is read-only and unsuitable
  for user-editable local provider settings.
- `.gitignore` — `/data` is already ignored, so per-user runtime configuration
  will not be committed.
- `public/openparlor/openparlor.js` — currently a static demo and must remain
  free of provider URLs.

## Allowed files to modify

- `src/openparlor/config.js` (new)
- `src/openparlor/openparlor-config.example.json` (new)
- `tests/openparlor/config.test.js` (new)

Create parent directories only as needed for the new files. Do not create an
actual local configuration under `data/`.

## Files that must not be modified

- Any existing `src/` SillyTavern file, including `src/users.js` and
  `src/server-startup.js`
- `public/openparlor/`
- `config.yaml`, `.gitignore`, package manifests, lockfiles, and generated files

## Implementation requirements

You are the implementation worker. Do not redesign architecture, broaden scope,
commit, or push. Inspect the relevant files before editing and preserve behavior
outside this task.

1. Put the runtime file at
   `<user directories root>/openparlor/config.json`; derive this from the
   `directories.root` argument, never from a browser-supplied path.
2. Export a small API suitable for server routes/providers:
   - `getOpenParlorConfigPath(directories)`
   - `loadOpenParlorConfig(directories)`
3. `loadOpenParlorConfig` must be asynchronous, return a normalized object, and
   be safe when the file is missing, unreadable, invalid JSON, or malformed.
   Missing configuration is a normal state and must not create files or throw.
4. Support this normalized schema, with no endpoint defaults:

   ```json
   {
     "model": { "provider": "openai-compatible", "baseUrl": "", "model": "" },
     "stt": { "provider": "", "baseUrl": "" },
     "tts": { "provider": "", "baseUrl": "", "voice": "" }
   }
   ```

   Unknown fields may be ignored. Only accept string values for known fields;
   malformed/missing known values fall back to the empty string. Do not include
   secrets or hard-coded developer endpoints.
5. Add an example JSON file matching that schema, with clearly non-routable
   placeholder values such as `http://127.0.0.1:PORT/v1`; it is documentation,
   not a runtime default.
6. Add focused Jest tests covering the config path, missing file, valid config,
   invalid JSON, and malformed field normalization. Tests must use temporary
   directories and leave no files in the repository.
7. Prefer only OpenParlor-specific new files. Do not add a route, UI, provider,
   persistence API, settings UI, STT, or TTS in this task.

## Acceptance criteria

- No application or browser code contains a local endpoint.
- The loader reads only the authenticated user's data root supplied to it.
- Missing/bad config fails closed to a normalized, disabled configuration.
- A model provider can consume the returned model configuration in TASK-002.
- The diff is limited to the three allowed new files.
- Focused tests pass when Jest is available, and lint passes for the new source.

## Required checks

Run and report:

```bash
npm run lint -- --no-cache src/openparlor/config.js
node_modules/.bin/jest --config tests/jest.config.json tests/openparlor/config.test.js
```

If the local Jest executable is absent, report that exact environmental blocker;
do not install dependencies or change package files.

## Out of scope

- Registering an Express route or modifying startup router mounting
- Provider implementations and any remote HTTP calls
- Streaming, cancellation, chat storage, character/group features
- STT/TTS implementation or UI controls
- Settings UI, config writing, secret management, and migration

## Completion report

Report files changed, implementation summary, checks run and their results, and
known concerns. Do not select the next task.
