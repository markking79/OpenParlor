// ─── Pure helpers (exported for Node.js tests) ───────────────────────────────

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

export function normalizeParticipants(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(p => p && typeof p === 'object')
        .map(p => ({
            characterId: typeof p.character_id === 'string'
                ? p.character_id
                : (typeof p.characterId === 'string' ? p.characterId : ''),
            role: typeof p.role === 'string' ? p.role : 'character',
        }))
        .filter(p => p.characterId !== '');
}

export function normalizeConversation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        id: typeof raw.id === 'string' ? raw.id : String(raw.id || ''),
        title: typeof raw.title === 'string' ? raw.title : 'Untitled',
        characterId: raw.character_id != null ? String(raw.character_id) : '',
        participants: normalizeParticipants(raw.participants),
        updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : '',
    };
}

export function normalizeCharacter(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        id: typeof raw.id === 'string' ? raw.id : String(raw.id || ''),
        name: typeof raw.name === 'string' ? raw.name : 'Unknown',
        avatarUrl: typeof raw.avatar_url === 'string' ? raw.avatar_url : '',
        ttsVoice: typeof raw.tts_voice === 'string' ? raw.tts_voice : '',
    };
}

export function normalizeTtsVoices(raw) {
    if (!raw || typeof raw !== 'object') {
        return { voices: [], available: false };
    }
    return {
        voices: Array.isArray(raw.voices) ? raw.voices.filter(v => typeof v === 'string') : [],
        available: raw.available === true,
    };
}

export function normalizeAutoSpeakState(raw) {
    return raw === 'true' || raw === true;
}

export function normalizeVoiceModeState(raw) {
    return raw === 'true' || raw === true;
}

/**
 * Pure decision helper: determines whether a successful transcription
 * should be auto-sent through the chat flow.
 * @param {{
 *   voiceModeEnabled: boolean,
 *   transcriptionSucceeded: boolean,
 * }} params
 * @returns {boolean}
 */
export function shouldAutoSendTranscription({ voiceModeEnabled, transcriptionSucceeded }) {
    return voiceModeEnabled && transcriptionSucceeded;
}

/**
 * Pure decision helper: determines whether a completed assistant reply
 * should be auto-spoken. All conditions must be true.
 * @param {{
 *   sendConversationId: string,
 *   currentConversationId: string,
 *   sendEpoch: number,
 *   selectionEpoch: number,
 *   streamDone: boolean,
 *   hadStreamError: boolean,
 *   autoSpeakEnabled: boolean,
 *   hasContent: boolean,
 *   recordingActive?: boolean,
 * }} params
 * @returns {boolean}
 */
export function shouldAutoSpeak({
    sendConversationId,
    currentConversationId,
    sendEpoch,
    selectionEpoch,
    streamDone,
    hadStreamError,
    autoSpeakEnabled,
    hasContent,
    recordingActive = false,
}) {
    return (
        sendConversationId !== '' &&
        sendConversationId === currentConversationId &&
        sendEpoch === selectionEpoch &&
        streamDone &&
        !hadStreamError &&
        autoSpeakEnabled &&
        hasContent &&
        !recordingActive
    );
}

export function createNdjsonParser() {
    const decoder = new TextDecoder('utf-8', { stream: true });
    let buffer = '';
    const records = [];

    function feed(chunk) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                records.push(JSON.parse(trimmed));
            } catch {
                // skip malformed lines
            }
        }
    }

    function flush() {
        const remaining = decoder.decode();
        if (remaining) {
            buffer += remaining;
        }
        if (buffer.trim()) {
            try {
                records.push(JSON.parse(buffer.trim()));
            } catch {
                // skip
            }
        }
        buffer = '';
    }

    return { feed, flush, records };
}

export function mapChatRole(role) {
    if (role === 'character') return 'assistant';
    return role;
}

export function validateCharacterForm(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
        return { valid: false, errors: ['Invalid form data'], name: '' };
    }
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name) {
        errors.push('Name is required');
    } else if (name.length > 100) {
        errors.push('Name must be 100 characters or fewer');
    }
    return { valid: errors.length === 0, errors, name };
}

export function sanitizeCharacterInput(data) {
    if (!data || typeof data !== 'object') return { name: '', avatarUrl: '', ttsVoice: '' };
    let name = typeof data.name === 'string' ? data.name.trim() : '';
    name = name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100);

    let avatarUrl = typeof data.avatar_url === 'string' ? data.avatar_url.trim() : '';
    if (avatarUrl) {
        const lower = avatarUrl.toLowerCase();
        if (lower.startsWith('file:') || lower.startsWith('javascript:') || lower.startsWith('data:') || avatarUrl.includes('..')) {
            avatarUrl = '';
        }
    }

    const ttsVoice = typeof data.tts_voice === 'string' ? data.tts_voice : '';

    return { name, avatarUrl, ttsVoice };
}

export function normalizeMemory(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        id: typeof raw.id === 'string' ? raw.id : String(raw.id || ''),
        characterId: raw.character_id != null ? String(raw.character_id) : '',
        content: typeof raw.content === 'string' ? raw.content : '',
        type: typeof raw.type === 'string' ? raw.type : 'fact',
        importance: typeof raw.importance === 'number' && Number.isFinite(raw.importance)
            ? Math.max(0, Math.min(1, raw.importance)) : 0.5,
        pinned: raw.pinned === true,
        sourceConversationId: raw.source_conversation_id != null ? String(raw.source_conversation_id) : '',
        sourceConversationTitle: typeof raw.source_conversation_title === 'string' ? raw.source_conversation_title : '',
        createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
        updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : '',
    };
}

export function normalizeMemorySource(memory, conversations) {
    if (!memory) return { label: '', available: false };
    if (!memory.sourceConversationId) return { label: 'No source', available: false };
    const conv = (conversations || []).find(c => c.id === memory.sourceConversationId);
    if (!conv) return { label: 'Source unavailable', available: false };
    return { label: conv.title || 'Untitled', available: true };
}

export function validateMemoryForm(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
        return { valid: false, errors: ['Invalid form data'] };
    }
    const content = typeof data.content === 'string' ? data.content.trim() : '';
    if (!content) {
        errors.push('Content is required');
    } else if (content.length > 2000) {
        errors.push('Content must be 2000 characters or fewer');
    }
    const type = typeof data.type === 'string' ? data.type : '';
    const allowedTypes = ['fact', 'preference', 'event', 'relationship', 'other'];
    if (!allowedTypes.includes(type)) {
        errors.push('Invalid type');
    }
    const importance = typeof data.importance === 'number' ? data.importance : NaN;
    if (isNaN(importance) || importance < 0 || importance > 1) {
        errors.push('Importance must be between 0 and 1');
    }
    return { valid: errors.length === 0, errors, content, type, importance };
}

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

/**
 * Selects the first MIME type from candidates that the given
 * isTypeSupported predicate accepts. Returns '' if none are supported.
 * @param {string[]} candidates
 * @param {(mime: string) => boolean} isTypeSupported
 * @returns {string}
 */
export function selectSupportedMime(candidates, isTypeSupported) {
    for (const mime of candidates) {
        if (isTypeSupported(mime)) return mime;
    }
    return '';
}

/**
 * Creates a MediaRecorder controller for browser microphone recording.
 * All external dependencies are injectable for deterministic testing.
 * @param {{
 *   getUserMedia?: (constraints: object) => Promise<MediaStream>,
 *   MediaRecorderCtor?: { new (stream: MediaStream, options?: object): any, isTypeSupported: (mime: string) => boolean },
 *   maxDurationMs?: number,
 *   maxSizeBytes?: number,
 *   mimeCandidates?: string[],
 *   onStateChange?: (state: string) => void,
 * }} [deps]
 * @returns {{
 *   state: string,
 *   blob: Blob | null,
 *   error: string | null,
 *   start: () => Promise<void>,
 *   stop: () => void,
 *   cancel: () => void,
 * }}
 */
