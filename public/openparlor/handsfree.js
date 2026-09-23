// ─── OpenParlor Hands-Free conversation mode (TASK-VOICE-HANDSFREE-001) ──────
// Browser-local, half-duplex voice loop:
//   listen → VAD speech start → record utterance → VAD end → STT → auto-send
//   → AI reply → TTS playback → resume listening
//
// Architecture rules honored here:
// - The microphone never streams continuously to STT. A lightweight energy
//   VAD runs entirely in the browser; only a completed utterance blob is
//   submitted to the existing /api/openparlor/stt/transcribe endpoint.
// - Utterance audio comes from the same mono Float32 PCM frames the Web
//   Audio graph already produces (never from a MediaRecorder container): a
//   bounded pre-roll ring keeps the last few hundred ms while listening, and
//   a confirmed utterance is finalized as a standalone WAV (mono, signed
//   16-bit PCM) that ffmpeg/faster-whisper can always decode. Arbitrary
//   middle segments of a WebM/Opus MediaRecorder stream are not guaranteed
//   to be independently decodable, so PCM is the only safe source.
// - The VAD is transport-agnostic: it consumes fixed-size frames
//   ({ samples, sampleRate }) produced by an AudioWorklet (or a
//   ScriptProcessor fallback) and exposes processFrame/hold/release/reset.
//   A later neural VAD (e.g. Silero) can replace createEnergyVad without
//   touching the state machine, as long as it honors that interface.
// - Conversation safety uses the same epoch/generation pattern as the rest
//   of the app: every async boundary (transcription, send) captures the
//   conversation id + selection epoch and re-validates after the await, so a
//   late result can never land in a newer conversation.

export const HANDSFREE_STATES = {
    OFF: 'off',
    LISTENING: 'listening',
    HEARING: 'hearing',
    TRANSCRIBING: 'transcribing',
    WAITING: 'waiting',
    SPEAKING: 'speaking',
    ERROR: 'error',
};

// Safe, user-facing messages per internal error code.
export const HANDSFREE_ERROR_TEXT = {
    'no-conversation': 'Select a conversation to use hands-free.',
    'microphone': 'Microphone unavailable. Click to retry.',
    'permission-denied': 'Microphone permission denied. Click to retry.',
    'device-lost': 'Microphone disconnected. Click to retry.',
    'transcription': 'Transcription failed. Retrying…',
    'send': 'Message could not be sent. Retrying…',
};

// AudioWorklet that chunks the shared mic stream into ~21 ms mono frames and
// posts { samples, sampleRate } to the main thread for VAD analysis.
// NOTE on indexing: `inputs[0]` is the first input port's CHANNEL LIST, so
// `inputs[0][0]` is channel 0's Float32Array — `inputs[0][0][0]` would be a
// single sample. The processor must iterate the channel array, never a
// scalar.
export const HANDSFREE_WORKLET_SOURCE = `class OpHandsFreeFrames extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Float32Array(1024);
        this.offset = 0;
    }
    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;
        const channel = input[0];
        if (!channel || channel.length === 0) return true;
        for (let i = 0; i < channel.length; i += 1) {
            this.buffer[this.offset] = channel[i];
            this.offset += 1;
            if (this.offset === this.buffer.length) {
                this.port.postMessage({ samples: this.buffer.slice(), sampleRate });
                this.offset = 0;
            }
        }
        return true;
    }
}
registerProcessor('op-handsfree-frames', OpHandsFreeFrames);`;

/**
 * Normalizes the persisted hands-free preference.
 * @param {string|boolean|null|undefined} value
 * @returns {boolean}
 */
export function normalizeHandsFreePreference(value) {
    return value === 'true' || value === true;
}

/**
 * Root-mean-square energy of one audio frame (samples in [-1, 1]).
 * @param {ArrayLike<number>} samples
 * @returns {number}
 */
export function computeFrameRms(samples) {
    if (!samples || samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
        const v = samples[i];
        sum += v * v;
    }
    return Math.sqrt(sum / samples.length);
}

