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
/**
 * Creates a continuous local microphone recorder for hands-free mode.
 *
 * Unlike the push-to-talk RecorderController, this recorder starts capturing
 * immediately and keeps a bounded in-memory ring buffer of timeslice chunks.
 * Audio stays local in the browser the whole time; collectBlob(sinceMs)
 * finalizes one utterance blob (chunks at/after sinceMs, pre-roll included)
 * and prunes them from the ring. The blob is then handed to the existing
 * transcription controller — never streamed continuously to STT.
 *
 * @param {{
 *   getUserMedia?: (constraints: object) => Promise<MediaStream>,
 *   MediaRecorderCtor?: Function,
 *   constraints?: object,
 *   fallbackConstraint?: object,
 *   timesliceMs?: number,
 *   maxBufferMs?: number,
 *   mimeCandidates?: string[],
 *   now?: () => number,
 *   onStateChange?: (state: string) => void,
 * }} [deps]
 * @returns {{
 *   state: 'idle'|'recording'|'error',
 *   error: string|null,
 *   isRecording: boolean,
 *   start: () => Promise<void>,
 *   stop: () => void,
 *   collectBlob: (sinceMs: number) => Blob | null,
 *   clearBuffer: () => void,
 * }}
 */
export function createContinuousRecorder(deps = {}) {
    const {
        getUserMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        MediaRecorderCtor = (typeof MediaRecorder !== 'undefined') ? MediaRecorder : null,
        constraints = { audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } },
        fallbackConstraint = { audio: true },
        timesliceMs = 250,
        maxBufferMs = 30000,
        mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'],
        now = () => Date.now(),
        onStateChange = null,
    } = deps;

    let state = 'idle';
    let error = null;
    let recorder = null;
    let stream = null;
    let ring = [];
    let selectedMime = '';

    function setState(next) {
        state = next;
        if (onStateChange) onStateChange(state);
    }

    function cleanup() {
        if (stream) {
            for (const track of stream.getTracks()) track.stop();
            stream = null;
        }
        if (recorder) {
            recorder.ondataavailable = null;
            recorder = null;
        }
        ring = [];
    }

    function pruneRing() {
        const cutoff = now() - maxBufferMs;
        while (ring.length > 0 && ring[0].at < cutoff) ring.shift();
    }

    async function start() {
        if (state === 'recording') return;
        if (!MediaRecorderCtor) {
            setState('error');
            error = 'MediaRecorder is not supported in this browser.';
            return;
        }
        selectedMime = selectSupportedMime(mimeCandidates, (m) => MediaRecorderCtor.isTypeSupported(m));
        let s = null;
        try {
            s = await getUserMedia(constraints);
        } catch {
            try {
                s = await getUserMedia(fallbackConstraint);
            } catch (e) {
                setState('error');
                error = (e && e.name === 'NotAllowedError') ? 'Microphone permission denied.' : 'Microphone unavailable.';
                return;
            }
        }
        stream = s;
        try {
            recorder = new MediaRecorderCtor(stream, selectedMime ? { mimeType: selectedMime } : {});
        } catch {
            cleanup();
            setState('error');
            error = 'Could not start the microphone.';
            return;
        }
        ring = [];
        error = null;
        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                ring.push({ chunk: event.data, at: now() });
                pruneRing();
            }
        };
        try {
            recorder.start(timesliceMs);
        } catch {
            cleanup();
            setState('error');
            error = 'Could not start the microphone.';
            return;
        }
        setState('recording');
    }

    function collectBlob(sinceMs) {
        if (ring.length === 0) return null;
        const since = Number.isFinite(sinceMs) ? sinceMs : 0;
        const picked = ring.filter((entry) => entry.at >= since);
        if (picked.length === 0) return null;
        const pickedSet = new Set(picked);
        ring = ring.filter((entry) => !pickedSet.has(entry));
        return new Blob(picked.map((entry) => entry.chunk), { type: selectedMime || 'audio/webm' });
    }

    function clearBuffer() {
        ring = [];
    }

    function stop() {
        if (recorder && recorder.state === 'recording') {
            try {
                recorder.stop();
            } catch { /* ignore */ }
        }
        cleanup();
        setState('idle');
    }

    return {
        get state() { return state; },
        get error() { return error; },
        get isRecording() { return state === 'recording'; },
        start,
        stop,
        collectBlob,
        clearBuffer,
    };
}

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