export function createRecorderController(deps = {}) {
    const {
        getUserMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        MediaRecorderCtor = (typeof MediaRecorder !== 'undefined') ? MediaRecorder : null,
        maxDurationMs = 60000,
        maxSizeBytes = 5 * 1024 * 1024,
        mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'],
        onStateChange = null,
    } = deps;

    let state = 'idle';
    let recorder = null;
    let stream = null;
    let chunks = [];
    let blob = null;
    let error = null;
    let durationTimer = null;
    let startTime = 0;
    let totalSize = 0;
    let _cancelled = false;
    let _selectedMime = '';

    function setState(newState) {
        state = newState;
        if (onStateChange) onStateChange(state);
    }

    function cleanup() {
        if (durationTimer) {
            clearInterval(durationTimer);
            durationTimer = null;
        }
        if (stream) {
            for (const track of stream.getTracks()) {
                track.stop();
            }
            stream = null;
        }
        recorder = null;
        chunks = [];
        totalSize = 0;
    }

    async function start() {
        if (state === 'recording') return;

        if (!MediaRecorderCtor) {
            setState('error');
            error = 'MediaRecorder not supported';
            return;
        }

        _selectedMime = selectSupportedMime(mimeCandidates, (m) => MediaRecorderCtor.isTypeSupported(m));

        try {
            stream = await getUserMedia({ audio: true });
        } catch (e) {
            setState('error');
            error = (e && e.name === 'NotAllowedError') ? 'Permission denied' : 'Microphone unavailable';
            return;
        }

        try {
            const options = _selectedMime ? { mimeType: _selectedMime } : {};
            recorder = new MediaRecorderCtor(stream, options);
        } catch (e) {
            cleanup();
            setState('error');
            error = 'Failed to create recorder';
            return;
        }

        chunks = [];
        totalSize = 0;
        blob = null;
        error = null;
        _cancelled = false;

        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                totalSize += event.data.size;
                if (totalSize > maxSizeBytes) {
                    if (recorder && recorder.state === 'recording') {
                        recorder.stop();
                    }
                    return;
                }
                chunks.push(event.data);
            }
        };

        recorder.onstop = () => {
            if (_cancelled) {
                _cancelled = false;
                blob = null;
                chunks = [];
                totalSize = 0;
                setState('idle');
            } else if (state === 'recording') {
                blob = new Blob(chunks, { type: _selectedMime || 'audio/webm' });
                setState('stopped');
            }
            cleanup();
        };

        setState('recording');
        startTime = Date.now();
        recorder.start(250);

        durationTimer = setInterval(() => {
            if (Date.now() - startTime >= maxDurationMs) {
                if (recorder && recorder.state === 'recording') {
                    recorder.stop();
                }
            }
        }, 100);
        // Node's test runner must not stay alive solely for this browser timer.
        if (typeof durationTimer.unref === 'function') durationTimer.unref();
    }

    function stop() {
        if (state !== 'recording') return;
        if (recorder && recorder.state === 'recording') {
            recorder.stop();
        }
    }

    function cancel() {
        if (state !== 'recording') return;
        _cancelled = true;
        if (recorder && recorder.state === 'recording') {
            recorder.stop();
        }
    }

    function discard() {
        blob = null;
        if (state === 'stopped') setState('idle');
    }

    return {
        get state() { return state; },
        get blob() { return blob; },
        get error() { return error; },
        start,
        stop,
        cancel,
        discard,
    };
}

/**
 * Submits one recorded Blob to the server-owned STT endpoint. The controller
 * deliberately has no send-chat dependency: successful text is returned for
 * the composer to review and edit.
 * @param {{ fetchFn?: typeof fetch, getCsrfToken?: () => Promise<string>, onStateChange?: (state: string) => void }} [deps]
 */
export function createTranscriptionController(deps = {}) {
    const { fetchFn = fetch, getCsrfToken, onStateChange = null, maxSizeBytes = 5 * 1024 * 1024 } = deps;
    let state = 'idle';
    let error = '';

    function setState(next) {
        state = next;
        if (onStateChange) onStateChange(state);
    }

    async function transcribe(blob) {
        if (!(blob instanceof Blob) || blob.size === 0 || state === 'busy') return null;
        if (blob.size > maxSizeBytes) {
            error = 'Recording too large. Please try again.';
            setState('error');
            return null;
        }
        error = '';
        setState('busy');
        try {
            const form = new FormData();
            form.append('audio', blob, 'recording.webm');
            const token = getCsrfToken ? await getCsrfToken() : '';
            const response = await fetchFn('/api/openparlor/stt/transcribe', {
                method: 'POST',
                headers: token ? { 'X-CSRF-Token': token } : {},
                body: form,
            });
            const result = await response.json().catch(() => null);
            if (!response.ok || !result || typeof result.text !== 'string' || !result.text.trim()) throw new Error('failed');
            setState('ready');
            return result.text.trim();
        } catch {
            error = 'Transcription failed. Please try again.';
            setState('error');
            return null;
        }
    }

    return { get state() { return state; }, get error() { return error; }, transcribe };
}

/**
 * Creates a voice-turn latency timer for development-only instrumentation.
 * Tracks phases: recording→STT, send→first token, first token→complete,
 * complete→TTS ready, and total turn time. Never logs content.
 * @param {{ now?: () => number, logFn?: (data: object) => void }} [deps]
 * @returns {{
 *   start: () => void,
 *   cancel: () => void,
 *   markRecordingEnd: () => void,
 *   markSttComplete: () => void,
 *   markSendStart: () => void,
 *   markFirstToken: () => void,
 *   markStreamComplete: () => void,
 *   markTtsReady: () => void,
 *   report: () => object | null,
 *   log: () => void,
 *   active: boolean,
 * }}
 */
export function createVoiceTurnTimer(deps = {}) {
    const now = deps.now || (() => performance.now());
    const logFn = deps.logFn || null;

    let recordingEnd = null;
    let sttComplete = null;
    let sendStart = null;
    let firstToken = null;
    let streamComplete = null;
    let ttsReady = null;
    let active = false;

    function start() {
        active = true;
        recordingEnd = null;
        sttComplete = null;
        sendStart = null;
        firstToken = null;
        streamComplete = null;
        ttsReady = null;
    }

    function cancel() {
        active = false;
        recordingEnd = null;
        sttComplete = null;
        sendStart = null;
        firstToken = null;
        streamComplete = null;
        ttsReady = null;
    }

    function markRecordingEnd() {
        if (!active) return;
        recordingEnd = now();
    }

    function markSttComplete() {
        if (!active) return;
        sttComplete = now();
    }

    function markSendStart() {
        if (!active) return;
        sendStart = now();
    }

    function markFirstToken() {
        if (!active) return;
        if (firstToken === null) firstToken = now();
    }

    function markStreamComplete() {
        if (!active) return;
        streamComplete = now();
    }

    function markTtsReady() {
        if (!active) return;
        ttsReady = now();
    }

    function getPhaseMs(from, to) {
        if (from == null || to == null) return null;
        return to - from;
    }

    function report() {
        if (!active) return null;
        return {
            recordingToStt: getPhaseMs(recordingEnd, sttComplete),
            sendToFirstToken: getPhaseMs(sendStart, firstToken),
            firstTokenToComplete: getPhaseMs(firstToken, streamComplete),
            completeToTts: getPhaseMs(streamComplete, ttsReady),
            totalTurn: getPhaseMs(recordingEnd, ttsReady),
        };
    }

    function log() {
        const phases = report();
        if (!phases) return;
        const output = {
            recordingToStt: phases.recordingToStt != null ? Math.round(phases.recordingToStt) + 'ms' : 'n/a',
            sendToFirstToken: phases.sendToFirstToken != null ? Math.round(phases.sendToFirstToken) + 'ms' : 'n/a',
            firstTokenToComplete: phases.firstTokenToComplete != null ? Math.round(phases.firstTokenToComplete) + 'ms' : 'n/a',
            completeToTts: phases.completeToTts != null ? Math.round(phases.completeToTts) + 'ms' : 'n/a',
            totalTurn: phases.totalTurn != null ? Math.round(phases.totalTurn) + 'ms' : 'n/a',
        };
        if (logFn) {
            logFn(output);
        } else {
            console.debug('[voice-turn]', output);
        }
    }

    return {
        start,
        cancel,
        markRecordingEnd,
        markSttComplete,
        markSendStart,
        markFirstToken,
        markStreamComplete,
        markTtsReady,
        report,
        log,
        get active() { return active; },
    };
}

