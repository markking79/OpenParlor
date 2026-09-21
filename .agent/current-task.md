# TASK-TTS-001 — Discover exact Kokoro API

## Goal

Record the exact existing local Kokoro interface and its current availability
so the next provider adapter can target it without guessing or exposing it to
the browser.

## Acceptance criteria

- Inspect the installed service, startup method, listening ports, and stable
  API routes without downloading a replacement audio stack.
- Record request/response format, voices endpoint, health/model probe, and
  whether streaming is supported in a secret-free local developer document.
- If the service is not running, record that clearly rather than guessing or
  changing system services.

## Exact allowlist

- `.agent/LOCAL_RUNTIME_DISCOVERY.md` (new)

Do not start, stop, or reconfigure existing services. Do not edit application
code, package files, or unrelated `.agent` control files. Do not stage, reset,
clean, discard, or modify unrelated existing work.