// Default energy-VAD tuning. Chosen for consumer mics with browser
// echoCancellation + noiseSuppression enabled; all values are configurable
// per instance so a later adaptive detector can tune them without code
// changes upstream.
const DEFAULT_VAD_OPTIONS = {
    speechThreshold: 0.01,
    silenceThreshold: 0.005,
    startSustainMs: 200,
    endSilenceMs: 900,
    maxUtteranceMs: 15000,
    preRollMs: 300,
};

/**
 * Lightweight RMS energy voice-activity detector.
 *
 * Frame-driven (no wall clock): each processFrame advances an internal clock
 * by the frame's duration, which makes behavior fully deterministic under
 * test. Speech start requires `startSustainMs` of sustained loud frames (a
 * tiny click/spike below that never triggers). Once active, the utterance
 * ends after `endSilenceMs` of sustained quiet frames or when the utterance
 * reaches `maxUtteranceMs` (hard cap). `hold()` suppresses detection while
 * TTS audio plays (half-duplex); `release()` clears any in-progress state.
 *
 * @param {{
 *   speechThreshold?: number,
 *   silenceThreshold?: number,
 *   startSustainMs?: number,
 *   endSilenceMs?: number,
 *   maxUtteranceMs?: number,
 *   preRollMs?: number,
 *   onSpeechStart?: (lookbackMs: number) => void,
 *   onSpeechEnd?: (reason: 'silence'|'max-duration') => void,
 * }} [opts]
 * @returns {{
 *   processFrame: (frame: { samples: ArrayLike<number>, sampleRate?: number }) => void,
 *   hold: () => void,
 *   release: () => void,
 *   reset: () => void,
 *   isActive: boolean,
 *   isHeld: boolean,
 *   preRollMs: number,
 * }}
 */
export function createEnergyVad(opts = {}) {
    const {
        speechThreshold = DEFAULT_VAD_OPTIONS.speechThreshold,
        silenceThreshold = DEFAULT_VAD_OPTIONS.silenceThreshold,
        startSustainMs = DEFAULT_VAD_OPTIONS.startSustainMs,
        endSilenceMs = DEFAULT_VAD_OPTIONS.endSilenceMs,
        maxUtteranceMs = DEFAULT_VAD_OPTIONS.maxUtteranceMs,
        preRollMs = DEFAULT_VAD_OPTIONS.preRollMs,
        onSpeechStart = null,
        onSpeechEnd = null,
    } = opts;

    let holding = false;
    let active = false;
    let speechStreakMs = 0;
    let silenceMs = 0;
    let clockMs = 0;
    let utteranceStartMs = 0;

    function reset() {
        active = false;
        speechStreakMs = 0;
        silenceMs = 0;
    }

    function processFrame(frame) {
        if (!frame || !frame.samples || frame.samples.length === 0) return;
        const sampleRate = frame.sampleRate > 0 ? frame.sampleRate : 48000;
        const frameMs = (frame.samples.length / sampleRate) * 1000;
        clockMs += frameMs;
        if (holding) return;

        const rms = computeFrameRms(frame.samples);
        if (!active) {
            silenceMs = 0;
            if (rms >= speechThreshold) {
                speechStreakMs += frameMs;
                if (speechStreakMs >= startSustainMs) {
                    active = true;
                    silenceMs = 0;
                    // Approximate the true speech onset: the sustained
                    // streak began speechStreakMs ago.
                    utteranceStartMs = Math.max(0, clockMs - speechStreakMs);
                    if (onSpeechStart) {
                        // Tell the caller how far back the confirmed speech
                        // reaches so a capture layer can rewind its pre-roll
                        // to (onset - preRoll) instead of losing the first
                        // startSustainMs of the utterance.
                        onSpeechStart(Math.min(speechStreakMs, clockMs));
                    }
                }
            } else {
                speechStreakMs = 0;
            }
            return;
        }

        // Active utterance: look for endpointing silence or the hard cap.
        if (rms < silenceThreshold) {
            silenceMs += frameMs;
        } else {
            silenceMs = 0;
        }
        if (silenceMs >= endSilenceMs) {
            active = false;
            if (onSpeechEnd) onSpeechEnd('silence');
        } else if (clockMs - utteranceStartMs >= maxUtteranceMs) {
            active = false;
            if (onSpeechEnd) onSpeechEnd('max-duration');
        }
    }

    function hold() {
        holding = true;
    }

    function release() {
        holding = false;
        reset();
    }

    return {
        processFrame,
        hold,
        release,
        reset,
        get isActive() { return active; },
        get isHeld() { return holding; },
        get preRollMs() { return preRollMs; },
    };
}