/**
 * Creates a playback controller that manages audio synthesis and playback
 * for a single message at a time. All external dependencies are injectable
 * for deterministic testing.
 * @param {{
 *   fetchFn?: (url: string, options?: object) => Promise<Response>,
 *   createObjectURL?: (blob: Blob) => string,
 *   revokeObjectURL?: (url: string) => void,
 *   audioFactory?: (url: string) => { play: () => Promise<void>, pause: () => void, src: string }
 * }} [deps]
 * @returns {{
 *   play: (text: string, voice: string) => Promise<string>,
 *   stop: () => void,
 *   replay: (text: string, voice: string) => Promise<string>,
 *   isPlaying: boolean
 * }}
 */
export function createPlaybackController(deps = {}) {
    const {
        fetchFn = (url, opts) => fetch(url, opts),
        createObjectURL = (blob) => URL.createObjectURL(blob),
        revokeObjectURL = (url) => URL.revokeObjectURL(url),
        audioFactory = (url) => new Audio(url),
        getCsrfToken = null,
    } = deps;

    let currentAudio = null;
    let currentUrl = null;
    let _isPlaying = false;
    let generation = 0;
    let _onEnded = null;

    function stop() {
        generation++;
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.src = '';
            currentAudio = null;
        }
        if (currentUrl) {
            revokeObjectURL(currentUrl);
            currentUrl = null;
        }
        _isPlaying = false;
        if (_onEnded) {
            const cb = _onEnded;
            _onEnded = null;
            cb();
        }
    }

    async function play(text, voice) {
        stop();
        const gen = generation;
        const headers = { 'Content-Type': 'application/json' };
        if (getCsrfToken) {
            const token = await getCsrfToken();
            if (token) headers['X-CSRF-Token'] = token;
        }
        const res = await fetchFn('/api/openparlor/tts/synthesize', {
            method: 'POST',
            headers,
            body: JSON.stringify({ text, voice }),
        });
        if (gen !== generation) return null;
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Synthesis failed'));
        }
        const blob = await res.blob();
        if (gen !== generation) return null;
        currentUrl = createObjectURL(blob);
        currentAudio = audioFactory(currentUrl);
        const audio = currentAudio;
        if (typeof audio.addEventListener === 'function') {
            audio.addEventListener('ended', () => {
                if (currentAudio === audio) {
                    stop();
                }
            }, { once: true });
        }
        _isPlaying = true;
        try {
            await audio.play();
        } catch (error) {
            if (currentAudio === audio) stop();
            throw error;
        }
        return currentUrl;
    }

    function replay(text, voice) {
        return play(text, voice);
    }

    return {
        play,
        stop,
        replay,
        get isPlaying() { return _isPlaying; },
        set onEnded(fn) { _onEnded = fn; },
        get onEnded() { return _onEnded; },
    };
}

/**
 * Creates a sequential playback queue for group-speaker TTS replies.
 * Items are played one at a time in enqueue order. All external
 * dependencies are injectable for deterministic testing.
 * @param {{
 *   playItem?: (text: string, voice: string) => Promise<void>,
 *   onAllDone?: () => void,
 * }} [deps]
 * @returns {{
 *   enqueue: (text: string, voice: string) => void,
 *   clear: () => void,
 *   playAll: () => Promise<void>,
 *   isPlaying: boolean,
 *   pending: number,
 * }}
 */
export function createGroupPlaybackQueue(deps = {}) {
    const {
        playItem = async () => {},
        onAllDone = null,
    } = deps;

    let queue = [];
    let _isPlaying = false;
    let generation = 0;

    function enqueue(text, voice) {
        if (!text || !text.trim() || !voice) return;
        queue.push({ text, voice });
    }

    function clear() {
        generation++;
        queue = [];
        _isPlaying = false;
    }

    async function playAll() {
        if (queue.length === 0) return;
        const gen = generation;
        _isPlaying = true;
        let hadError = false;
        try {
            for (const item of queue) {
                if (gen !== generation) return;
                await playItem(item.text, item.voice);
            }
        } catch {
            hadError = true;
        } finally {
            if (gen === generation) {
                _isPlaying = false;
                queue = [];
                if (!hadError && onAllDone) onAllDone();
            }
        }
    }

    return {
        enqueue,
        clear,
        playAll,
        get isPlaying() { return _isPlaying; },
        get pending() { return queue.length; },
    };
}

// ─── Browser application ─────────────────────────────────────────────────────

