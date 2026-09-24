// ─── OpenParlor audio helpers: TTS/STT state normalization and playback/recording controllers. ─────────────────────────────────────────

import { normalizeServiceError } from './ui.js';

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
 *   play: (text: string, voice: string, onEnded?: () => void) => Promise<string | null>,
 *   stop: () => void,
 *   replay: (text: string, voice: string, onEnded?: () => void) => Promise<string | null>,
 *   isPlaying: boolean
 * }}
 *
 * Completion-callback contract: `play()`/`replay()` first tear down any
 * current playback, then arm the new `onEnded` callback tagged with the new
 * generation — so the previous teardown can never consume the new
 * playback's callback, and the callback is in place before the new audio
 * can complete. The armed callback fires exactly once, and only when the
 * playback actually started: on the audio's natural 'ended' event, or when
 * stop() is called explicitly while it is the current playback. A replaced
 * playback (superseded by a newer play) or a failed start discards its
 * callback without firing it — in the failed case the Promise rejects, and
 * in the replaced case it resolves null.
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
    let endHandler = null;
    let endHandlerGen = 0;

    function releaseAudio() {
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
    }

    function stop() {
        generation += 1;
        const ended = endHandler;
        const endedGen = endHandlerGen;
        endHandler = null;
        endHandlerGen = 0;
        releaseAudio();
        // An explicit stop resolves the playback that was current until
        // this call (armed at generation-1) exactly once. A callback armed
        // at any other generation (e.g. by an in-flight superseded play)
        // is stale and is dropped.
        if (ended && endedGen === generation - 1) ended();
    }

    function cancelCurrent() {
        // Replacement inside play(): tear down the previous playback
        // (audio + object URL) without firing its completion callback —
        // it was superseded, not completed or explicitly stopped, so the
        // incoming playback takes over the speaking phase untouched.
        generation += 1;
        endHandler = null;
        endHandlerGen = 0;
        releaseAudio();
    }

    async function play(text, voice, onEnded) {
        cancelCurrent();
        const gen = generation;
        if (typeof onEnded === 'function') {
            // Armed only after the previous playback is fully torn down, so
            // this stop() call can never consume the new playback's
            // callback, and a stale callback can never outlive this attempt.
            endHandler = onEnded;
            endHandlerGen = gen;
        }
        let audio = null;
        try {
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
            audio = currentAudio;
            if (typeof audio.addEventListener === 'function') {
                audio.addEventListener('ended', () => {
                    if (currentAudio !== audio) return; // replaced or stopped
                    const url = currentUrl;
                    currentAudio = null;
                    currentUrl = null;
                    _isPlaying = false;
                    if (url) revokeObjectURL(url);
                    const ended = endHandler;
                    if (ended && endHandlerGen === gen) {
                        endHandler = null;
                        endHandlerGen = 0;
                        ended();
                    }
                }, { once: true });
            }
            _isPlaying = true;
            await audio.play();
            return currentUrl;
        } catch (error) {
            // Starting failed: this attempt never produced playback, so its
            // callback must not fire now or later — it is discarded, and the
            // caller is notified by the rejection itself.
            if (endHandlerGen === gen) {
                endHandler = null;
                endHandlerGen = 0;
            }
            if (audio !== null && currentAudio === audio) {
                stop();
            }
            throw error;
        }
    }

    function replay(text, voice, onEnded) {
        return play(text, voice, onEnded);
    }

    return {
        play,
        stop,
        replay,
        get isPlaying() { return _isPlaying; },
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

    /**
    /**
     * Start playing the queue.  The implementation is generation‑safe: if
     * {@link clear} increments the generation while a play is in progress, the
     * old loop will exit gracefully without mutating the new generation's
     * state.  Concurrent calls to {@link playAll} while a playback is
     * already running are effectively no‑ops.
     */
    async function playAll() {
        // No-op if already playing or queue empty.
        if (_isPlaying || queue.length === 0) return;
        const gen = generation;
        _isPlaying = true;
        let hadError = false;
        const promise = (async () => {
            try {
                while (queue.length > 0 && gen === generation) {
                    const item = queue.shift();
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
        })();
        return promise;
    }

    return {
        enqueue,
        clear,
        playAll,
        get isPlaying() { return _isPlaying; },
        get pending() { return queue.length; },
    };
}

// ─── VOICE-002 streaming TTS: incremental sentence splitter ──────────────────────────────────────────────────────────

/**
 * Forced-break length for streaming TTS input. Buffers without a natural
 * sentence boundary are broken at this length, preferring a whitespace
 * position and hard-cutting only when none exists.
 */
const SENTENCE_SPLITTER_MAX_LENGTH = 300;

/**
 * Case-insensitive trailing abbreviations whose final period must not be
 * treated as a sentence boundary. The candidate checked is the word
 * immediately preceding the period (including any internal periods) plus the
 * period itself, e.g. "U.S." for the text "U.S. government".
 */
const SENTENCE_SPLITTER_ABBREVIATIONS = new Set([
    'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'st.', 'sr.', 'jr.', 'vs.', 'etc.',
    'e.g.', 'i.e.', 'u.s.', 'u.k.', 'a.m.', 'p.m.', 'no.', 'fig.',
    'approx.', 'inc.', 'ltd.', 'co.', 'gen.', 'capt.', 'sgt.',
]);

/**
 * All sentence-terminating characters. A run (cluster) of these characters
 * counts as a single boundary.
 */
const SENTENCE_SPLITTER_TERMS = new Set(['.', '!', '?', '…', '。', '！', '？']);

/**
 * Terminators that end a sentence immediately without requiring confirmed
 * following whitespace (CJK text and ellipses do not get trailing spaces).
 */
const SENTENCE_SPLITTER_IMMEDIATE_TERMS = new Set(['…', '。', '！', '？']);

/**
 * Closing quotes and brackets absorbed into the sentence that precedes them.
 */
const SENTENCE_SPLITTER_CLOSERS = new Set([
    '"', String.fromCharCode(39), '”', '’', ')', ']', '}', '」', '』', '）', '】', '》',
]);

/**
 * Region definitions dropped entirely from spoken output, in scan order.
 */
const SENTENCE_SPLITTER_BLOCKS = [
    { name: 'fence', open: '```', close: '```' },
    { name: 'think', open: '<' + 'think>', close: '</' + 'think>' },
    { name: 'analysis', open: '<analysis>', close: '</analysis>' },
];

/**
 * Creates an incremental sentence splitter for streaming TTS input.
 *
 * Text arrives in arbitrary chunks (for example SSE deltas). `feed` appends
 * a chunk and returns only the sentences that became newly completed;
 * unfinished text stays internal. `finish` flushes the final remainder
 * exactly once and is idempotent; `feed` calls after `finish` are ignored.
 * No text range is ever emitted twice.
 *
 * Sentence boundaries:
 * - `.`, `!`, `?`, `…`, `。`, `！`, `？`; clusters such as `?!` or `!!!`
 *   form a single boundary.
 * - ASCII terminators (`.`, `!`, `?`) require confirmed following
 *   whitespace — or `finish` — so decimals such as `3.5` and protected
 *   abbreviations such as `Mr.` or `U.S.` never split early.
 * - `…` and the CJK terminators end a sentence immediately.
 * - Newlines end a sentence.
 * - Closing quotes/brackets after a terminator are absorbed into the
 *   sentence, e.g. `"Hello."` is one sentence.
 * - A buffer without a natural boundary is force-broken at 300 characters,
 *   preferring the last whitespace inside the first 300 characters; a hard
 *   cut at 300 is used only when no whitespace exists.
 *
 * Dropped entirely, including across chunk boundaries:
 * - triple-backtick fenced code blocks
 * - think marker blocks (see SENTENCE_SPLITTER_BLOCKS)
 * - `<analysis>...</analysis>` blocks
 *
 * An unterminated block at `finish` time is dropped; text that appeared
 * before its opening marker is still flushed.
 *
 * @returns {{
 *   feed: (chunk: string) => string[],
 *   finish: () => string[],
 * }}
 */
export function createSentenceSplitter() {
    let buffer = '';
    let pendingPrefix = '';
    let inBlock = null;
    let finished = false;

    /**
     * Finds the earliest block opening marker inside text.
     * @param {string} text
     * @returns {{ block: object, index: number } | null}
     */
    function findBlockOpen(text) {
        let best = null;
        for (const block of SENTENCE_SPLITTER_BLOCKS) {
            const index = text.indexOf(block.open);
            if (index !== -1 && (best === null || index < best.index)) {
                best = { block: block, index: index };
            }
        }
        return best;
    }

    /**
     * True when the word immediately before the period cluster (including
     * any internal periods) is a protected abbreviation, e.g. "U.S" for
     * "U.S.".
     * @param {number} clusterStart
     * @returns {boolean}
     */
    function isProtectedAbbreviation(clusterStart) {
        let start = clusterStart;
        while (start > 0 && /[A-Za-z0-9.]/.test(buffer.charAt(start - 1))) {
            start -= 1;
        }
        const candidate = buffer.slice(start, clusterStart) + '.';
        return SENTENCE_SPLITTER_ABBREVIATIONS.has(candidate.toLowerCase());
    }

    /**
     * Finds the earliest confirmed sentence cut inside buffer[0..safeEnd).
     * Returns null when no cut is confirmed — including a terminator that is
     * still waiting for confirming whitespace at the buffer end.
     * @param {number} safeEnd
     * @param {boolean} endConfirmed
     * @returns {{ end: number, text: string } | null}
     */
    function findNaturalCut(safeEnd, endConfirmed) {
        let i = 0;
        while (i < safeEnd) {
            const ch = buffer.charAt(i);
            if (ch === '\n' || ch === '\r') {
                let end = i + 1;
                if (ch === '\r' && buffer.charAt(i + 1) === '\n') {
                    end += 1;
                }
                return { end: end, text: buffer.slice(0, i) };
            }
            if (!SENTENCE_SPLITTER_TERMS.has(ch)) {
                i += 1;
                continue;
            }
            let clusterEnd = i + 1;
            while (clusterEnd < buffer.length && SENTENCE_SPLITTER_TERMS.has(buffer.charAt(clusterEnd))) {
                clusterEnd += 1;
            }
            let j = clusterEnd;
            while (j < buffer.length && SENTENCE_SPLITTER_CLOSERS.has(buffer.charAt(j))) {
                j += 1;
            }
            let immediate = false;
            let periodOnly = true;
            for (let k = i; k < clusterEnd; k += 1) {
                if (buffer.charAt(k) !== '.') {
                    periodOnly = false;
                }
                if (SENTENCE_SPLITTER_IMMEDIATE_TERMS.has(buffer.charAt(k))) {
                    immediate = true;
                }
            }
            let confirmed;
            if (immediate) {
                confirmed = true;
            } else if (j === buffer.length) {
                confirmed = endConfirmed;
            } else {
                confirmed = /\s/.test(buffer.charAt(j));
            }
            if (confirmed && periodOnly && isProtectedAbbreviation(i)) {
                confirmed = false;
            }
            if (confirmed) {
                return { end: j, text: buffer.slice(0, j) };
            }
            if (!immediate && j === buffer.length && !endConfirmed) {
                return null;
            }
            i = clusterEnd;
        }
        return null;
    }

    /**
     * Joins text kept before a removed block with text kept after it,
     * inserting one space when both sides are non-whitespace so words never
     * run together.
     * @param {string} prefix
     * @param {string} suffix
     * @returns {string}
     */
    function joinAfterRemoval(prefix, suffix) {
        if (prefix === '' || suffix === '') {
            return prefix + suffix;
        }
        const last = prefix.charAt(prefix.length - 1);
        const first = suffix.charAt(0);
        if (!/\s/.test(last) && !/\s/.test(first)) {
            return prefix + ' ' + suffix;
        }
        return prefix + suffix;
    }

    /**
     * Chooses a forced break position inside the first 300 characters of
     * text: the last whitespace position when present, else a hard cut at
     * the limit (stepped back one code unit to keep a surrogate pair intact).
     * @param {string} text
     * @returns {number}
     */
    function forcedBreakPosition(text) {
        const limit = SENTENCE_SPLITTER_MAX_LENGTH;
        for (let i = Math.min(limit, text.length) - 1; i >= 0; i -= 1) {
            if (/\s/.test(text.charAt(i))) {
                return i > 0 ? i : limit;
            }
        }
        if (limit < text.length && isHighSurrogate(text.charAt(limit - 1)) && isLowSurrogate(text.charAt(limit))) {
            return limit - 1;
        }
        return limit;
    }

    function isHighSurrogate(ch) {
        const code = ch.charCodeAt(0);
        return code >= 0xd800 && code <= 0xdbff;
    }

    function isLowSurrogate(ch) {
        const code = ch.charCodeAt(0);
        return code >= 0xdc00 && code <= 0xdfff;
    }

    /**
     * Drives the split loop until no more progress is possible and returns
     * the sentences emitted during this pass.
     * @param {boolean} endConfirmed
     * @returns {string[]}
     */
    function process(endConfirmed) {
        const emitted = [];
        for (;;) {
            if (inBlock !== null) {
                const closeIndex = buffer.indexOf(inBlock.close);
                if (closeIndex === -1) {
                    // The close marker may still arrive, possibly split
                    // across chunks, so keep only the longest tail that is
                    // a prefix of it; the rest is dropped block content.
                    const close = inBlock.close;
                    let keep = 0;
                    const maxLen = Math.min(buffer.length, close.length - 1);
                    for (let len = maxLen; len > 0; len -= 1) {
                        if (buffer.slice(buffer.length - len) === close.slice(0, len)) {
                            keep = len;
                            break;
                        }
                    }
                    buffer = buffer.slice(buffer.length - keep);
                    break;
                }
                buffer = joinAfterRemoval(pendingPrefix, buffer.slice(closeIndex + inBlock.close.length));
                pendingPrefix = '';
                inBlock = null;
                continue;
            }
            const open = findBlockOpen(buffer);
            const safeEnd = open !== null ? open.index : buffer.length;
            const cut = findNaturalCut(Math.min(safeEnd, SENTENCE_SPLITTER_MAX_LENGTH), endConfirmed);
            if (cut !== null) {
                const text = cut.text.trim();
                if (text !== '') {
                    emitted.push(text);
                }
                buffer = buffer.slice(cut.end);
                continue;
            }
            if (open !== null) {
                const closeIndex = buffer.indexOf(open.block.close, open.index + open.block.open.length);
                if (closeIndex === -1) {
                    pendingPrefix = buffer.slice(0, open.index);
                    buffer = buffer.slice(open.index + open.block.open.length);
                    inBlock = open.block;
                    break;
                }
                buffer = joinAfterRemoval(buffer.slice(0, open.index), buffer.slice(closeIndex + open.block.close.length));
                continue;
            }
            if (buffer.length >= SENTENCE_SPLITTER_MAX_LENGTH) {
                const pos = forcedBreakPosition(buffer);
                const text = buffer.slice(0, pos).trim();
                if (text !== '') {
                    emitted.push(text);
                }
                buffer = buffer.slice(pos);
                continue;
            }
            break;
        }
        return emitted;
    }

    /**
     * Appends a chunk to the stream and returns the newly completed
     * speakable sentences. Calls after `finish` are ignored.
     * @param {string} chunk
     * @returns {string[]}
     */
    function feed(chunk) {
        if (finished || typeof chunk !== 'string') {
            return [];
        }
        buffer += chunk;
        return process(false);
    }

    /**
     * Flushes the final remainder exactly once. Idempotent: later calls
     * return an empty array.
     * @returns {string[]}
     */
    function finish() {
        if (finished) {
            return [];
        }
        finished = true;
        const emitted = process(true);
        // Content still inside an open block was never speakable, so only
        // the held prefix (text before the open marker) is flushed.
        let rest = inBlock !== null ? pendingPrefix : buffer;
        pendingPrefix = '';
        buffer = '';
        inBlock = null;
        // A held prefix (from an unterminated block) can still exceed the
        // forced length, so apply the same 300-character rule here.
        while (rest.length >= SENTENCE_SPLITTER_MAX_LENGTH) {
            const pos = forcedBreakPosition(rest);
            const piece = rest.slice(0, pos).trim();
            if (piece !== '') {
                emitted.push(piece);
            }
            rest = rest.slice(pos);
        }
        const tail = rest.trim();
        if (tail !== '') {
            emitted.push(tail);
        }
        return emitted;
    }

    return { feed, finish };
}