// ─── PCM utterance capture + WAV encoding ───────────────────────────────────
// Hands-free utterances are built from the mono Float32 PCM frames the Web
// Audio graph already posts (AudioWorklet preferred, ScriptProcessor
// fallback). While listening, a bounded rolling ring keeps only the most
// recent (preRollMs + maxLookbackMs) of audio. When the VAD confirms speech,
// begin(lookbackMs) starts the utterance with that pre-roll rewound to the
// VAD's estimated onset, and every subsequent frame is appended until
// end() finalizes the utterance (bounded by maxUtteranceMs). Frames are
// copied on entry: ScriptProcessor reuses its input buffer, so holding a
// reference would silently corrupt the ring.

/**
 * Encodes mono Float32 samples as a valid standalone WAV blob
 * (RIFF/WAVE, PCM format 1, mono, 16 bits/sample, little-endian).
 * Samples are clamped to [-1, 1] before conversion to signed 16-bit;
 * non-finite samples become silence. The sample rate is taken from the
 * caller (i.e. the Web Audio frames), never hard-coded.
 * @param {ArrayLike<number>} [samples]
 * @param {number} [sampleRate]
 * @returns {Blob} a `audio/wav` blob
 */
export function encodeWavBlob(samples, sampleRate) {
    const n = samples && samples.length > 0 ? samples.length : 0;
    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 48000;
    const dataSize = n * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeAscii = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);          // fmt chunk size
    view.setUint16(20, 1, true);           // audio format: PCM
    view.setUint16(22, 1, true);           // channels: mono
    view.setUint32(24, rate, true);        // sample rate
    view.setUint32(28, rate * 2, true);    // byte rate
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    writeAscii(36, 'data');
    view.setUint32(40, dataSize, true);
    for (let i = 0; i < n; i += 1) {
        let v = samples[i];
        if (!Number.isFinite(v)) v = 0;
        if (v > 1) v = 1; else if (v < -1) v = -1;
        view.setInt16(44 + i * 2, Math.round(v * 32767), true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Bounded PCM utterance buffer for hands-free mode.
 *
 * Deterministic and frame-driven (no wall clock): each processFrame advances
 * the capture by the frame's own sample count, so tests can assert exact
 * sample counts. The pre-roll ring is capped at preRollMs + maxLookbackMs
 * (maxLookbackMs must cover the VAD's startSustainMs so the estimated speech
 * onset is always inside the ring); the active utterance is capped at
 * maxUtteranceMs (oldest frames drop if the VAD ever fails to endpoint).
 *
 * @param {{
 *   preRollMs?: number,
 *   maxLookbackMs?: number,
 *   maxUtteranceMs?: number,
 * }} [opts]
 * @returns {{
 *   processFrame: (frame: { samples: ArrayLike<number>, sampleRate?: number }) => void,
 *   begin: (lookbackMs?: number) => void,
 *   end: () => ({ samples: Float32Array, sampleRate: number, durationMs: number }) | null,
 *   discard: () => void,
 *   isActive: boolean,
 *   sampleRate: number,
 *   bufferedSamples: number,
 * }}
 */
export function createPcmUtteranceCapture(opts = {}) {
    const {
        preRollMs = 300,
        maxLookbackMs = 1000,
        maxUtteranceMs = 15000,
    } = opts;

    let sampleRate = 0;
    let ring = [];           // Float32Array copies of recent frames, oldest first
    let ringSamples = 0;
    let utterance = null;    // Float32Array copies while an utterance is active
    let utteranceSamples = 0;
    let ringCap = 0;
    let utteranceCap = 0;

    function noteRate(rate) {
        if (sampleRate === 0) {
            sampleRate = rate;
            ringCap = Math.ceil(((preRollMs + maxLookbackMs) / 1000) * rate);
            utteranceCap = Math.ceil((maxUtteranceMs / 1000) * rate);
        }
    }

    function pushRing(frame) {
        const copy = new Float32Array(frame.samples);
        ring.push(copy);
        ringSamples += copy.length;
        while (ring.length > 1 && ringSamples > ringCap) {
            ringSamples -= ring[0].length;
            ring.shift();
        }
    }

    function processFrame(frame) {
        if (!frame || !frame.samples || frame.samples.length === 0) return;
        const rate = frame.sampleRate > 0 ? frame.sampleRate : 48000;
        noteRate(rate);
        if (utterance === null) {
            pushRing(frame);
            return;
        }
        const copy = new Float32Array(frame.samples);
        utterance.push(copy);
        utteranceSamples += copy.length;
        while (utterance.length > 1 && utteranceSamples > utteranceCap) {
            utteranceSamples -= utterance[0].length;
            utterance.shift();
        }
    }

    // Starts capturing. The utterance is seeded with the last
    // (preRollMs + lookbackMs) of the pre-roll ring, so it begins at the
    // estimated speech onset minus the configured pre-roll. If the ring is
    // shallower than that (speech started right after the session began),
    // everything the ring holds is used.
    function begin(lookbackMs) {
        if (utterance !== null) return;
        if (sampleRate === 0 || ring.length === 0) {
            utterance = [];
            utteranceSamples = 0;
            return;
        }
        const lookback = Number.isFinite(lookbackMs) && lookbackMs > 0 ? lookbackMs : 0;
        const reach = Math.ceil(((preRollMs + lookback) / 1000) * sampleRate);
        const picked = [];
        let pickedSamples = 0;
        for (let i = ring.length - 1; i >= 0 && pickedSamples < reach; i -= 1) {
            picked.push(ring[i]);
            pickedSamples += ring[i].length;
        }
        picked.reverse();
        utterance = picked;
        utteranceSamples = pickedSamples;
    }

    // Finalizes the active utterance (or returns null when nothing is
    // active or nothing was captured). The pre-roll ring is left intact so
    // the next utterance keeps a rolling pre-roll.
    function end() {
        if (utterance === null) return null;
        const merged = new Float32Array(utteranceSamples);
        let offset = 0;
        for (const chunk of utterance) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        utterance = null;
        utteranceSamples = 0;
        if (merged.length === 0) return null;
        return {
            samples: merged,
            sampleRate,
            durationMs: (merged.length / sampleRate) * 1000,
        };
    }

    // Discards the active utterance AND the pre-roll ring. Used when a
    // session ends, a conversation is invalidated, or TTS playback begins,
    // so stale (or AI) audio can never leak into the next utterance.
    function discard() {
        utterance = null;
        utteranceSamples = 0;
        ring = [];
        ringSamples = 0;
    }

    return {
        processFrame,
        begin,
        end,
        discard,
        get isActive() { return utterance !== null; },
        get sampleRate() { return sampleRate; },
        get bufferedSamples() { return ringSamples; },
    };
}

/**
 * Hands-Free conversation state machine.
 *
 * States: off → listening → hearing → transcribing → waiting →
 *         (speaking during TTS) → listening …, with error recovery.
 *
 * All external dependencies are injectable for deterministic testing:
 * - getConversationId/getEpoch: the conversation-selection guard source
 *   (same epoch pattern used by the existing chat stream);
 * - startListening/stopListening: browser mic + audio-analysis session
 *   (startListening must release any partial resources it opened on
 *   rejection; stopListening must be safe to call when nothing is active);
 * - transcribe(blob): the EXISTING STT endpoint path, returning text or null;
 *   the blob is a standalone WAV produced by the internal PCM utterance
 *   capture (see createPcmUtteranceCapture / encodeWavBlob);
 * - captureFactory/captureOptions: injection seams for the PCM utterance
 *   capture (default: createPcmUtteranceCapture, pre-roll and 15-second cap
 *   aligned with the VAD options);
 * - onSendText(text): the EXISTING chat send pipeline.
 *
 * TTS cooperation (half-duplex): the app calls markSpeakingStart() when AI
 * playback begins (any user speech is discarded and detection is suppressed)
 * and markSpeakingEnd() only when the whole queued playback (including
 * sequential group-character items) has actually finished. Stale callbacks
 * are dropped via a session generation check.
 *
 * @param {{
 *   getConversationId?: () => string,
 *   getEpoch?: () => number,
 *   startListening?: () => Promise<void>,
 *   stopListening?: () => void,
 *   transcribe?: (blob: Blob) => Promise<string | null>,
 *   onSendText?: (text: string) => Promise<void>,
 *   setTimeoutFn?: (fn: () => void, ms: number) => number,
 *   clearTimeoutFn?: (id: number) => void,
 *   errorRecoveryMs?: number,
 *   vadFactory?: (opts: object) => object,
 *   vadOptions?: object,
 *   captureFactory?: (opts: object) => object,
 *   captureOptions?: object,
 *   onStateChange?: (state: string, info: { error?: string }) => void,
 * }} [deps]
 * @returns {{
 *   enable: () => Promise<void>,
 *   disable: () => void,
 *   invalidate: () => void,
 *   onAudioFrame: (frame: { samples: ArrayLike<number>, sampleRate?: number }) => void,
 *   onDeviceLost: () => void,
 *   markSpeakingStart: () => void,
 *   markSpeakingEnd: () => void,
 *   markResponseComplete: () => void,
 *   state: string,
 *   stateInfo: { error?: string },
 *   isActive: boolean,
 *   vad: object,
 *   capture: object,
 * }}
 */
export function createHandsFreeController(deps = {}) {
    const {
        getConversationId = () => '',
        getEpoch = () => 0,
        startListening = async () => {},
        stopListening = () => {},
        transcribe = async () => null,
        onSendText = async () => {},
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        errorRecoveryMs = 3000,
        vadFactory = createEnergyVad,
        vadOptions = {},
        captureFactory = createPcmUtteranceCapture,
        captureOptions = {},
        onStateChange = null,
    } = deps;

    let state = HANDSFREE_STATES.OFF;
    let stateInfo = {};
    let sessionGen = 0;
    let inFlight = null;
    let errorTimer = null;
    let speakSessionGen = null;

    const vad = vadFactory({
        ...vadOptions,
        onSpeechStart: handleSpeechStart,
        onSpeechEnd: handleSpeechEnd,
    });

    // The PCM utterance capture is driven by the exact same frames the VAD
    // consumes (see onAudioFrame), which is what makes the pre-roll and the
    // 15-second cap deterministic. Pre-roll and max-utterance defaults are
    // aligned with the VAD options; captureOptions may override any of them.
    const capture = captureFactory({
        preRollMs: vadOptions.preRollMs,
        maxUtteranceMs: vadOptions.maxUtteranceMs,
        ...captureOptions,
    });

    function setState(next, info = {}) {
        state = next;
        stateInfo = info;
        if (onStateChange) onStateChange(state, info);
    }

    function clearErrorTimer() {
        if (errorTimer !== null) {
            clearTimeoutFn(errorTimer);
            errorTimer = null;
        }
    }

    function canUseConversation() {
        return typeof getConversationId() === 'string' && getConversationId() !== '';
    }

    function discardUtterance() {
        const hadUtterance = inFlight !== null || vad.isActive;
        inFlight = null;
        vad.reset();
        if (hadUtterance) capture.discard();
    }


    async function enable() {
        if (state !== HANDSFREE_STATES.OFF && state !== HANDSFREE_STATES.ERROR) return;
        if (!canUseConversation()) {
            setState(HANDSFREE_STATES.ERROR, { error: 'no-conversation' });
            return;
        }
        const gen = ++sessionGen;
        clearErrorTimer();
        setState(HANDSFREE_STATES.LISTENING);
        try {
            await startListening();
        } catch (e) {
            if (gen !== sessionGen) return;
            const error = (e && e.name === 'NotAllowedError') ? 'permission-denied' : 'microphone';
            setState(HANDSFREE_STATES.ERROR, { error });
            return;
        }
        if (gen !== sessionGen) {
            stopListening();
            return;
        }
        // A (re-)opened mic session starts with a clean pre-roll so audio
        // from a previous session can never seed the first utterance.
        capture.discard();
        setState(HANDSFREE_STATES.LISTENING);
    }

    function disable() {
        sessionGen++;
        clearErrorTimer();
        discardUtterance();
        stopListening();
        setState(HANDSFREE_STATES.OFF);
    }

    // Conversation switched, created, or deleted: an in-flight utterance or
    // transcription belongs to the OLD conversation and must be dropped. If
    // hands-free was active and a conversation is still selected, the
    // already user-authorized mic stream is retained and listening resumes;
    // otherwise the session suspends (off).
    function invalidate() {
        sessionGen++;
        clearErrorTimer();
        discardUtterance();
        speakSessionGen = null;
        if (state === HANDSFREE_STATES.OFF) return;
        if (!canUseConversation()) {
            stopListening();
            setState(HANDSFREE_STATES.OFF);
            return;
        }
        setState(HANDSFREE_STATES.LISTENING);
    }

    function onDeviceLost() {
        if (state === HANDSFREE_STATES.OFF) return;
        sessionGen++;
        clearErrorTimer();
        discardUtterance();
        stopListening();
        // No auto-retry: re-enabling requires a fresh user gesture.
        setState(HANDSFREE_STATES.ERROR, { error: 'device-lost' });
    }

    function enterError(code) {
        clearErrorTimer();
        setState(HANDSFREE_STATES.ERROR, { error: code });
        // Transient pipeline errors auto-recover so the conversation can
        // continue without user interaction.
        if (code === 'transcription' || code === 'send') {
            const gen = sessionGen;
            errorTimer = setTimeoutFn(() => {
                errorTimer = null;
                if (gen === sessionGen && state === HANDSFREE_STATES.ERROR) {
                    setState(HANDSFREE_STATES.LISTENING);
                }
            }, errorRecoveryMs);
        }
    }


    function handleSpeechStart(lookbackMs) {
        if (state !== HANDSFREE_STATES.LISTENING) return;
        if (!canUseConversation()) return;
        // Begin the utterance with the pre-roll rewound to the VAD's
        // estimated speech onset (lookbackMs back from now).
        capture.begin(lookbackMs);
        setState(HANDSFREE_STATES.HEARING);
    }

    function handleSpeechEnd() {
        if (state !== HANDSFREE_STATES.HEARING) return;
        if (!canUseConversation()) {
            stopListening();
            setState(HANDSFREE_STATES.OFF);
            return;
        }
        if (inFlight) return; // defensive: an utterance is already in flight
        let blob = null;
        try {
            const utterance = capture.end();
            if (utterance && utterance.samples.length > 0) {
                // A standalone WAV (mono, PCM16) that ffmpeg/faster-whisper
                // can always decode — unlike mid-stream WebM/Opus chunks.
                blob = encodeWavBlob(utterance.samples, utterance.sampleRate);
            }
        } catch {
            blob = null;
        }
        if (!blob) {
            setState(HANDSFREE_STATES.LISTENING);
            return;
        }
        // Exactly one transcription per utterance: the flight token is
        // consumed here and every async continuation below re-checks it.
        const flight = {
            conversationId: getConversationId(),
            epoch: getEpoch(),
        };
        inFlight = flight;
        setState(HANDSFREE_STATES.TRANSCRIBING);
        Promise.resolve()
            .then(() => transcribe(blob))
            .then((text) => {
                if (inFlight !== flight) return; // discarded mid-flight
                inFlight = null;
                if (typeof text !== 'string' || !text.trim()) {
                    enterError('transcription');
                    return undefined;
                }
                // Epoch guard: a late transcription result must never send
                // into a newer conversation.
                if (getConversationId() !== flight.conversationId || getEpoch() !== flight.epoch) {
                    setState(HANDSFREE_STATES.LISTENING);
                    return undefined;
                }
                setState(HANDSFREE_STATES.WAITING);
                return Promise.resolve(onSendText(text.trim())).catch(() => {
                    enterError('send');
                    return undefined;
                });
            })
            .catch(() => {
                if (inFlight !== flight) return;
                inFlight = null;
                enterError('transcription');
            });
    }

    function markSpeakingStart() {
        if (state === HANDSFREE_STATES.OFF) return;
        if (state !== HANDSFREE_STATES.SPEAKING) discardUtterance();
        vad.hold();
        speakSessionGen = sessionGen;
        setState(HANDSFREE_STATES.SPEAKING);
    }

    function markSpeakingEnd() {
        if (state !== HANDSFREE_STATES.SPEAKING) return;
        vad.release();
        if (speakSessionGen !== sessionGen || !canUseConversation()) {
            // Stale playback callback or no conversation left: do not
            // reopen listening from an old playback session.
            stopListening();
            setState(HANDSFREE_STATES.OFF);
            return;
        }
        setState(HANDSFREE_STATES.LISTENING);
    }

    function markResponseComplete() {
        if (state !== HANDSFREE_STATES.WAITING) return;
        setState(HANDSFREE_STATES.LISTENING);
    }

    function onAudioFrame(frame) {
        if (state === HANDSFREE_STATES.OFF) return;
        // The capture layer sees every frame BEFORE the VAD: the very frame
        // that confirms speech must already be in the pre-roll ring when
        // begin() rewinds into it. While the AI is speaking (SPEAKING) the
        // capture is starved entirely, so TTS audio can never enter an
        // utterance or its pre-roll.
        if (state !== HANDSFREE_STATES.SPEAKING) capture.processFrame(frame);
        vad.processFrame(frame);
    }

    return {
        enable,
        disable,
        invalidate,
        onAudioFrame,
        onDeviceLost,
        markSpeakingStart,
        markSpeakingEnd,
        markResponseComplete,
        get state() { return state; },
        get stateInfo() { return stateInfo; },
        get isActive() { return state !== HANDSFREE_STATES.OFF; },
        get vad() { return vad; },
        get capture() { return capture; },
    };
}

/**
 * Maps a hands-free state to its UI label.
 * @param {string} state
 * @param {{ characterName?: string, error?: string }} [info]
 * @returns {string}
 */
export function handsFreeStatusText(state, info = {}) {
    const characterName = typeof info.characterName === 'string' ? info.characterName : '';
    switch (state) {
        case HANDSFREE_STATES.LISTENING:
            return 'Listening…';
        case HANDSFREE_STATES.HEARING:
            return 'Hearing you…';
        case HANDSFREE_STATES.TRANSCRIBING:
            return 'Transcribing…';
        case HANDSFREE_STATES.WAITING:
            return 'Waiting for response…';
        case HANDSFREE_STATES.SPEAKING:
            return characterName ? characterName + ' speaking…' : 'Speaking…';
        case HANDSFREE_STATES.ERROR:
            return HANDSFREE_ERROR_TEXT[info.error] || 'Hands-free unavailable.';
        default:
            return '';
    }
}