if (typeof document !== 'undefined') {
    const conversationList = document.getElementById('conversationList');
    const characterList = document.getElementById('characterList');
    const characterSelect = document.getElementById('characterSelect');
    const newChatButton = document.getElementById('newChatButton');
    const messagesEl = document.getElementById('messages');
    const chatTitle = document.getElementById('chatTitle');
    const chatSubtitle = document.getElementById('chatSubtitle');
    const messageInput = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');
    const characterForm = document.getElementById('characterForm');
    const charNameInput = document.getElementById('charNameInput');
    const charAvatarInput = document.getElementById('charAvatarInput');
    const charAvatarFileInput = document.getElementById('charAvatarFileInput');
    const charFormError = document.getElementById('charFormError');
    const charFormSave = document.getElementById('charFormSave');
    const charFormCancel = document.getElementById('charFormCancel');
    const charVoiceSelect = document.getElementById('charVoiceSelect');
    const newCharacterButton = document.getElementById('newCharacterButton');
    const modelStatusDot = document.getElementById('modelStatusDot');
    const modelStatusBody = document.getElementById('modelStatusBody');
    const autoSpeakButton = document.getElementById('autoSpeakButton');
    const voiceModeButton = document.getElementById('voiceModeButton');

    let characters = [];
    let conversations = [];
    let currentConversation = null;
    let currentMessages = [];
    let isSending = false;
    let editingCharacterId = null;
    let ttsVoices = { voices: [], available: false };
    const playback = createPlaybackController({ getCsrfToken });
    let ttsMarkedForTurn = false;
    const groupQueue = createGroupPlaybackQueue({
        playItem: (text, voice) => {
            return new Promise((resolve, reject) => {
                let settled = false;
                const onEnd = () => {
                    if (!settled) { settled = true; resolve(); }
                };
                playback.onEnded = onEnd;
                playback.play(text, voice).then(() => {
                    if (!ttsMarkedForTurn) {
                        ttsMarkedForTurn = true;
                        voiceTurnTimer.markTtsReady();
                    }
                }).catch((e) => {
                    if (!settled) { settled = true; reject(e); }
                });
            });
        },
        onAllDone: () => {
            if (isDev) voiceTurnTimer.log();
            voiceTurnTimer.cancel();
        },
    });
    let selectionEpoch = 0;
    let recordingInterruptionPending = false;
    const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const voiceTurnTimer = createVoiceTurnTimer();

    // ── Auto-speak state ───────────────────────────────────────────────────

    function getAutoSpeakState(conversationId) {
        if (!conversationId) return false;
        try {
            return normalizeAutoSpeakState(localStorage.getItem('openparlor-auto-speak-' + conversationId));
        } catch {
            return false;
        }
    }

    function setAutoSpeakState(conversationId, enabled) {
        if (!conversationId) return;
        try {
            localStorage.setItem('openparlor-auto-speak-' + conversationId, enabled ? 'true' : 'false');
        } catch {
            // storage unavailable
        }
    }

    function updateAutoSpeakButton() {
        if (!autoSpeakButton) return;
        if (!currentConversation) {
            autoSpeakButton.hidden = true;
            return;
        }
        autoSpeakButton.hidden = false;
        const enabled = getAutoSpeakState(currentConversation.id);
        autoSpeakButton.setAttribute('aria-pressed', String(enabled));
        autoSpeakButton.textContent = enabled ? 'Auto-speak: On' : 'Auto-speak: Off';
    }

    // ── Voice mode state ───────────────────────────────────────────────────

    function getVoiceModeState(conversationId) {
        if (!conversationId) return false;
        try {
            return normalizeVoiceModeState(localStorage.getItem('openparlor-voice-mode-' + conversationId));
        } catch {
            return false;
        }
    }

    function setVoiceModeState(conversationId, enabled) {
        if (!conversationId) return;
        try {
            localStorage.setItem('openparlor-voice-mode-' + conversationId, enabled ? 'true' : 'false');
        } catch {
            // storage unavailable
        }
    }

    function updateVoiceModeButton() {
        if (!voiceModeButton) return;
        if (!currentConversation) {
            voiceModeButton.hidden = true;
            return;
        }
        voiceModeButton.hidden = false;
        const enabled = getVoiceModeState(currentConversation.id);
        voiceModeButton.setAttribute('aria-pressed', String(enabled));
        voiceModeButton.textContent = enabled ? 'Voice: On' : 'Voice: Off';
    }

    // ── Rendering helpers ──────────────────────────────────────────────────

    function renderState(container, type, text) {
        container.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'state-' + type;
        el.textContent = text;
        container.appendChild(el);
    }

    function renderConversations() {
        conversationList.innerHTML = '';

        if (conversations.length === 0) {
            renderState(conversationList, 'empty', 'No conversations yet.');
            return;
        }

        for (const conv of conversations) {
            const char = characters.find(c => c.id === conv.characterId);
            const item = document.createElement('div');
            item.className = 'conversation' + (currentConversation && currentConversation.id === conv.id ? ' active' : '');
            item.dataset.id = conv.id;

            const titleEl = document.createElement('div');
            titleEl.className = 'conversation-title';
            titleEl.textContent = conv.title;

            const metaEl = document.createElement('div');
            metaEl.className = 'conversation-preview';
            const parts = [];
            if (char) parts.push(char.name);
            const time = formatRelativeTime(conv.updatedAt);
            if (time) parts.push(time);
            metaEl.textContent = parts.join(' · ');

            item.append(titleEl, metaEl);
            item.addEventListener('click', () => selectConversation(conv.id));
            conversationList.appendChild(item);
        }
    }

    function renderCharacters() {
        const selectedCharacterId = characterSelect.value;
        characterList.innerHTML = '';
        characterSelect.innerHTML = '<option value="">Select a character…</option>';

        if (characters.length === 0) {
            renderState(characterList, 'empty', 'No characters found.');
            newChatButton.disabled = true;
            characterSelect.disabled = true;
            return;
        }

        for (const char of characters) {
            // Sidebar card
            const card = document.createElement('div');
            card.className = 'character-card';
            card.dataset.id = char.id;

            const avatar = document.createElement('div');
            avatar.className = 'avatar';
            if (char.avatarUrl) {
                const img = document.createElement('img');
                img.src = char.avatarUrl;
                img.alt = char.name;
                img.className = 'avatar-img';
                avatar.appendChild(img);
            } else {
                avatar.textContent = char.name.charAt(0).toUpperCase();
            }

            const info = document.createElement('div');
            info.className = 'character-info';
            const nameEl = document.createElement('div');
            nameEl.className = 'character-name';
            nameEl.textContent = char.name;
            info.appendChild(nameEl);

            card.append(avatar, info);
            card.addEventListener('click', () => showCharacterForm(char));

            const deleteButton = document.createElement('button');
            deleteButton.className = 'character-delete-btn';
            deleteButton.type = 'button';
            deleteButton.title = 'Delete character';
            deleteButton.setAttribute('aria-label', `Delete ${char.name}`);
            deleteButton.textContent = '✕';
            deleteButton.addEventListener('click', event => {
                event.stopPropagation();
                handleDeleteCharacter(char);
            });
            card.appendChild(deleteButton);
            characterList.appendChild(card);

            // Select option
            const opt = document.createElement('option');
            opt.value = char.id;
            opt.textContent = char.name;
            characterSelect.appendChild(opt);
        }

        // Make the primary action usable immediately when characters exist.
        // Preserve an explicit selection when re-rendering after edits.
        characterSelect.value = characters.some(char => char.id === selectedCharacterId)
            ? selectedCharacterId
            : characters[0].id;
        characterSelect.disabled = false;
        newChatButton.disabled = false;
    }

    function showCharacterForm(character) {
        editingCharacterId = character ? character.id : null;
        charNameInput.value = character ? character.name : '';
        charAvatarInput.value = character ? character.avatarUrl : '';
        charAvatarFileInput.value = '';
        populateVoiceSelect(character ? character.ttsVoice : '');
        charFormError.hidden = true;
        charFormError.textContent = '';
        characterForm.hidden = false;
        charNameInput.focus();
    }

    function populateVoiceSelect(selectedVoice) {
        charVoiceSelect.innerHTML = '<option value="">No voice</option>';
        for (const voice of ttsVoices.voices) {
            const opt = document.createElement('option');
            opt.value = voice;
            opt.textContent = voice;
            charVoiceSelect.appendChild(opt);
        }
        charVoiceSelect.value = selectedVoice || '';
    }

    function hideCharacterForm() {
        editingCharacterId = null;
        characterForm.hidden = true;
        charNameInput.value = '';
        charAvatarInput.value = '';
        charAvatarFileInput.value = '';
        charVoiceSelect.value = '';
        charFormError.hidden = true;
        charFormError.textContent = '';
    }

    function showFormError(message) {
        charFormError.textContent = message;
        charFormError.hidden = false;
    }

    function renderMessages() {
        messagesEl.innerHTML = '';

        if (!currentConversation) {
            renderState(messagesEl, 'empty', 'No conversation selected.');
            return;
        }

        if (currentMessages.length === 0) {
            renderState(messagesEl, 'empty', 'No messages yet. Say hello!');
            return;
        }

        for (const msg of currentMessages) {
            const isUser = msg.role === 'user';
            const messageEl = document.createElement('div');
            messageEl.className = 'message' + (isUser ? ' user-message' : '');

            const msgCharId = !isUser && msg.character_id ? msg.character_id : currentConversation.characterId;
            const char = characters.find(c => c.id === msgCharId);
            const charName = char ? char.name : 'Assistant';

            if (!isUser) {
                const avatar = document.createElement('div');
                avatar.className = 'avatar';
                if (char && char.avatarUrl) {
                    const img = document.createElement('img');
                    img.src = char.avatarUrl;
                    img.alt = charName;
                    img.className = 'avatar-img';
                    avatar.appendChild(img);
                } else {
                    avatar.textContent = charName.charAt(0).toUpperCase();
                }
                messageEl.appendChild(avatar);
            }

            const content = document.createElement('div');
            content.className = 'message-content';

            const speakerEl = document.createElement('div');
            speakerEl.className = 'speaker';
            speakerEl.textContent = isUser ? 'You' : charName;

            const bubble = document.createElement('div');
            bubble.className = 'bubble';
            bubble.textContent = msg.content;

            content.append(speakerEl, bubble);

            if (!isUser && msg.content) {
                const actions = document.createElement('div');
                actions.className = 'message-actions';

                const voice = char ? char.ttsVoice : '';

                const playBtn = document.createElement('button');
                playBtn.className = 'play-btn';
                playBtn.setAttribute('aria-label', 'Play message');
                playBtn.textContent = '▶';
                playBtn.addEventListener('click', async () => {
                    try {
                        groupQueue.clear();
                        await playback.play(msg.content, voice);
                        updatePlaybackButtons();
                    } catch {
                        // silent
                    }
                });

                const stopBtn = document.createElement('button');
                stopBtn.className = 'stop-btn';
                stopBtn.setAttribute('aria-label', 'Stop playback');
                stopBtn.textContent = '■';
                stopBtn.addEventListener('click', () => {
                    groupQueue.clear();
                    playback.stop();
                    updatePlaybackButtons();
                });

                const replayBtn = document.createElement('button');
                replayBtn.className = 'replay-btn';
                replayBtn.setAttribute('aria-label', 'Replay message');
                replayBtn.textContent = '↺';
                replayBtn.addEventListener('click', async () => {
                    try {
                        groupQueue.clear();
                        await playback.replay(msg.content, voice);
                        updatePlaybackButtons();
                    } catch {
                        // silent
                    }
                });

                actions.append(playBtn, stopBtn, replayBtn);
                content.appendChild(actions);
            }

            messageEl.appendChild(content);
            messagesEl.appendChild(messageEl);
        }

        scrollMessages();
    }

    function updatePlaybackButtons() {
        const buttons = messagesEl.querySelectorAll('.message-actions');
        for (const actions of buttons) {
            const playBtn = actions.querySelector('.play-btn');
            const stopBtn = actions.querySelector('.stop-btn');
            const replayBtn = actions.querySelector('.replay-btn');
            if (playBtn) playBtn.disabled = playback.isPlaying;
            if (stopBtn) stopBtn.disabled = !playback.isPlaying;
            if (replayBtn) replayBtn.disabled = playback.isPlaying;
        }
    }

    function updateChatHeader() {
        if (!currentConversation) {
            chatTitle.textContent = 'OpenParlor';
            chatSubtitle.textContent = 'Select a conversation to begin';
            messageInput.disabled = true;
            sendButton.disabled = true;
            updateAutoSpeakButton();
            updateVoiceModeButton();
            renderParticipants();
            return;
        }
        const char = characters.find(c => c.id === currentConversation.characterId);
        chatTitle.textContent = currentConversation.title;
        chatSubtitle.textContent = char ? char.name : '';
        messageInput.disabled = false;
        sendButton.disabled = false;
        updateAutoSpeakButton();
        updateVoiceModeButton();
        renderParticipants();
    }

    function scrollMessages() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // ── Participants ───────────────────────────────────────────────────────

    const participantsBar = document.getElementById('participantsBar');
    const participantsList = document.getElementById('participantsList');
    const addParticipantButton = document.getElementById('addParticipantButton');
    const addParticipantSelect = document.getElementById('addParticipantSelect');

    function renderParticipants() {
        if (!participantsBar) return;
        if (!currentConversation) {
            participantsBar.hidden = true;
            return;
        }
        participantsBar.hidden = false;
        participantsList.innerHTML = '';

        const participants = currentConversation.participants || [];
        for (const p of participants) {
            const char = characters.find(c => c.id === p.characterId);
            const chip = document.createElement('span');
            chip.className = 'participant-chip';
            chip.textContent = char ? char.name : p.characterId;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'participant-remove';
            removeBtn.setAttribute('aria-label', 'Remove ' + (char ? char.name : p.characterId));
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', async () => {
                const remaining = participants.filter(x => x.characterId !== p.characterId);
                if (remaining.length === 0) return;
                await updateParticipants(remaining.map(x => x.characterId));
            });

            chip.appendChild(removeBtn);
            participantsList.appendChild(chip);
        }

        // Populate add-select with characters not already participants
        if (addParticipantSelect) {
            addParticipantSelect.innerHTML = '<option value="">Add character…</option>';
            const participantIds = new Set(participants.map(p => p.characterId));
            for (const char of characters) {
                if (participantIds.has(char.id)) continue;
                const opt = document.createElement('option');
                opt.value = char.id;
                opt.textContent = char.name;
                addParticipantSelect.appendChild(opt);
            }
            addParticipantSelect.disabled = participants.length >= 10;
        }
    }

    async function updateParticipants(characterIds) {
        try {
            const token = await getCsrfToken();
            const res = await fetch('/api/openparlor/conversations/' + encodeURIComponent(currentConversation.id) + '/participants', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                },
                body: JSON.stringify({ character_ids: characterIds }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(normalizeServiceError(err, 'Failed to update participants'));
            }
            const updated = normalizeConversation(await res.json());
            currentConversation = updated;
            renderParticipants();
            renderConversations();
        } catch (e) {
            renderState(messagesEl, 'error', e.message || 'Failed to update participants.');
        }
    }

    if (addParticipantButton) {
        addParticipantButton.addEventListener('click', () => {
            if (!addParticipantSelect || !addParticipantSelect.value) return;
            const currentIds = (currentConversation.participants || []).map(p => p.characterId);
            const newIds = [...currentIds, addParticipantSelect.value];
            updateParticipants(newIds);
        });
    }

    // ── API helpers ────────────────────────────────────────────────────────

    async function fetchModelStatus() {
        try {
            const res = await fetch('/api/openparlor/model-status');
            if (!res.ok) throw new Error('Failed to load model status');
            const data = await res.json();
            return normalizeModelStatus(data);
        } catch {
            return normalizeModelStatus(null);
        }
    }

    function renderModelStatus(status) {
        if (!modelStatusDot || !modelStatusBody) return;

        modelStatusDot.className = 'model-status-dot' + (status.connected ? ' connected' : ' unavailable');

        modelStatusBody.innerHTML = '';

        if (!status.provider && !status.model) {
            const el = document.createElement('div');
            el.className = 'model-status-unavailable';
            el.textContent = 'No model configured';
            modelStatusBody.appendChild(el);
            return;
        }

        if (status.model) {
            const modelEl = document.createElement('div');
            modelEl.className = 'model-status-model';
            modelEl.textContent = status.model;
            modelStatusBody.appendChild(modelEl);
        }

        if (status.endpointLabel) {
            const endpointEl = document.createElement('div');
            endpointEl.className = 'model-status-endpoint';
            endpointEl.textContent = status.endpointLabel;
            modelStatusBody.appendChild(endpointEl);
        }

        if (status.connected && status.models.length > 0) {
            const modelsEl = document.createElement('div');
            modelsEl.className = 'model-status-models';
            modelsEl.textContent = status.models.slice(0, 5).join(', ');
            if (status.models.length > 5) {
                modelsEl.textContent += ` +${status.models.length - 5} more`;
            }
            modelStatusBody.appendChild(modelsEl);
        } else if (!status.connected) {
            const unavailableEl = document.createElement('div');
            unavailableEl.className = 'model-status-unavailable';
            unavailableEl.textContent = 'Unavailable';
            modelStatusBody.appendChild(unavailableEl);
        }
    }

    // ── Health status ──────────────────────────────────────────────────────

    const healthStatusList = document.getElementById('healthStatusList');
    const prerequisiteStatus = document.getElementById('prerequisiteStatus');

    async function fetchHealthStatus() {
        try {
            const res = await fetch('/api/openparlor/health');
            if (!res.ok) throw new Error('Failed to load health status');
            const data = await res.json();
            return normalizeHealthStatus(data);
        } catch {
            return normalizeHealthStatus(null);
        }
    }

    function renderHealthStatus(status) {
        if (!healthStatusList) return;
        healthStatusList.innerHTML = '';

        const services = [
            { key: 'model', name: 'Model' },
            { key: 'tts', name: 'TTS' },
            { key: 'stt', name: 'STT' },
        ];

        for (const svc of services) {
            const item = document.createElement('div');
            item.className = 'health-item';

            const service = status[svc.key];
            const available = service ? service.available : false;

            item.setAttribute('role', 'status');
            item.setAttribute('aria-label', svc.name + (available ? ' available' : ' unavailable'));

            const dot = document.createElement('span');
            dot.className = 'health-dot' + (available ? ' available' : ' unavailable');
            dot.setAttribute('aria-hidden', 'true');

            const label = document.createElement('span');
            label.className = 'health-label';
            label.textContent = svc.name + (available ? '' : ' — unavailable');

            item.append(dot, label);
            healthStatusList.appendChild(item);
        }
    }

    function renderPrerequisiteStatus(status) {
        if (!prerequisiteStatus) return;
        prerequisiteStatus.innerHTML = '';
        if (status.deferred) {
            const el = document.createElement('div');
            el.className = 'prerequisite-deferred';
            el.textContent = status.label;
            prerequisiteStatus.appendChild(el);
        }
    }

    async function getCsrfToken() {
        const res = await fetch('/csrf-token');
        if (!res.ok) throw new Error('Unable to get CSRF token');
        const data = await res.json();
        if (typeof data.token !== 'string' || !data.token) {
            throw new Error('Invalid CSRF token');
        }
        return data.token;
    }

    async function fetchCharacters() {
        const res = await fetch('/api/openparlor/characters');
        if (!res.ok) throw new Error('Failed to load characters');
        const data = await res.json();
        characters = (Array.isArray(data) ? data : []).map(normalizeCharacter).filter(Boolean);
    }

    async function fetchConversations() {
        const res = await fetch('/api/openparlor/conversations');
        if (!res.ok) throw new Error('Failed to load conversations');
        const data = await res.json();
        conversations = (Array.isArray(data) ? data : []).map(normalizeConversation).filter(Boolean);
        conversations.sort((a, b) => {
            const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return tb - ta;
        });
    }

    async function fetchConversation(id) {
        const res = await fetch('/api/openparlor/conversations/' + encodeURIComponent(id));
        if (!res.ok) throw new Error('Failed to load conversation');
        const data = await res.json();
        currentConversation = normalizeConversation(data);
        currentMessages = Array.isArray(data.messages) ? data.messages : [];
    }

    async function createConversation(characterId, title) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/conversations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
            },
            body: JSON.stringify({ character_id: characterId, title: title }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to create conversation'));
        }
        return normalizeConversation(await res.json());
    }

    async function createCharacter(name, avatarUrl, ttsVoice) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/characters', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
            },
            body: JSON.stringify({ name, avatar_url: avatarUrl, tts_voice: ttsVoice }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to create character'));
        }
        return normalizeCharacter(await res.json());
    }

    async function updateCharacter(id, name, avatarUrl, ttsVoice) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/characters/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
            },
            body: JSON.stringify({ name, avatar_url: avatarUrl, tts_voice: ttsVoice }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to update character'));
        }
        return normalizeCharacter(await res.json());
    }

    async function uploadCharacterAvatar(file) {
        if (!file) return '';
        const allowedTypes = new Map([
            ['image/bmp', 'bmp'],
            ['image/png', 'png'],
            ['image/jpeg', 'jpg'],
            ['image/webp', 'webp'],
            ['image/gif', 'gif'],
            ['image/jfif', 'jfif'],
        ]);
        const format = allowedTypes.get(file.type);
        if (!format) throw new Error('Choose a PNG, JPEG, GIF, WebP, BMP, or JFIF image.');
        if (file.size > 5 * 1024 * 1024) throw new Error('Avatar images must be 5 MB or smaller.');

        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Unable to read the avatar image.'));
            reader.readAsDataURL(file);
        });
        const comma = dataUrl.indexOf(',');
        if (comma < 0) throw new Error('Invalid avatar image data.');

        const token = await getCsrfToken();
        const res = await fetch('/api/images/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({
                image: dataUrl.slice(comma + 1),
                format,
                filename: `openparlor-avatar-${Date.now()}.${format}`,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to upload avatar'));
        }
        const data = await res.json();
        if (typeof data.path !== 'string' || !data.path.startsWith('/')) throw new Error('Avatar upload returned an invalid path.');
        return data.path;
    }

    async function deleteCharacter(id) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/characters/' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': token },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to delete character'));
        }
    }

    async function fetchTtsVoices() {
        try {
            const res = await fetch('/api/openparlor/tts/voices');
            if (!res.ok) throw new Error('Failed to load TTS voices');
            ttsVoices = normalizeTtsVoices(await res.json());
        } catch {
            ttsVoices = { voices: [], available: false };
        }
    }

    // ── Memory panel ───────────────────────────────────────────────────────

    const memoryPanel = document.getElementById('memoryPanel');
    let memories = [];
    let editingMemoryId = null;

    async function fetchMemories(characterId) {
        if (!characterId) {
            memories = [];
            return;
        }
        try {
            const res = await fetch('/api/openparlor/memories?character_id=' + encodeURIComponent(characterId));
            if (!res.ok) throw new Error('Failed to load memories');
            const data = await res.json();
            memories = (Array.isArray(data) ? data : []).map(normalizeMemory).filter(Boolean);
            memories.sort((a, b) => {
                if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
                return b.importance - a.importance;
            });
        } catch {
            memories = [];
        }
    }

    async function updateMemoryApi(id, body) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/memories/' + encodeURIComponent(id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to update memory'));
        }
        return normalizeMemory(await res.json());
    }

    async function deleteMemoryApi(id) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/memories/' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': token },
        });
        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to delete memory'));
        }
    }

    async function pinMemoryApi(id, pinned) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/memories/' + encodeURIComponent(id) + '/pin', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({ pinned }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to pin memory'));
        }
        return normalizeMemory(await res.json());
    }

    function renderMemoryPanel() {
        if (!memoryPanel) return;
        memoryPanel.innerHTML = '';

        if (!currentConversation) {
            const el = document.createElement('div');
            el.className = 'state-empty';
            el.textContent = 'Select a conversation to view memories.';
            memoryPanel.appendChild(el);
            return;
        }

        const charId = currentConversation.characterId;
        if (!charId) {
            const el = document.createElement('div');
            el.className = 'state-empty';
            el.textContent = 'No character selected.';
            memoryPanel.appendChild(el);
            return;
        }

        if (memories.length === 0) {
            const el = document.createElement('div');
            el.className = 'state-empty';
            el.textContent = 'No memories yet.';
            memoryPanel.appendChild(el);
            return;
        }

        for (const mem of memories) {
            const row = document.createElement('div');
            row.className = 'memory-row' + (mem.pinned ? ' pinned' : '');
            row.dataset.id = mem.id;

            if (editingMemoryId === mem.id) {
                renderMemoryEditForm(row, mem);
            } else {
                renderMemoryDisplay(row, mem);
            }

            memoryPanel.appendChild(row);
        }
    }

    function renderMemoryDisplay(row, mem) {
        const source = normalizeMemorySource(mem, conversations);

        const contentEl = document.createElement('div');
        contentEl.className = 'memory-content';
        contentEl.textContent = mem.content.length > 120 ? mem.content.slice(0, 120) + '…' : mem.content;

        const metaEl = document.createElement('div');
        metaEl.className = 'memory-meta';

        const typeBadge = document.createElement('span');
        typeBadge.className = 'memory-type memory-type-' + mem.type;
        typeBadge.textContent = mem.type;

        const importanceEl = document.createElement('span');
        importanceEl.className = 'memory-importance';
        importanceEl.textContent = '★'.repeat(Math.round(mem.importance * 4) + 1);

        metaEl.append(typeBadge, importanceEl);

        const sourceEl = document.createElement('div');
        sourceEl.className = 'memory-source';
        sourceEl.textContent = source.label;
        if (!source.available) {
            sourceEl.classList.add('memory-source-unavailable');
        }

        const actionsEl = document.createElement('div');
        actionsEl.className = 'memory-actions';

        const pinBtn = document.createElement('button');
        pinBtn.className = 'memory-action-btn pin-btn' + (mem.pinned ? ' active' : '');
        pinBtn.title = mem.pinned ? 'Unpin' : 'Pin';
        pinBtn.textContent = mem.pinned ? '📌' : '📍';
        pinBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const updated = await pinMemoryApi(mem.id, !mem.pinned);
                const idx = memories.findIndex(m => m.id === mem.id);
                if (idx !== -1) memories[idx] = updated;
                memories.sort((a, b) => {
                    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
                    return b.importance - a.importance;
                });
                renderMemoryPanel();
            } catch { /* silent */ }
        });

        const editBtn = document.createElement('button');
        editBtn.className = 'memory-action-btn edit-btn';
        editBtn.title = 'Edit';
        editBtn.textContent = '✎';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingMemoryId = mem.id;
            renderMemoryPanel();
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'memory-action-btn delete-btn';
        delBtn.title = 'Delete';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                await deleteMemoryApi(mem.id);
                memories = memories.filter(m => m.id !== mem.id);
                renderMemoryPanel();
            } catch { /* silent */ }
        });

        actionsEl.append(pinBtn, editBtn, delBtn);
        row.append(contentEl, metaEl, sourceEl, actionsEl);
    }

    function renderMemoryEditForm(row, mem) {
        const form = document.createElement('div');
        form.className = 'memory-edit-form';

        const textarea = document.createElement('textarea');
        textarea.className = 'memory-edit-content';
        textarea.rows = 3;
        textarea.maxLength = 2000;
        textarea.value = mem.content;
        textarea.placeholder = 'Memory content…';

        const typeSelect = document.createElement('select');
        typeSelect.className = 'memory-edit-type';
        for (const t of ['fact', 'preference', 'event', 'relationship', 'other']) {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            typeSelect.appendChild(opt);
        }
        typeSelect.value = mem.type;

        const importanceInput = document.createElement('input');
        importanceInput.type = 'range';
        importanceInput.className = 'memory-edit-importance';
        importanceInput.min = '0';
        importanceInput.max = '1';
        importanceInput.step = '0.05';
        importanceInput.value = String(mem.importance);

        const importanceLabel = document.createElement('span');
        importanceLabel.className = 'memory-importance-value';
        importanceLabel.textContent = String(mem.importance);
        importanceInput.addEventListener('input', () => {
            importanceLabel.textContent = importanceInput.value;
        });

        const errorEl = document.createElement('div');
        errorEl.className = 'memory-edit-error';
        errorEl.hidden = true;

        const actions = document.createElement('div');
        actions.className = 'memory-edit-actions';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'memory-edit-save';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', async () => {
            const validation = validateMemoryForm({
                content: textarea.value,
                type: typeSelect.value,
                importance: Number(importanceInput.value),
            });
            if (!validation.valid) {
                errorEl.textContent = validation.errors.join(' ');
                errorEl.hidden = false;
                return;
            }
            try {
                saveBtn.disabled = true;
                const updated = await updateMemoryApi(mem.id, {
                    content: validation.content,
                    type: validation.type,
                    importance: validation.importance,
                });
                const idx = memories.findIndex(m => m.id === mem.id);
                if (idx !== -1) memories[idx] = updated;
                editingMemoryId = null;
                renderMemoryPanel();
            } catch (e) {
                errorEl.textContent = e.message || 'Failed to save';
                errorEl.hidden = false;
            } finally {
                saveBtn.disabled = false;
            }
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'memory-edit-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            editingMemoryId = null;
            renderMemoryPanel();
        });

        actions.append(saveBtn, cancelBtn);
        form.append(textarea, typeSelect, importanceInput, importanceLabel, errorEl, actions);
        row.appendChild(form);
    }

    async function refreshMemoryPanel() {
        if (!currentConversation) {
            renderMemoryPanel();
            return;
        }
        await fetchMemories(currentConversation.characterId);
        renderMemoryPanel();
    }

    // ── Actions ────────────────────────────────────────────────────────────

    async function handleCharacterFormSubmit() {
        const rawName = charNameInput.value;
        const rawAvatar = charAvatarInput.value;

        const validation = validateCharacterForm({ name: rawName });
        if (!validation.valid) {
            showFormError(validation.errors.join(' '));
            return;
        }

        const rawVoice = charVoiceSelect.value;
        const sanitized = sanitizeCharacterInput({ name: rawName, avatar_url: rawAvatar, tts_voice: rawVoice });

        try {
            charFormSave.disabled = true;
            const uploadedAvatarUrl = await uploadCharacterAvatar(charAvatarFileInput.files[0]);
            const avatarUrl = uploadedAvatarUrl || sanitized.avatarUrl;
            let saved;
            if (editingCharacterId) {
                saved = await updateCharacter(editingCharacterId, sanitized.name, avatarUrl, sanitized.ttsVoice);
                const idx = characters.findIndex(c => c.id === editingCharacterId);
                if (idx !== -1) characters[idx] = saved;
            } else {
                saved = await createCharacter(sanitized.name, avatarUrl, sanitized.ttsVoice);
                characters.push(saved);
            }
            hideCharacterForm();
            renderCharacters();
        } catch (e) {
            showFormError(e.message || 'Something went wrong');
        } finally {
            charFormSave.disabled = false;
        }
    }

    async function handleDeleteCharacter(character) {
        if (!window.confirm(`Delete ${character.name}? This cannot be undone.`)) return;
        try {
            await deleteCharacter(character.id);
            characters = characters.filter(item => item.id !== character.id);
            if (editingCharacterId === character.id) hideCharacterForm();
            if (currentConversation && currentConversation.characterId === character.id) {
                currentConversation = null;
                currentMessages = [];
                renderMessages();
                updateChatHeader();
                refreshMemoryPanel();
            }
            renderCharacters();
            renderConversations();
        } catch (e) {
            showFormError(e.message || 'Failed to delete character');
            characterForm.hidden = false;
        }
    }

    async function selectConversation(id) {
        selectionEpoch++;
        groupQueue.clear();
        playback.stop();
        voiceTurnTimer.cancel();
        try {
            renderState(messagesEl, 'loading', 'Loading…');
            await fetchConversation(id);
            renderConversations();
            renderMessages();
            updateChatHeader();
            refreshMemoryPanel();
        } catch (e) {
            renderState(messagesEl, 'error', 'Failed to load conversation.');
        }
    }

    async function handleNewConversation() {
        const charId = characterSelect.value;
        if (!charId) {
            renderState(messagesEl, 'error', 'Select a character before starting a conversation.');
            return;
        }

        const char = characters.find(c => c.id === charId);
        const title = char ? 'Chat with ' + char.name : 'New conversation';

        try {
            newChatButton.disabled = true;
            const conv = await createConversation(charId, title);
            conversations.unshift(conv);
            currentConversation = conv;
            currentMessages = [];
            renderConversations();
            renderMessages();
            updateChatHeader();
            refreshMemoryPanel();
        } catch (e) {
            renderState(messagesEl, 'error', 'Failed to create conversation.');
        } finally {
            newChatButton.disabled = false;
        }
    }

    async function sendMessage() {
        const text = messageInput.value.trim();
        if (!text || isSending || !currentConversation) return;

        const sendConversationId = currentConversation.id;
        const sendEpoch = selectionEpoch;

        isSending = true;
        sendButton.disabled = true;
        messageInput.value = '';
        voiceTurnTimer.markSendStart();

        // Append user message locally
        currentMessages.push({ role: 'user', content: text });
        renderMessages();

        // Create assistant bubble placeholder
        const assistantMsgStartIndex = currentMessages.length;
        let currentAssistantMsg = { role: 'assistant', content: '' };
        currentMessages.push(currentAssistantMsg);
        renderMessages();

        let lastBubble = messagesEl.querySelector('.message:last-child .bubble');
        let speakerCount = 0;

        try {
            const token = await getCsrfToken();
            const response = await fetch('/api/openparlor/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                },
                body: JSON.stringify({
                    messages: currentMessages.map(m => ({ role: mapChatRole(m.role), content: m.content })),
                    stream: true,
                    conversation_id: currentConversation.id,
                }),
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                currentAssistantMsg.content = normalizeServiceError(err, 'Request failed');
                if (lastBubble) lastBubble.textContent = currentAssistantMsg.content;
                scrollMessages();
                if (isDev) voiceTurnTimer.log();
                voiceTurnTimer.cancel();
                return;
            }

            const parser = createNdjsonParser();
            const reader = response.body.getReader();
            let processedCount = 0;
            let streamDone = false;
            let hadStreamError = false;

            function processNewRecords() {
                for (let i = processedCount; i < parser.records.length; i++) {
                    const record = parser.records[i];
                    if (record.type === 'speaker_start') {
                        speakerCount++;
                        if (speakerCount === 1) {
                            currentAssistantMsg.character_id = record.character_id;
                        } else {
                            currentAssistantMsg = { role: 'assistant', content: '', character_id: record.character_id };
                            currentMessages.push(currentAssistantMsg);
                            renderMessages();
                            lastBubble = messagesEl.querySelector('.message:last-child .bubble');
                        }
                    } else if (record.type === 'delta') {
                        voiceTurnTimer.markFirstToken();
                        currentAssistantMsg.content += record.text;
                        if (lastBubble) lastBubble.textContent = currentAssistantMsg.content;
                        scrollMessages();
                    } else if (record.type === 'speaker_end') {
                        // Speaker finished; next speaker_start will create a new message
                    } else if (record.type === 'error') {
                        hadStreamError = true;
                        currentAssistantMsg.content += '\n' + (record.error || 'Stream error');
                        if (lastBubble) lastBubble.textContent = currentAssistantMsg.content;
                        scrollMessages();
                    } else if (record.type === 'done') {
                        streamDone = true;
                        break;
                    }
                }
                processedCount = parser.records.length;
            }

            while (!streamDone) {
                const { done, value } = await reader.read();
                if (done) break;
                parser.feed(value);
                processNewRecords();
            }

            parser.flush();
            processNewRecords();
            if (streamDone) voiceTurnTimer.markStreamComplete();

            // Auto-speak: queue completed group replies for sequential playback
            let ttsHandled = false;
            ttsMarkedForTurn = false;
            if (
                shouldAutoSpeak({
                    sendConversationId,
                    currentConversationId: currentConversation ? currentConversation.id : '',
                    sendEpoch,
                    selectionEpoch,
                    streamDone,
                    hadStreamError,
                    autoSpeakEnabled: getAutoSpeakState(sendConversationId) || getVoiceModeState(sendConversationId),
                    hasContent: currentMessages.slice(assistantMsgStartIndex).some(m => m.content),
                    recordingActive: recorder.state === 'recording' || recordingInterruptionPending,
                })
            ) {
                const turnMessages = currentMessages.slice(assistantMsgStartIndex);
                for (const msg of turnMessages) {
                    if (!msg.content) continue;
                    const charId = msg.character_id || currentConversation.characterId;
                    const char = characters.find(c => c.id === charId);
                    const voice = char ? char.ttsVoice : '';
                    if (voice) {
                        groupQueue.enqueue(msg.content, voice);
                    }
                }
                if (groupQueue.pending > 0) {
                    ttsHandled = true;
                    groupQueue.playAll().catch(() => {});
                    updatePlaybackButtons();
                }
            }
            if (!ttsHandled) {
                if (isDev) voiceTurnTimer.log();
                voiceTurnTimer.cancel();
            }
        } catch {
            currentAssistantMsg.content = 'Connection error';
            if (lastBubble) lastBubble.textContent = currentAssistantMsg.content;
            scrollMessages();
            if (isDev) voiceTurnTimer.log();
            voiceTurnTimer.cancel();
        } finally {
            isSending = false;
            sendButton.disabled = false;
        }
    }

    // ── Event listeners ────────────────────────────────────────────────────

    newChatButton.addEventListener('click', handleNewConversation);

    sendButton.addEventListener('click', sendMessage);

    messageInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    newCharacterButton.addEventListener('click', () => showCharacterForm(null));

    charFormSave.addEventListener('click', handleCharacterFormSubmit);

    charFormCancel.addEventListener('click', hideCharacterForm);

    charNameInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleCharacterFormSubmit();
        }
    });

    if (autoSpeakButton) {
        autoSpeakButton.addEventListener('click', () => {
            if (!currentConversation) return;
            const newState = !getAutoSpeakState(currentConversation.id);
            setAutoSpeakState(currentConversation.id, newState);
            if (!newState) {
                groupQueue.clear();
                playback.stop();
                updatePlaybackButtons();
            }
            updateAutoSpeakButton();
        });
    }

    if (voiceModeButton) {
        voiceModeButton.addEventListener('click', () => {
            if (!currentConversation) return;
            const newState = !getVoiceModeState(currentConversation.id);
            setVoiceModeState(currentConversation.id, newState);
            if (!newState) {
                groupQueue.clear();
                playback.stop();
                updatePlaybackButtons();
            }
            updateVoiceModeButton();
        });
    }

    // ── Recorder controls ──────────────────────────────────────────────────

    const recordButton = document.getElementById('recordButton');
    const stopRecordButton = document.getElementById('stopRecordButton');
    const cancelRecordButton = document.getElementById('cancelRecordButton');
    const transcribeButton = document.getElementById('transcribeButton');
    const recordingIndicator = document.getElementById('recordingIndicator');
    const recorderError = document.getElementById('recorderError');
    const transcriptionStatus = document.getElementById('transcriptionStatus');

    function updateRecorderUI() {
        const s = recorder.state;
        if (recordButton) {
            recordButton.hidden = (s === 'recording');
            recordButton.disabled = (s === 'recording');
        }
        if (transcribeButton) {
            transcribeButton.hidden = (s !== 'stopped');
            transcribeButton.disabled = transcription.state === 'busy';
        }
        if (stopRecordButton) {
            stopRecordButton.hidden = (s !== 'recording');
        }
        if (cancelRecordButton) {
            cancelRecordButton.hidden = (s !== 'recording');
        }
        if (recordingIndicator) {
            recordingIndicator.hidden = (s !== 'recording');
        }
        if (recorderError) {
            if (s === 'error' && recorder.error) {
                recorderError.textContent = recorder.error;
                recorderError.hidden = false;
            } else {
                recorderError.hidden = true;
                recorderError.textContent = '';
            }
        }
    }

    const recorder = createRecorderController({
        onStateChange: (s) => {
            updateRecorderUI();
            if (s === 'stopped') {
                const voiceMode = getVoiceModeState(currentConversation ? currentConversation.id : '');
                if (voiceMode) {
                    voiceTurnTimer.start();
                    voiceTurnTimer.markRecordingEnd();
                }
            }
            if (s === 'idle' || s === 'error') {
                voiceTurnTimer.cancel();
            }
        },
    });
    const transcription = createTranscriptionController({
        getCsrfToken,
        onStateChange: () => {
            updateRecorderUI();
            updateTranscriptionStatus();
        },
    });

    function updateTranscriptionStatus() {
        if (!transcriptionStatus) return;
        if (transcription.state === 'busy') {
            transcriptionStatus.textContent = 'Transcribing…';
            transcriptionStatus.hidden = false;
        } else if (transcription.state === 'error') {
            transcriptionStatus.textContent = transcription.error;
            transcriptionStatus.hidden = false;
        } else {
            transcriptionStatus.textContent = '';
            transcriptionStatus.hidden = true;
        }
    }

    if (typeof MediaRecorder === 'undefined' && recordButton) {
        recordButton.disabled = true;
        recordButton.title = 'Recording not supported in this browser';
    }

    if (recordButton) {
        recordButton.addEventListener('click', async () => {
            recordingInterruptionPending = true;
            playback.stop();
            updatePlaybackButtons();
            try {
                await recorder.start();
            } finally {
                recordingInterruptionPending = false;
                updateRecorderUI();
            }
        });
    }

    if (stopRecordButton) {
        stopRecordButton.addEventListener('click', () => {
            recorder.stop();
        });
    }

    if (cancelRecordButton) {
        cancelRecordButton.addEventListener('click', () => {
            recorder.cancel();
        });
    }

    if (transcribeButton) {
        transcribeButton.addEventListener('click', async () => {
            const blob = recorder.blob;
            updateTranscriptionStatus();
            const text = await transcription.transcribe(blob);
            if (text) {
                voiceTurnTimer.markSttComplete();
                const voiceMode = getVoiceModeState(currentConversation ? currentConversation.id : '');
                if (shouldAutoSendTranscription({ voiceModeEnabled: voiceMode, transcriptionSucceeded: true })) {
                    messageInput.value = text;
                    await sendMessage();
                } else {
                    messageInput.value = text;
                    messageInput.focus();
                    if (isDev) voiceTurnTimer.log();
                    voiceTurnTimer.cancel();
                }
            } else {
                if (isDev) voiceTurnTimer.log();
                voiceTurnTimer.cancel();
            }
            recorder.discard();
            updateRecorderUI();
            updateTranscriptionStatus();
        });
    }

    // ── Initial load ───────────────────────────────────────────────────────

    async function init() {
        try {
            await Promise.all([fetchCharacters(), fetchConversations(), fetchTtsVoices()]);
            renderCharacters();
            renderConversations();
            updateChatHeader();
        } catch (e) {
            renderState(conversationList, 'error', 'Failed to load data.');
            renderState(characterList, 'error', 'Failed to load data.');
        }

        const status = await fetchModelStatus();
        renderModelStatus(status);

        const health = await fetchHealthStatus();
        renderHealthStatus(health);

        const prereq = await fetchDeferredPrerequisite();
        renderPrerequisiteStatus(prereq);
    }

    init();
}
