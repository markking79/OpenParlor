// ─── OpenParlor settings and service status helpers: model/health normalization and readiness checks. ─────────────────────────────────────────

/**
 * Normalizes server-owned settings into a safe, browser-displayable shape.
 * Only exposes status-level information (model, speech, character preference).
 * Strips any endpoint URLs, credentials, API keys, or filesystem paths.
 * @param {object|null} raw
 * @returns {{
 *   model: { provider: string, model: string, connected: boolean } | null,
 *   speech: { voicesAvailable: boolean, voiceModeEnabled: boolean } | null,
 *   character: { defaultCharacterId: string, count: number } | null,
 * }}
 */
export function normalizeSettings(raw) {
    if (!raw || typeof raw !== 'object') {
        return { model: null, speech: null, character: null };
    }

    const model = (raw.model && typeof raw.model === 'object') ? {
        provider: typeof raw.model.provider === 'string' ? raw.model.provider : '',
        model: typeof raw.model.model === 'string' ? raw.model.model : '',
        connected: raw.model.connected === true,
    } : null;

    const speech = (raw.speech && typeof raw.speech === 'object') ? {
        voicesAvailable: raw.speech.voicesAvailable === true,
        voiceModeEnabled: raw.speech.voiceModeEnabled === true,
    } : null;

    const character = (raw.character && typeof raw.character === 'object') ? {
        defaultCharacterId: typeof raw.character.defaultCharacterId === 'string' ? raw.character.defaultCharacterId : '',
        count: (typeof raw.character.count === 'number' && Number.isFinite(raw.character.count) && raw.character.count >= 0)
            ? Math.floor(raw.character.count) : 0,
    } : null;

    return { model, speech, character };
}

export function normalizeModelStatus(raw) {
    if (!raw || typeof raw !== 'object') {
        return { provider: '', model: '', endpointLabel: '', models: [], connected: false };
    }
    return {
        provider: typeof raw.provider === 'string' ? raw.provider : '',
        model: typeof raw.model === 'string' ? raw.model : '',
        endpointLabel: typeof raw.endpointLabel === 'string' ? raw.endpointLabel : '',
        models: Array.isArray(raw.models) ? raw.models.filter(m => typeof m === 'string') : [],
        connected: raw.connected === true,
    };
}

/**
 * Normalizes raw local-stack health data into safe availability-only indicators.
 * Only exposes `available` (boolean) and `label` (safe string) per service.
 * Strips any endpoint URLs, credentials, API keys, or filesystem paths.
 * @param {object|null} raw
 * @returns {{
 *   model: { available: boolean, label: string } | null,
 *   tts: { available: boolean, label: string } | null,
 *   stt: { available: boolean, label: string } | null,
 * }}
 */
export function normalizeHealthStatus(raw) {
    if (!raw || typeof raw !== 'object') {
        return { model: null, tts: null, stt: null };
    }

    const model = (raw.model && typeof raw.model === 'object') ? {
        available: raw.model.available === true,
        label: typeof raw.model.label === 'string' ? raw.model.label : '',
    } : null;

    const tts = (raw.tts && typeof raw.tts === 'object') ? {
        available: raw.tts.available === true,
        label: typeof raw.tts.label === 'string' ? raw.tts.label : '',
    } : null;

    const stt = (raw.stt && typeof raw.stt === 'object') ? {
        available: raw.stt.available === true,
        label: typeof raw.stt.label === 'string' ? raw.stt.label : '',
    } : null;

    return { model, tts, stt };
}

/**
 * Determines whether the text-chat path is ready to accept messages,
 * based on already-normalized model status and health status.
 * @param {{ provider: string, model: string, endpointLabel: string, models: string[], connected: boolean } | null} modelStatus
 * @param {{ model: { available: boolean, label: string } | null, tts: { available: boolean, label: string } | null, stt: { available: boolean, label: string } | null } | null} healthStatus
 * @returns {{ ready: boolean, reason: string }}
 */
export function normalizeChatReadiness(modelStatus, healthStatus) {
    const model = (modelStatus && typeof modelStatus === 'object') ? modelStatus : null;
    const health = (healthStatus && typeof healthStatus === 'object') ? healthStatus : null;

    if (!model || model.connected !== true) {
        return { ready: false, reason: 'Model not connected' };
    }

    if (health && health.model && health.model.available === false) {
        return { ready: false, reason: 'Model service unavailable' };
    }

    return { ready: true, reason: '' };
}

