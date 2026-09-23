// ─── Estimated response-start progress (DOGFOOD-007) ─────────────────────────
// Browser-local timing model that estimates time-to-first-token while a reply
// is being prepared. This is NOT real model completion progress: it projects
// from recently observed first-token latencies, never reports 100% before
// actual text arrives, and sends nothing anywhere (no telemetry, no network).

// Conservative default expected first-token latency (ms) when no observed
// timing history exists yet.
export const DEFAULT_FIRST_TOKEN_MS = 8000;

// Estimated progress caps below 100%: the indicator must never read as
// complete before actual text arrives.
export const PROGRESS_CAP = 0.92;

const STORAGE_KEY = 'openparlor-first-token-ema-ms';

/**
 * Browser-local EMA estimator for first-token latency.
 *
 * `observe(elapsedMs)` folds one completed wait into the estimate;
 * `expectedMs()` returns the current projection. The estimate persists in
 * localStorage when available so it improves across sessions; without
 * storage it stays in memory. Invalid samples are ignored.
 *
 * @param {{ storage?: object | null, key?: string, defaultMs?: number, alpha?: number }} [deps]
 * @returns {{
 *   observe: (elapsedMs: number) => number,
 *   expectedMs: () => number,
 *   reset: () => void,
 * }}
 */
export function createFirstTokenEstimator(deps = {}) {
    const storage = deps.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    const key = typeof deps.key === 'string' && deps.key ? deps.key : STORAGE_KEY;
    const defaultMs = deps.defaultMs > 0 ? deps.defaultMs : DEFAULT_FIRST_TOKEN_MS;
    const alpha = deps.alpha > 0 && deps.alpha <= 1 ? deps.alpha : 0.3;

    function loadStored() {
        if (!storage) return null;
        try {
            const value = Number(storage.getItem(key));
            return Number.isFinite(value) && value > 0 ? value : null;
        } catch {
            return null;
        }
    }

    let emaMs = loadStored() ?? defaultMs;

    function persist() {
        if (!storage) return;
        try {
            storage.setItem(key, String(emaMs));
        } catch {
            // storage unavailable
        }
    }

    function observe(elapsedMs) {
        if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return emaMs;
        emaMs = alpha * elapsedMs + (1 - alpha) * emaMs;
        persist();
        return emaMs;
    }

    function expectedMs() {
        return emaMs;
    }

    function reset() {
        emaMs = defaultMs;
        persist();
    }

    return { observe, expectedMs, reset };
}

/**
 * Maps elapsed waiting time to an estimated progress ratio in [0, cap).
 * Rises linearly against the expected first-token latency and caps below
 * 100% so the estimate can never read as complete while waiting.
 *
 * @param {{ elapsedMs?: number, expectedMs?: number, cap?: number }} [state]
 * @returns {number}
 */
export function estimateResponseStartProgress(state = {}) {
    const { elapsedMs, expectedMs, cap = PROGRESS_CAP } = state;
    const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
    const expected = Number.isFinite(expectedMs) && expectedMs > 0 ? expectedMs : DEFAULT_FIRST_TOKEN_MS;
    const max = Number.isFinite(cap) && cap > 0 && cap < 1 ? cap : PROGRESS_CAP;
    return Math.min(max, elapsed / expected);
}

/**
 * Formats estimated progress for display. The tilde makes clear this is an
 * estimate, not real completion; the value is clamped so 100% is impossible.
 *
 * @param {string} name Speaker name (may be empty before identity is known)
 * @param {number} progress Progress ratio in [0, 1]
 * @returns {string} e.g. "Monica · ~45%" or "~45%"
 */
export function formatResponseStartProgress(name, progress) {
    const pct = Math.max(0, Math.min(99, Math.floor((Number.isFinite(progress) ? progress : 0) * 100)));
    const label = '~' + pct + '%';
    return name ? name + ' · ' + label : label;
}
