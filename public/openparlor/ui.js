// ─── OpenParlor UI helpers: time formatting, browser URL resolution, safe service errors. ─────────────────────────────────────────

export function formatRelativeTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';

    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 10) return 'just now';
    if (diffSec < 60) return diffSec + 's ago';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return diffMin + 'm ago';
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + 'h ago';
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return diffDay + 'd ago';
    return date.toLocaleDateString();
}

/**
 * Resolves the local OpenParlor browser URL and connection guidance
 * for the developer runtime. Returns a safe, explicit URL string
 * suitable for display or harness navigation. Strips any embedded
 * credentials and never includes internal filesystem paths.
 * @param {{ origin?: string, pathname?: string }} [params]
 * @returns {{ url: string, isLocal: boolean, guidance: string }}
 */
export function resolveBrowserUrl(params = {}) {
    const origin = typeof params.origin === 'string' && params.origin ? params.origin : '';
    const pathname = typeof params.pathname === 'string' && params.pathname ? params.pathname : '/openparlor';

    if (!origin) {
        return { url: '', isLocal: false, guidance: 'No origin configured' };
    }

    // Strip embedded credentials (user:pass@) and trailing slashes
    const safeOrigin = origin.replace(/\/\/[^@/]+@/, '//').replace(/\/+$/, '');

    // Determine if this is a local development URL
    const isLocal = /(?:^https?:\/\/)(?:localhost|127\.0\.0\.1)(?::\d+)?\/?$/.test(safeOrigin);

    const url = safeOrigin + pathname;
    const guidance = isLocal
        ? 'Open ' + url + ' in your browser'
        : 'Connect to ' + url;

    return { url, isLocal, guidance };
}

/**
 * Normalizes a raw service error into a safe, user-facing message.
 * If the error contains URLs, filesystem paths, or credential patterns,
 * returns the fallback to prevent leaking sensitive information.
 * @param {object|string|null|undefined} raw - The raw error from a service response.
 * @param {string} [fallback] - Safe fallback message when no safe message can be derived.
 * @returns {string} A safe, non-sensitive error message.
 */
export function normalizeServiceError(raw, fallback = 'Service unavailable. Please try again.') {
    let message = '';

    if (typeof raw === 'string') {
        message = raw;
    } else if (raw && typeof raw === 'object') {
        message = typeof raw.error === 'string' ? raw.error : '';
    }

    if (!message) return fallback;

    const hasUrl = /(?:https?|file):\/\//i.test(message);
    const hasFilePath = /(?:^|[\s"'(])\/[\w.-]+(?:\/[\w.-]+)+/.test(message);
    const hasCredential = /(?:api[_-]?key|token|secret|password|credential|authorization|bearer)\s*[:=]\s*\S+/i.test(message);

    if (hasUrl || hasFilePath || hasCredential) {
        return fallback;
    }

    const trimmed = message.trim();
    if (!trimmed) return fallback;
    return trimmed.length > 200 ? trimmed.slice(0, 197) + '...' : trimmed;
}