/**
 * Determines whether the audio pipeline (STT + TTS) is ready based on
 * already-normalized health status. Used to gate browser audio features
 * on existing local services without launching duplicate stacks.
 * @param {{ model: { available: boolean, label: string } | null, tts: { available: boolean, label: string } | null, stt: { available: boolean, label: string } | null } | null} healthStatus
 * @returns {{ stt: boolean, tts: boolean, ready: boolean }}
 */
export function normalizeAudioReadiness(healthStatus) {
    const health = (healthStatus && typeof healthStatus === 'object') ? healthStatus : null;
    const stt = !!(health && health.stt && health.stt.available === true);
    const tts = !!(health && health.tts && health.tts.available === true);
    return { stt, tts, ready: stt && tts };
}

/**
 * Combines already-normalized local-stack status into a single readiness
 * report for the browser harness. Reuses existing services without
 * downloading or launching duplicate AI stacks. Read-only: no CSRF or
 * mutation required.
 * @param {{
 *   modelStatus?: object | null,
 *   healthStatus?: object | null,
 *   prerequisite?: object | null,
 * }} [params]
 * @returns {{
 *   model: { ready: boolean, reason: string },
 *   audio: { stt: boolean, tts: boolean, ready: boolean },
 *   prerequisite: { deferred: boolean, label: string },
 *   ready: boolean,
 *   blockers: string[],
 * }}
 */
export function checkLocalReadiness({ modelStatus, healthStatus, prerequisite } = {}) {
    const model = normalizeChatReadiness(modelStatus, healthStatus);
    const audio = normalizeAudioReadiness(healthStatus);
    const prereq = normalizeDeferredPrerequisite(prerequisite);

    const blockers = [];
    if (!model.ready) blockers.push(model.reason);
    if (prereq.deferred) blockers.push(prereq.label);

    return {
        model,
        audio,
        prerequisite: prereq,
        ready: model.ready && !prereq.deferred,
        blockers,
    };
}

/**
 * Normalizes a raw prerequisite check result into a safe deferred/satisfied
 * status. Used by the browser harness to report missing developer storage
 * state as a deferred local prerequisite without leaking sensitive details.
 * @param {object|null|undefined} raw
 * @returns {{ deferred: boolean, label: string }}
 */
export function normalizeDeferredPrerequisite(raw) {
    if (!raw || typeof raw !== 'object') {
        return { deferred: true, label: 'Prerequisite not met' };
    }
    if (raw.satisfied === true) {
        return { deferred: false, label: '' };
    }
    const label = typeof raw.label === 'string' ? raw.label : '';
    const safeLabel = label
        .replace(/https?:\/\/\S+/g, '[redacted]')
        .replace(/file:\/\/\S+/g, '[redacted]')
        .replace(/(?:^|[\s"'(>])\/[\w.-]+(?:\/[\w.-]+)+/g, ' [redacted]')
        .replace(/(?:api[_-]?key|token|secret|password|credential|authorization|bearer)\s*[:=]\s*\S+/gi, '[redacted]')
        .trim();
    return { deferred: true, label: !safeLabel || safeLabel === '[redacted]' ? 'Prerequisite not met' : safeLabel };
}

/**
 * Fetches and normalizes a deferred prerequisite check from the server.
 * Reports missing developer storage state as a deferred local prerequisite
 * without leaking sensitive details. Uses the existing read-only endpoint
 * (no CSRF required for GET).
 * @param {{ fetchFn?: (url: string) => Promise<Response> }} [deps]
 * @returns {Promise<{ deferred: boolean, label: string }>}
 */
export async function fetchDeferredPrerequisite(deps = {}) {
    const { fetchFn = fetch } = deps;
    try {
        const res = await fetchFn('/api/openparlor/prerequisites');
        if (!res.ok) {
            return { deferred: true, label: 'Prerequisite not met' };
        }
        const data = await res.json();
        return normalizeDeferredPrerequisite(data);
    } catch {
        return { deferred: true, label: 'Prerequisite not met' };
    }
}
