// ─── TASK-VOICE-HANDSFREE-001: hands-free conversation mode ──────────────────
// Unit tests for the browser-local half-duplex voice loop:
// - createEnergyVad: deterministic, frame-driven RMS endpointing
// - createPcmUtteranceCapture: bounded pre-roll ring + capped utterance
//   buffer built from mono Float32 PCM frames
// - encodeWavBlob: standalone RIFF/WAVE (mono, signed 16-bit PCM) output
// - createHandsFreeController: state machine, conversation/epoch guards,
//   TTS cooperation, device loss, transient-error auto-recovery, and the
//   WAV utterance pipeline (tests assert on the exact WAV bytes that reach
//   the transcribe() dependency)
// Every browser API is an injected fake; nothing here touches a real mic.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
    HANDSFREE_STATES,
    HANDSFREE_WORKLET_SOURCE,
    computeFrameRms,
    createEnergyVad,
    createHandsFreeController,
    createPcmUtteranceCapture,
    encodeWavBlob,
    handsFreeStatusText,
    normalizeHandsFreePreference,
} from '../../public/openparlor/handsfree.js';
import {
    createGroupPlaybackQueue,
    createPlaybackController,
} from '../../public/openparlor/audio.js';

// ─── Frame helpers ───────────────────────────────────────────────────────────
// 10 ms mono frames at 16 kHz: 20 loud frames = 200 ms (the default start
// sustain) and 90 silent frames = 900 ms (the default end silence).

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 160;
// 10 ms per frame at 16 kHz. The VAD is frame-driven, so every duration in
// these tests is expressed in frames.
const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;

function frame(amp) {
    const samples = new Float32Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) samples[i] = amp;
    return { samples, sampleRate: SAMPLE_RATE };
}

const loudFrame = () => frame(0.1);
const silentFrame = () => frame(0.001);

function feed(hf, count, make = loudFrame) {
    for (let i = 0; i < count; i += 1) hf.onAudioFrame(make());
}

// VOICE-004: the endpoint pause is adaptive, so a test that asserts a captured
// WAV length must derive the pause from the detector rather than hard-code a
// duration. These tests are about what is captured (only the user's words, and
// a bounded size), not about one particular pause length. This probe runs the
// real detector over the same speech the test feeds and reports how many
// silent frames it needs to endpoint.
function endpointFramesAfterSpeech(speechFrames = 20) {
    const probe = createEnergyVad({});
    for (let i = 0; i < speechFrames; i += 1) probe.processFrame(loudFrame());
    return Math.ceil(probe.requiredSilenceMs / FRAME_MS);
}

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

// ─── Fake timers (for the error-recovery delay) ─────────────────────────────

function makeFakeTimers() {
    let nextId = 1;
    const pending = new Map();
    return {
        setTimeout: (fn) => {
            const id = nextId;
            nextId += 1;
            pending.set(id, fn);
            return id;
        },
        clearTimeout: (id) => { pending.delete(id); },
        pendingIds: () => [...pending.keys()],
        fire: (id) => {
            const fn = pending.get(id);
            if (fn) {
                pending.delete(id);
                fn();
            }
        },
    };
}
// ─── computeFrameRms / preference / status text ─────────────────────────────

describe('computeFrameRms', () => {
    it('returns 0 for empty input', () => {
        assert.equal(computeFrameRms(new Float32Array(0)), 0);
        assert.equal(computeFrameRms(null), 0);
    });

    it('returns 0 for silence and the amplitude for a constant signal', () => {
        assert.equal(computeFrameRms(frame(0).samples), 0);
        assert.ok(Math.abs(computeFrameRms(frame(0.5).samples) - 0.5) < 1e-6);
    });
});

describe('normalizeHandsFreePreference', () => {
    it('accepts only the explicit true forms', () => {
        assert.equal(normalizeHandsFreePreference('true'), true);
        assert.equal(normalizeHandsFreePreference(true), true);
        assert.equal(normalizeHandsFreePreference('false'), false);
        assert.equal(normalizeHandsFreePreference(false), false);
        assert.equal(normalizeHandsFreePreference(null), false);
        assert.equal(normalizeHandsFreePreference(undefined), false);
        assert.equal(normalizeHandsFreePreference('yes'), false);
    });
});

describe('handsFreeStatusText', () => {
    it('maps every state to a user-facing label', () => {
        assert.equal(handsFreeStatusText(HANDSFREE_STATES.LISTENING), 'Listening…');
        assert.equal(handsFreeStatusText(HANDSFREE_STATES.HEARING), 'Hearing you…');
        assert.equal(handsFreeStatusText(HANDSFREE_STATES.TRANSCRIBING), 'Transcribing…');
        assert.equal(handsFreeStatusText(HANDSFREE_STATES.WAITING), 'Waiting for response…');
        assert.equal(handsFreeStatusText(HANDSFREE_STATES.SPEAKING), 'Speaking…');
        assert.equal(
            handsFreeStatusText(HANDSFREE_STATES.SPEAKING, { characterName: 'Ada' }),
            'Ada speaking…',
        );
        assert.equal(handsFreeStatusText(HANDSFREE_STATES.OFF), '');
    });

    it('maps error codes to safe text', () => {
        assert.equal(
            handsFreeStatusText(HANDSFREE_STATES.ERROR, { error: 'device-lost' }),
            'Microphone disconnected. Click to retry.',
        );
        assert.equal(
            handsFreeStatusText(HANDSFREE_STATES.ERROR, { error: 'unknown-code' }),
            'Hands-free unavailable.',
        );
    });
});
// ─── HANDSFREE_WORKLET_SOURCE ────────────────────────────────────────────────
// The worklet ships as a source string loaded by the browser; execute it here
// against a fake AudioWorkletProcessor to lock in the channel indexing.
// `inputs[0]` is the input port's channel list, so `inputs[0][0]` is channel
// 0's Float32Array — a regression to `inputs[0][0][0]` would hand the VAD a
// scalar sample and silently post no frames at all.

function runWorkletSource() {
    const posted = [];
    let Ctor = null;
    const sandbox = {
        sampleRate: 16000,
        registerProcessor: (name, ctor) => { Ctor = ctor; },
        AudioWorkletProcessor: class {
            constructor() {
                this.port = { postMessage: (msg) => posted.push(msg) };
            }
        },
    };
    vm.runInContext(HANDSFREE_WORKLET_SOURCE, vm.createContext(sandbox));
    return { proc: new Ctor(), posted };
}

describe('HANDSFREE_WORKLET_SOURCE', () => {
    it('posts frames built from channel 0 of the input port', () => {
        const { proc, posted } = runWorkletSource();
        const ch0 = new Float32Array(1024).fill(0.25);
        const ch1 = new Float32Array(1024).fill(-0.75);
        assert.equal(proc.process([[ch0, ch1]]), true, 'the processor keeps running');
        assert.equal(posted.length, 1);
        const { samples, sampleRate } = posted[0];
        // Structural check: the vm context has its own Float32Array global,
        // so instanceof would be cross-realm false.
        assert.ok(ArrayBuffer.isView(samples) && samples.BYTES_PER_ELEMENT === 4,
            'samples must be a Float32Array');
        assert.equal(samples.length, 1024);
        assert.equal(samples[0], 0.25, 'must read channel 0, not a scalar sample');
        assert.equal(sampleRate, 16000);
    });

    it('accumulates partial frames before posting', () => {
        const { proc, posted } = runWorkletSource();
        proc.process([[new Float32Array(512).fill(0.25)]]);
        assert.equal(posted.length, 0, 'half a buffer is held back');
        proc.process([[new Float32Array(512).fill(0.5)]]);
        assert.equal(posted.length, 1);
        assert.equal(posted[0].samples[0], 0.25);
        assert.equal(posted[0].samples[512], 0.5);
    });

    it('survives empty and absent input shapes without posting', () => {
        const { proc, posted } = runWorkletSource();
        assert.equal(proc.process([]), true);
        assert.equal(proc.process([[]]), true);
        assert.equal(proc.process([[[]]]), true);
        assert.equal(posted.length, 0);
    });
});

// ─── createEnergyVad ─────────────────────────────────────────────────────────

describe('createEnergyVad', () => {
    it('starts speech only after the sustained threshold is met', () => {
        let started = 0;
        const vad = createEnergyVad({ onSpeechStart: () => { started += 1; } });
        for (let i = 0; i < 19; i += 1) vad.processFrame(loudFrame());
        assert.equal(vad.isActive, false);
        assert.equal(started, 0);
        vad.processFrame(loudFrame()); // 20th loud frame = 200 ms
        assert.equal(vad.isActive, true);
        assert.equal(started, 1);
    });

    it('ignores a short loud burst below the start sustain', () => {
        const vad = createEnergyVad({});
        for (let i = 0; i < 10; i += 1) vad.processFrame(loudFrame());
        for (let i = 0; i < 10; i += 1) vad.processFrame(silentFrame());
        assert.equal(vad.isActive, false);
    });

    it('ends the utterance once the adaptive silence threshold is met', () => {
        const ends = [];
        const vad = createEnergyVad({ onSpeechEnd: (reason) => { ends.push(reason); } });
        for (let i = 0; i < 20; i += 1) vad.processFrame(loudFrame());
        assert.equal(vad.isActive, true);
        // VOICE-004: the required pause is adaptive, so assert against the
        // detector's own current threshold rather than a fixed 900 ms.
        const required = vad.requiredSilenceMs;
        assert.ok(required < 900, 'a short utterance endpoints faster than the old fixed wait');
        const frames = Math.ceil(required / FRAME_MS);
        for (let i = 0; i < frames - 1; i += 1) vad.processFrame(silentFrame());
        assert.equal(vad.isActive, true, 'the pause is not quite long enough yet');
        vad.processFrame(silentFrame());
        assert.equal(vad.isActive, false);
        assert.deepEqual(ends, ['silence']);
    });

    it('ends the utterance at the max duration cap', () => {
        const ends = [];
        // Explicit cap: this asserts the CAP behavior, not the default value.
        const vad = createEnergyVad({ maxUtteranceMs: 1500, onSpeechEnd: (reason) => { ends.push(reason); } });
        for (let i = 0; i < 20; i += 1) vad.processFrame(loudFrame());
        // utteranceStartMs is 0, so the cap hits at clockMs = 1500 (150 frames).
        for (let i = 0; i < 129; i += 1) vad.processFrame(loudFrame());
        assert.equal(vad.isActive, true, 'not yet at the cap');
        vad.processFrame(loudFrame());
        assert.equal(vad.isActive, false, 'the cap ended the utterance');
        assert.deepEqual(ends, ['max-duration']);
    });

    it('hold() suppresses detection and release() clears in-progress state', () => {
        const vad = createEnergyVad({});
        for (let i = 0; i < 20; i += 1) vad.processFrame(loudFrame());
        assert.equal(vad.isActive, true);
        vad.hold();
        assert.equal(vad.isHeld, true);
        for (let i = 0; i < 500; i += 1) vad.processFrame(silentFrame());
        assert.equal(vad.isActive, true, 'endpointing is suppressed while held');
        vad.release();
        assert.equal(vad.isActive, false, 'release clears the in-progress utterance');
        for (let i = 0; i < 20; i += 1) vad.processFrame(loudFrame());
        assert.equal(vad.isActive, true, 'detection works again after release');
    });

    it('hold() before speech blocks the start', () => {
        let started = 0;
        const vad = createEnergyVad({ onSpeechStart: () => { started += 1; } });
        vad.hold();
        for (let i = 0; i < 30; i += 1) vad.processFrame(loudFrame());
        assert.equal(vad.isActive, false);
        assert.equal(started, 0);
        vad.release();
        for (let i = 0; i < 20; i += 1) vad.processFrame(loudFrame());
        assert.equal(vad.isActive, true);
        assert.equal(started, 1);
    });

    it('reset() clears the active state and start streak', () => {
        const vad = createEnergyVad({});
        for (let i = 0; i < 20; i += 1) vad.processFrame(loudFrame());
        vad.reset();
        assert.equal(vad.isActive, false);
        for (let i = 0; i < 19; i += 1) vad.processFrame(loudFrame());
        assert.equal(vad.isActive, false, 'the streak was reset, not carried over');
    });

    it('exposes the configured preRollMs', () => {
        assert.equal(createEnergyVad({}).preRollMs, 300);
        assert.equal(createEnergyVad({ preRollMs: 500 }).preRollMs, 500);
    });

    it('ignores invalid frames', () => {
        const vad = createEnergyVad({});
        vad.processFrame(null);
        vad.processFrame({});
        vad.processFrame({ samples: new Float32Array(0) });
        assert.equal(vad.isActive, false);
    });
});
// ─── createHandsFreeController ───────────────────────────────────────────────

function makeController(overrides = {}) {
    const env = {
        convId: 'conv-1',
        epoch: 1,
        startCalls: 0,
        stopCalls: 0,
        sent: [],
        blobs: [], // the WAV blobs the controller handed to transcribe()
        events: [],
    };
    const timers = makeFakeTimers();
    const controller = createHandsFreeController({
        getConversationId: () => env.convId,
        getEpoch: () => env.epoch,
        startListening: async () => { env.startCalls += 1; },
        stopListening: () => { env.stopCalls += 1; },
        transcribe: async (blob) => {
            env.blobs.push(blob);
            return 'hello world';
        },
        onSendText: async (text) => { env.sent.push(text); },
        setTimeoutFn: timers.setTimeout,
        clearTimeoutFn: timers.clearTimeout,
        onStateChange: (state) => { env.events.push(state); },
        ...overrides,
    });
    // 20 loud frames start the utterance; 90 silent frames endpoint it.
    const talkAndStop = () => {
        feed(controller, 20, loudFrame);
        feed(controller, 90, silentFrame);
    };
    return { controller, env, timers, talkAndStop };
}

describe('createHandsFreeController enable/disable', () => {
    it('enables into listening and starts the mic session', async () => {
        const { controller, env } = makeController();
        assert.equal(controller.isActive, false);
        await controller.enable();
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
        assert.equal(env.startCalls, 1);
        // enable() re-asserts listening once startListening resolves.
        assert.deepEqual(env.events, [HANDSFREE_STATES.LISTENING, HANDSFREE_STATES.LISTENING]);
    });

    it('enable() is a no-op while already active', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        await controller.enable();
        assert.equal(env.startCalls, 1);
    });

    it('enable() without a conversation is a no-conversation error', async () => {
        const { controller, env } = makeController();
        env.convId = '';
        await controller.enable();
        assert.equal(controller.state, HANDSFREE_STATES.ERROR);
        assert.equal(controller.stateInfo.error, 'no-conversation');
        assert.equal(env.startCalls, 0);
    });

    it('maps a mic permission denial to permission-denied', async () => {
        const { controller } = makeController({
            startListening: async () => {
                const e = new Error('denied');
                e.name = 'NotAllowedError';
                throw e;
            },
        });
        await controller.enable();
        assert.equal(controller.state, HANDSFREE_STATES.ERROR);
        assert.equal(controller.stateInfo.error, 'permission-denied');
    });

    it('maps a generic mic failure to microphone', async () => {
        const { controller } = makeController({
            startListening: async () => { throw new Error('no device'); },
        });
        await controller.enable();
        assert.equal(controller.state, HANDSFREE_STATES.ERROR);
        assert.equal(controller.stateInfo.error, 'microphone');
    });

    it('disable() stops the mic session and returns to off', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.disable();
        assert.equal(controller.state, HANDSFREE_STATES.OFF);
        assert.equal(controller.isActive, false);
        assert.equal(env.stopCalls, 1);
        assert.deepEqual(env.events, [
            HANDSFREE_STATES.LISTENING,
            HANDSFREE_STATES.LISTENING,
            HANDSFREE_STATES.OFF,
        ]);
    });

    it('disable() during a pending start wins the race', async () => {
        let resolveStart;
        const { controller, env } = makeController({
            startListening: () => new Promise((resolve) => { resolveStart = resolve; }),
        });
        const pending = controller.enable();
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
        controller.disable();
        resolveStart();
        await pending;
        assert.equal(controller.state, HANDSFREE_STATES.OFF);
        assert.equal(env.stopCalls, 2, 'the stale start is torn down');
    });

    it('ignores audio frames while off', () => {
        const { controller, env, talkAndStop } = makeController();
        talkAndStop();
        assert.equal(controller.state, HANDSFREE_STATES.OFF);
        assert.deepEqual(env.events, []);
        assert.deepEqual(env.sent, []);
    });
});
describe('createHandsFreeController utterance pipeline', () => {
    it('runs the full loop: hearing → transcribing → waiting → listening', async () => {
        const { controller, env, talkAndStop } = makeController();
        await controller.enable();
        talkAndStop();
        await flush();
        assert.deepEqual(env.sent, ['hello world']);
        assert.equal(controller.state, HANDSFREE_STATES.WAITING);
        assert.deepEqual(env.events, [
            HANDSFREE_STATES.LISTENING,
            HANDSFREE_STATES.LISTENING,
            HANDSFREE_STATES.HEARING,
            HANDSFREE_STATES.TRANSCRIBING,
            HANDSFREE_STATES.WAITING,
        ]);
        // The transcribed blob is a standalone WAV: the utterance started
        // right after enable, so the pre-roll ring held only the 200 ms of
        // loud frames at begin time, plus the adaptive endpointing silence.
        const wav = await parseWav(env.blobs[0]);
        assert.equal(wav.type, 'audio/wav');
        assert.equal(wav.sampleRate, SAMPLE_RATE);
        assert.equal(wav.channels, 1);
        assert.equal(wav.bitsPerSample, 16);
        const capturedFrames = 20 + endpointFramesAfterSpeech(20);
        assert.equal(wav.dataLen, capturedFrames * FRAME_SAMPLES * 2);
        assert.equal(wav.pcm[0], Math.round(0.1 * 32767), 'the loud onset leads the WAV');
        controller.markResponseComplete();
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
    });

    it('returns to listening when the capture yields no audio', async () => {
        const { controller, env, talkAndStop } = makeController({
            captureFactory: () => ({
                processFrame: () => {},
                begin: () => {},
                end: () => null,
                discard: () => {},
                get isActive() { return false; },
            }),
        });
        await controller.enable();
        talkAndStop();
        await flush();
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
        assert.deepEqual(env.sent, []);
    });

    it('drops a late transcription after the conversation changed', async () => {
        let resolveTranscribe;
        const { controller, env, talkAndStop } = makeController({
            transcribe: () => new Promise((resolve) => { resolveTranscribe = resolve; }),
        });
        await controller.enable();
        talkAndStop();
        assert.equal(controller.state, HANDSFREE_STATES.TRANSCRIBING);
        await flush(); // the transcribe call happens in a microtask
        env.convId = 'conv-2';
        resolveTranscribe('late text');
        await flush();
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
        assert.deepEqual(env.sent, []);
    });

    it('drops a late transcription after the selection epoch changed', async () => {
        let resolveTranscribe;
        const { controller, env, talkAndStop } = makeController({
            transcribe: () => new Promise((resolve) => { resolveTranscribe = resolve; }),
        });
        await controller.enable();
        talkAndStop();
        assert.equal(controller.state, HANDSFREE_STATES.TRANSCRIBING);
        await flush(); // the transcribe call happens in a microtask
        env.epoch = 2;
        resolveTranscribe('late text');
        await flush();
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
        assert.deepEqual(env.sent, []);
    });

    it('invalidate() mid-transcription discards the flight and resumes', async () => {
        let resolveTranscribe;
        const { controller, env, talkAndStop } = makeController({
            transcribe: () => new Promise((resolve) => { resolveTranscribe = resolve; }),
        });
        await controller.enable();
        talkAndStop();
        assert.equal(controller.state, HANDSFREE_STATES.TRANSCRIBING);
        controller.invalidate();
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
        await flush(); // the discarded transcribe call happens in a microtask
        resolveTranscribe('late');
        await flush();
        assert.deepEqual(env.sent, []);
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
    });

    it('invalidate() discards buffered speech so it cannot be resubmitted', async () => {
        const { controller, env, talkAndStop } = makeController();
        await controller.enable();
        feed(controller, 30, silentFrame);
        feed(controller, 20, loudFrame);
        assert.equal(controller.state, HANDSFREE_STATES.HEARING);
        controller.invalidate(); // drop the in-progress utterance
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
        feed(controller, 90, silentFrame);
        talkAndStop();
        await flush();
        assert.equal(env.blobs.length, 1, 'only the post-invalidation utterance is sent');
        const wav = await parseWav(env.blobs[0]);
        const loud = wav.pcm.filter((v) => Math.abs(v) >= 1000).length;
        assert.equal(loud, 20 * FRAME_SAMPLES, 'the discarded speech did not leak in');
    });

    it('invalidate() with no conversation left goes off', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        env.convId = '';
        controller.invalidate();
        assert.equal(controller.state, HANDSFREE_STATES.OFF);
        assert.equal(env.stopCalls, 1);
    });

    it('markResponseComplete() is a no-op outside waiting', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markResponseComplete();
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
        assert.deepEqual(env.events, [HANDSFREE_STATES.LISTENING, HANDSFREE_STATES.LISTENING]);
    });

    it('repeated hands-free cycles stay bounded and produce identical WAV sizes', async () => {
        const { controller, env, talkAndStop } = makeController();
        await controller.enable();
        const dataLens = [];
        for (let cycle = 0; cycle < 3; cycle += 1) {
            feed(controller, 30, silentFrame);
            talkAndStop();
            await flush();
            const wav = await parseWav(env.blobs[cycle]);
            dataLens.push(wav.dataLen);
            controller.markResponseComplete();
        }
        assert.equal(env.blobs.length, 3, 'one independent WAV per cycle');
        // Every cycle captures the same 300 ms of pre-roll, 200 ms of speech,
        // and the same adaptive endpointing pause — no growth across cycles.
        const capturedFrames = 30 + 20 + endpointFramesAfterSpeech(20);
        const expectedBytes = capturedFrames * FRAME_SAMPLES * 2;
        assert.deepEqual(dataLens, [expectedBytes, expectedBytes, expectedBytes]);
        assert.ok(
            controller.capture.bufferedSamples <= 1300 * (SAMPLE_RATE / 1000),
            'the pre-roll ring is bounded',
        );
        assert.equal(env.sent.length, 3, 'every cycle sent its text');
    });
});
describe('createHandsFreeController TTS cooperation', () => {
    it('markSpeakingStart() discards an in-flight utterance and holds the VAD', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        feed(controller, 20, loudFrame);
        assert.equal(controller.state, HANDSFREE_STATES.HEARING);
        controller.markSpeakingStart();
        assert.equal(controller.state, HANDSFREE_STATES.SPEAKING);
        // While speaking, even a complete utterance must be ignored.
        feed(controller, 20, loudFrame);
        feed(controller, 90, silentFrame);
        assert.equal(controller.state, HANDSFREE_STATES.SPEAKING);
        await flush();
        assert.deepEqual(env.sent, []);
        assert.equal(env.blobs.length, 0);
    });

    it('TTS hold never leaks AI audio into the next utterance', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        feed(controller, 30, silentFrame); // pre-roll before TTS
        controller.markSpeakingStart();
        // VOICE-003: residual echo from the speakers must sit in the band
        // between the LISTENING VAD threshold (0.01) and the barge-in
        // threshold (0.03). Amplitude below 0.03 is the whole point of the
        // stronger barge-in threshold; sustained audio ABOVE it is a user
        // interrupt by design and is covered by the VOICE-003 barge-in tests.
        feed(controller, 50, () => frame(0.02)); // TTS leaking into the mic
        assert.equal(controller.state, HANDSFREE_STATES.SPEAKING, 'echo is not an interrupt');
        controller.markSpeakingEnd();
        feed(controller, 30, silentFrame);
        feed(controller, 20, loudFrame); // a new real user utterance
        feed(controller, 90, silentFrame);
        await flush();
        assert.equal(env.blobs.length, 1, 'only the post-TTS utterance is transcribed');
        const wav = await parseWav(env.blobs[0]);
        const loud = wav.pcm.filter((v) => Math.abs(v) >= 1000).length;
        assert.equal(loud, 20 * FRAME_SAMPLES, 'exactly the 200 ms user utterance');
        assert.equal(
            wav.pcm.filter((v) => Math.abs(v) >= 10000).length,
            0,
            'no TTS-amplitude sample made it into the WAV',
        );
    });

    it('stale pre‑roll is cleared when entering speaking', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        // Feed sub‑VAD audio that would normally sit in the pre‑roll ring.
        feed(controller, 30, silentFrame); // 300 ms of low‑amplitude audio
        controller.markSpeakingStart();
        // No TTS audio is needed for this test; the important part is that
        // the pre‑roll ring is cleared.
        controller.markSpeakingEnd();
        // Begin a new real utterance. It should start with a clean pre‑roll.
        feed(controller, 20, loudFrame); // user speech
        feed(controller, 90, silentFrame); // endpointing silence
        await flush();
        assert.equal(env.blobs.length, 1, 'one utterance should be transcribed');
        const wav = await parseWav(env.blobs[0]);
        // 200 ms of speech plus the adaptive endpointing silence, with no
        // pre-TTS audio: the ring was cleared when speaking began.
        const expectedSamples = (20 + endpointFramesAfterSpeech(20)) * FRAME_SAMPLES;
        assert.equal(
            wav.pcm.length,
            expectedSamples,
            'pre‑roll cleared, only user utterance captured',
        );
    });

    it('markSpeakingEnd() resumes listening and the loop works again', async () => {
        const { controller, env, talkAndStop } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        assert.equal(controller.state, HANDSFREE_STATES.SPEAKING);
        controller.markSpeakingEnd();
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
        talkAndStop();
        await flush();
        assert.deepEqual(env.sent, ['hello world']);
        assert.equal(controller.state, HANDSFREE_STATES.WAITING);
    });

    it('markSpeakingEnd() with no conversation left goes off', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        env.convId = '';
        controller.markSpeakingEnd();
        assert.equal(controller.state, HANDSFREE_STATES.OFF);
        assert.equal(env.stopCalls, 1);
    });

    it('markSpeakingStart() is a no-op while off', async () => {
        const { controller, env } = makeController();
        controller.markSpeakingStart();
        assert.equal(controller.state, HANDSFREE_STATES.OFF);
        assert.deepEqual(env.events, []);
    });
});

describe('createHandsFreeController device loss and recovery', () => {
    it('device loss is a controlled error without auto-retry', async () => {
        const { controller, env, timers } = makeController();
        await controller.enable();
        controller.onDeviceLost();
        assert.equal(controller.state, HANDSFREE_STATES.ERROR);
        assert.equal(controller.stateInfo.error, 'device-lost');
        assert.equal(env.stopCalls, 1);
        assert.equal(timers.pendingIds().length, 0, 'no auto-recovery timer for device loss');
        // A fresh user gesture (button click) can re-enable.
        await controller.enable();
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
    });

    it('onDeviceLost() while off is a no-op', () => {
        const { controller, env } = makeController();
        controller.onDeviceLost();
        assert.equal(controller.state, HANDSFREE_STATES.OFF);
        assert.deepEqual(env.events, []);
    });

    it('a transcription failure auto-recovers to listening', async () => {
        const { controller, env, timers, talkAndStop } = makeController({
            transcribe: async () => { throw new Error('boom'); },
        });
        await controller.enable();
        talkAndStop();
        await flush();
        assert.equal(controller.state, HANDSFREE_STATES.ERROR);
        assert.equal(controller.stateInfo.error, 'transcription');
        const ids = timers.pendingIds();
        assert.equal(ids.length, 1);
        timers.fire(ids[0]);
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
        assert.deepEqual(env.sent, []);
    });

    it('an empty transcription result is a transcription error', async () => {
        const { controller, timers, talkAndStop } = makeController({
            transcribe: async () => '   ',
        });
        await controller.enable();
        talkAndStop();
        await flush();
        assert.equal(controller.state, HANDSFREE_STATES.ERROR);
        assert.equal(controller.stateInfo.error, 'transcription');
        timers.fire(timers.pendingIds()[0]);
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
    });

    it('a send failure auto-recovers to listening', async () => {
        const { controller, env, timers, talkAndStop } = makeController({
            onSendText: async () => { throw new Error('send failed'); },
        });
        await controller.enable();
        talkAndStop();
        await flush();
        assert.equal(controller.state, HANDSFREE_STATES.ERROR);
        assert.equal(controller.stateInfo.error, 'send');
        assert.deepEqual(env.sent, []);
        timers.fire(timers.pendingIds()[0]);
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
    });

    it('disable() cancels a pending auto-recovery timer', async () => {
        const { controller, timers, talkAndStop } = makeController({
            transcribe: async () => { throw new Error('boom'); },
        });
        await controller.enable();
        talkAndStop();
        await flush();
        assert.equal(controller.state, HANDSFREE_STATES.ERROR);
        controller.disable();
        assert.equal(timers.pendingIds().length, 0);
        assert.equal(controller.state, HANDSFREE_STATES.OFF);
    });
});
// ─── WAV encoding + PCM utterance capture ────────────────────────────────────

// Parses a WAV blob produced by encodeWavBlob into header fields + samples.
async function parseWav(blob) {
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    const tag = (offset) => String.fromCharCode(
        view.getUint8(offset), view.getUint8(offset + 1),
        view.getUint8(offset + 2), view.getUint8(offset + 3),
    );
    return {
        type: blob.type,
        size: blob.size,
        riff: tag(0),
        riffSize: view.getUint32(4, true),
        wave: tag(8),
        fmt: tag(12),
        fmtSize: view.getUint32(16, true),
        format: view.getUint16(20, true),
        channels: view.getUint16(22, true),
        sampleRate: view.getUint32(24, true),
        byteRate: view.getUint32(28, true),
        blockAlign: view.getUint16(32, true),
        bitsPerSample: view.getUint16(34, true),
        data: tag(36),
        dataLen: view.getUint32(40, true),
        pcm: new Int16Array(buf.slice(44)),
    };
}

describe('encodeWavBlob', () => {
    it('writes a valid RIFF/WAVE header for mono PCM16', async () => {
        const wav = await parseWav(encodeWavBlob(new Float32Array([0.25, -0.25]), 16000));
        assert.equal(wav.type, 'audio/wav');
        assert.equal(wav.riff, 'RIFF');
        assert.equal(wav.riffSize, 36 + 4, 'RIFF size = file size minus the first 8 bytes');
        assert.equal(wav.wave, 'WAVE');
        assert.equal(wav.fmt, 'fmt ');
        assert.equal(wav.fmtSize, 16);
        assert.equal(wav.format, 1, 'PCM');
        assert.equal(wav.channels, 1, 'mono');
        assert.equal(wav.sampleRate, 16000);
        assert.equal(wav.byteRate, 32000);
        assert.equal(wav.blockAlign, 2);
        assert.equal(wav.bitsPerSample, 16);
        assert.equal(wav.data, 'data');
        assert.equal(wav.dataLen, 4);
        assert.equal(wav.size, 48, '44-byte header + 2 samples');
        assert.deepEqual([...wav.pcm], [8192, -8192]);
    });

    it('takes the sample rate from the argument, not a hard-coded value', async () => {
        for (const rate of [16000, 44100, 48000]) {
            const wav = await parseWav(encodeWavBlob(new Float32Array(100), rate));
            assert.equal(wav.sampleRate, rate);
            assert.equal(wav.byteRate, rate * 2);
        }
    });

    it('writes exact RIFF/data lengths for the sample count', async () => {
        const samples = new Float32Array(1000).fill(0.1);
        const wav = await parseWav(encodeWavBlob(samples, 16000));
        assert.equal(wav.dataLen, 2000);
        assert.equal(wav.riffSize, 36 + 2000);
        assert.equal(wav.size, 44 + 2000);
        assert.equal(wav.pcm.length, 1000);
    });

    it('clamps to [-1, 1], converts to signed PCM16, and maps non-finite values to silence', async () => {
        const wav = await parseWav(encodeWavBlob(new Float32Array([
            1, -1, 2, -3, 0.5, -0.5, 0, NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
        ]), 16000));
        assert.deepEqual([...wav.pcm], [32767, -32767, 32767, -32767, 16384, -16383, 0, 0, 0, 0]);
    });

    it('encodes empty input as a header-only WAV', async () => {
        const wav = await parseWav(encodeWavBlob(new Float32Array(0), 16000));
        assert.equal(wav.size, 44);
        assert.equal(wav.dataLen, 0);
        assert.equal(wav.pcm.length, 0);
    });
});

// ─── createPcmUtteranceCapture ───────────────────────────────────────────────

describe('createPcmUtteranceCapture', () => {
    it('keeps the pre-roll ring bounded while listening', () => {
        const cap = createPcmUtteranceCapture();
        for (let i = 0; i < 500; i += 1) cap.processFrame(loudFrame());
        // 5 s of frames fed in, but the ring is capped at pre-roll (300 ms)
        // plus the maximum onset lookback (1000 ms).
        assert.equal(cap.bufferedSamples, 1300 * (SAMPLE_RATE / 1000));
        assert.equal(cap.sampleRate, SAMPLE_RATE);
        assert.equal(cap.isActive, false);
    });

    it('retains the configured pre-roll before speech starts', () => {
        const cap = createPcmUtteranceCapture();
        for (let i = 0; i < 30; i += 1) cap.processFrame(silentFrame()); // 300 ms
        cap.begin(0);
        const out = cap.end();
        assert.equal(out.samples.length, 300 * (SAMPLE_RATE / 1000));
        assert.equal(out.sampleRate, SAMPLE_RATE);
        assert.ok(out.durationMs > 299 && out.durationMs < 301);
        assert.ok([...out.samples].every((v) => Math.abs(v - 0.001) < 1e-6));
    });

    it('discards audio older than the pre-roll window', () => {
        const cap = createPcmUtteranceCapture();
        for (let i = 0; i < 100; i += 1) cap.processFrame(frame(0.0001)); // 1 s
        cap.begin(0);
        const out = cap.end();
        assert.equal(out.samples.length, 300 * (SAMPLE_RATE / 1000), 'only the last 300 ms remain, not the full second');
    });

    it('includes the VAD onset lookback requested at begin()', () => {
        const cap = createPcmUtteranceCapture();
        for (let i = 0; i < 30; i += 1) cap.processFrame(silentFrame());
        for (let i = 0; i < 20; i += 1) cap.processFrame(loudFrame()); // 200 ms loud
        cap.begin(200); // speech confirmed 200 ms into the loud run
        const out = cap.end();
        assert.equal(out.samples.length, 500 * (SAMPLE_RATE / 1000));
        // The first 300 ms must be silence, the last 200 ms the loud onset.
        assert.ok([...out.samples.slice(0, 4800)].every((v) => Math.abs(v - 0.001) < 1e-6));
        assert.ok([...out.samples.slice(4800)].every((v) => Math.abs(v - 0.1) < 1e-6));
    });

    it('retains every frame from begin() until end()', () => {
        const cap = createPcmUtteranceCapture();
        for (let i = 0; i < 30; i += 1) cap.processFrame(silentFrame());
        cap.begin(0);
        for (let i = 0; i < 50; i += 1) cap.processFrame(loudFrame());
        const out = cap.end();
        assert.equal(out.samples.length, 800 * (SAMPLE_RATE / 1000));
        assert.equal(cap.isActive, false, 'the utterance is consumed by end()');
    });

    it('hard-caps the active utterance at the max duration', () => {
        // Explicit cap: this asserts the CAP behavior, not the default value.
        const cap = createPcmUtteranceCapture({ maxUtteranceMs: 1500 });
        cap.begin(0);
        for (let i = 0; i < 2000; i += 1) cap.processFrame(loudFrame()); // 20 s fed
        const out = cap.end();
        assert.equal(out.samples.length, 1500 * (SAMPLE_RATE / 1000), 'oldest frames drop, newest are kept');
    });

    it('the capture cap and the detector cap share one default', () => {
        // They must agree: the detector decides when a turn ends, the capture
        // decides how much of it survives. A capture that capped earlier would
        // silently discard the oldest audio of a long utterance.
        const cap = createPcmUtteranceCapture();
        cap.begin(0);
        // Feed well past the OLD 15 s cap. Sharing the detector's cap means
        // all of it is retained.
        for (let i = 0; i < 2000; i += 1) cap.processFrame(loudFrame()); // 20 s
        const out = cap.end();
        assert.equal(out.samples.length, 2000 * FRAME_SAMPLES,
            'the capture must retain a 20 s utterance, so its cap is not 15 s');
    });

    it('discard() clears the active utterance and the pre-roll ring', () => {
        const cap = createPcmUtteranceCapture();
        for (let i = 0; i < 30; i += 1) cap.processFrame(silentFrame());
        cap.begin(0);
        for (let i = 0; i < 20; i += 1) cap.processFrame(loudFrame());
        cap.discard();
        assert.equal(cap.isActive, false);
        assert.equal(cap.bufferedSamples, 0);
        assert.equal(cap.end(), null);
    });

    it('end() without an active utterance returns null, and at most once per utterance', () => {
        const cap = createPcmUtteranceCapture();
        cap.processFrame(silentFrame());
        assert.equal(cap.end(), null);
        cap.begin(0);
        cap.end();
        assert.equal(cap.end(), null, 'a finished utterance is consumed exactly once');
    });

    it('begin() while active is a no-op', () => {
        const cap = createPcmUtteranceCapture();
        for (let i = 0; i < 30; i += 1) cap.processFrame(silentFrame());
        cap.begin(0);
        cap.begin(200); // must not re-seed or extend the first utterance
        for (let i = 0; i < 20; i += 1) cap.processFrame(loudFrame());
        const out = cap.end();
        assert.equal(out.samples.length, 500 * (SAMPLE_RATE / 1000));
    });

    it('takes the sample rate from the frames it is fed', () => {
        const cap = createPcmUtteranceCapture();
        const f = (amp) => ({ samples: new Float32Array(441).fill(amp), sampleRate: 44100 });
        for (let i = 0; i < 5; i += 1) cap.processFrame(f(0.001));
        cap.begin(0);
        cap.processFrame(f(0.1));
        const out = cap.end();
        assert.equal(out.sampleRate, 44100);
        assert.equal(out.samples.length, 6 * 441);
    });

    it('copies frames on entry (ScriptProcessor reuses its input buffer)', () => {
        const cap = createPcmUtteranceCapture();
        const reused = new Float32Array(FRAME_SAMPLES).fill(0.001);
        cap.processFrame({ samples: reused, sampleRate: SAMPLE_RATE });
        reused.fill(0.5); // the "input buffer" is overwritten with the next audio
        cap.begin(0);
        const out = cap.end();
        assert.ok(out.samples.every((v) => Math.abs(v - 0.001) < 1e-6), 'the earlier audio was snapshotted');
    });

    it('ignores invalid frames', () => {
        const cap = createPcmUtteranceCapture();
        cap.processFrame(null);
        cap.processFrame({});
        cap.processFrame({ samples: new Float32Array(0) });
        assert.equal(cap.bufferedSamples, 0);
        cap.begin(0);
        cap.processFrame(null);
        assert.equal(cap.end(), null, 'no samples were ever captured');
    });

    it('consecutive utterances are independent', () => {
        const cap = createPcmUtteranceCapture();
        for (let i = 0; i < 30; i += 1) cap.processFrame(silentFrame());
        cap.begin(0);
        for (let i = 0; i < 20; i += 1) cap.processFrame(loudFrame());
        const first = cap.end();
        for (let i = 0; i < 30; i += 1) cap.processFrame(silentFrame());
        cap.begin(0);
        for (let i = 0; i < 10; i += 1) cap.processFrame(loudFrame());
        const second = cap.end();
        assert.equal(first.samples.length, 500 * (SAMPLE_RATE / 1000));
        assert.equal(second.samples.length, 400 * (SAMPLE_RATE / 1000));
        first.samples[0] = 0.9; // mutating one result must not affect the other
        assert.notEqual(second.samples[0], 0.9);
    });
});

// ─── Playback × Hands-Free integration (real controllers) ──────────────────
// Regression tests for the playback completion lifecycle: the completion
// callback of a new playback must be armed only after the previous playback
// has been stopped, and must fire exactly once when the actual audio ends.
// The real createPlaybackController, createGroupPlaybackQueue, and
// createHandsFreeController are wired together exactly as app.js does; only
// the TTS fetch and the audio element are fakes, and the fake audio "ends"
// only when the test fires its 'ended' event.

function makePlaybackHarness() {
    const created = [];
    const revoked = [];
    let urlCount = 0;
    const audioFactory = () => {
        const audio = {
            src: '',
            played: false,
            paused: false,
            _onEnded: null,
            async play() { this.played = true; },
            pause() { this.paused = true; },
            addEventListener(event, fn) {
                if (event === 'ended') this._onEnded = fn;
            },
            // Simulate the browser firing 'ended' for this element.
            end() {
                const fn = this._onEnded;
                this._onEnded = null;
                if (fn) fn();
            },
        };
        created.push(audio);
        return audio;
    };
    const deps = {
        fetchFn: async () => ({
            ok: true,
            blob: async () => new Blob(['fake-audio']),
            json: async () => ({}),
        }),
        createObjectURL: () => {
            urlCount += 1;
            return `blob:int-${urlCount}`;
        },
        revokeObjectURL: (url) => { revoked.push(url); },
        audioFactory,
    };
    return { deps, created, revoked };
}

function groupQueueFor(playback, onAllDone) {
    // Same item wiring as app.js: an item settles only when the completion
    // callback for its own playback fires.
    return createGroupPlaybackQueue({
        playItem: (text, voice) => new Promise((resolve, reject) => {
            let settled = false;
            playback.play(text, voice, () => {
                if (!settled) { settled = true; resolve(); }
            }).catch((e) => {
                if (!settled) { settled = true; reject(e); }
            });
        }),
        onAllDone,
    });
}

describe('playback × hands-free integration (real controllers)', () => {
    function makeHf() {
        return createHandsFreeController({
            getConversationId: () => 'conv-1',
            startListening: async () => {},
            stopListening: () => {},
        });
    }

    it('starting or replacing playback does not fire the new completion callback', async () => {
        const { deps, created } = makePlaybackHarness();
        const playback = createPlaybackController(deps);
        let firstCalls = 0;
        let secondCalls = 0;
        await playback.play('first', 'v', () => { firstCalls++; });
        assert.equal(firstCalls, 0, 'the internal teardown must not consume the new callback');
        await playback.play('second', 'v', () => { secondCalls++; });
        assert.equal(secondCalls, 0, 'replacing playback must not fire the incoming callback');
        assert.equal(firstCalls, 0, 'a replaced playback is cancelled silently, not completed');
        created[0].end();
        assert.equal(firstCalls, 0, 'a replaced element can no longer complete anything');
        created[1].end();
        assert.equal(secondCalls, 1, 'only the current playback completes');
        assert.equal(firstCalls, 0);
    });

    it('an explicit stop during a pending start resolves its callback exactly once', async () => {
        let resolveFetch;
        const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
        const { deps, created } = makePlaybackHarness();
        const slow = createPlaybackController({
            ...deps,
            fetchFn: () => fetchPromise.then(() => ({
                ok: true,
                blob: async () => new Blob(['fake-audio']),
                json: async () => ({}),
            })),
        });
        let calls = 0;
        const pending = slow.play('msg', 'v', () => { calls++; });
        slow.stop();
        assert.equal(calls, 1, 'an explicit stop cancels the pending playback exactly once');
        assert.equal(slow.isPlaying, false);
        resolveFetch();
        assert.equal(await pending, null, 'the superseded start resolves without playing');
        assert.equal(created.length, 0, 'no audio element was created');
        assert.equal(calls, 1, 'the superseded start must not fire the callback again');
    });

    it('fires the completion callback exactly once when the actual audio ends', async () => {
        const { deps, created, revoked } = makePlaybackHarness();
        const playback = createPlaybackController(deps);
        let calls = 0;
        await playback.play('msg', 'v', () => { calls++; });
        assert.equal(calls, 0);
        created[0].end();
        assert.equal(calls, 1, 'callback fires exactly once on natural end');
        assert.equal(playback.isPlaying, false);
        assert.deepEqual(revoked, ['blob:int-1'], 'the object URL is released on natural end');
        playback.stop();
        assert.equal(calls, 1, 'a stop after completion must not fire again');
    });

    it('manual Play/Replay leave Hands-Free in SPEAKING until the actual audio completes', async () => {
        const { deps, created } = makePlaybackHarness();
        const playback = createPlaybackController(deps);
        const hf = makeHf();
        await hf.enable();
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING);

        // Manual Play wiring as in app.js.
        hf.markSpeakingStart();
        assert.equal(hf.state, HANDSFREE_STATES.SPEAKING);
        await playback.play('msg', 'v', () => { hf.markSpeakingEnd(); });
        assert.equal(hf.state, HANDSFREE_STATES.SPEAKING, 'still speaking while the audio is playing');
        created[0].end();
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING, 'listening resumes only after actual completion');

        // Manual Replay wiring as in app.js.
        hf.markSpeakingStart();
        assert.equal(hf.state, HANDSFREE_STATES.SPEAKING);
        await playback.replay('msg', 'v', () => { hf.markSpeakingEnd(); });
        assert.equal(hf.state, HANDSFREE_STATES.SPEAKING, 'replay must not complete itself either');
        created[1].end();
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING);
    });

    it('a two-item group queue does not start item 2 until item 1 actually ends', async () => {
        const { deps, created } = makePlaybackHarness();
        const playback = createPlaybackController(deps);
        const queue = groupQueueFor(playback, null);
        queue.enqueue('one', 'v1');
        queue.enqueue('two', 'v2');
        const running = queue.playAll();
        await flush();
        assert.equal(created.length, 1, 'item 2 must not start while item 1 is playing');
        assert.equal(queue.isPlaying, true);
        created[0].end();
        await flush();
        assert.equal(created.length, 2, 'item 2 starts only after item 1 ended');
        const done = running.then(() => 'done');
        assert.equal(await Promise.race([done, flush().then(() => 'pending')]), 'pending',
            'the queue must not finish while item 2 is still playing');
        created[1].end();
        await running;
        assert.equal(queue.isPlaying, false);
        assert.equal(queue.pending, 0);
    });

    it('onAllDone does not fire until the final audio item ends', async () => {
        const { deps, created } = makePlaybackHarness();
        const playback = createPlaybackController(deps);
        const hf = makeHf();
        await hf.enable();
        let allDone = 0;
        const queue = groupQueueFor(playback, () => {
            allDone += 1;
            hf.markSpeakingEnd();
        });
        queue.enqueue('one', 'v1');
        queue.enqueue('two', 'v2');
        // Hands-free: one speaking phase covers the whole queued group reply.
        hf.markSpeakingStart();
        const running = queue.playAll();
        await flush();
        assert.equal(allDone, 0);
        assert.equal(hf.state, HANDSFREE_STATES.SPEAKING);
        created[0].end();
        await flush();
        assert.equal(allDone, 0, 'the queue is not done while item 2 plays');
        assert.equal(hf.state, HANDSFREE_STATES.SPEAKING, 'listening must not resume mid-group');
        created[1].end();
        await running;
        assert.equal(allDone, 1, 'onAllDone fires exactly once, after the final item ended');
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING);
    });

    it('an explicit stop resolves the callback exactly once without duplicates', async () => {
        const { deps, created } = makePlaybackHarness();
        const playback = createPlaybackController(deps);
        let calls = 0;
        await playback.play('msg', 'v', () => { calls++; });
        playback.stop();
        assert.equal(calls, 1, 'an explicit stop resolves the current playback exactly once');
        assert.equal(playback.isPlaying, false);
        assert.equal(created[0].paused, true);
        playback.stop();
        assert.equal(calls, 1, 'a second stop must not fire again');
        created[0].end();
        assert.equal(calls, 1, 'a late end event on the cleared element must not fire again');
    });

    it('a failed start rejects without ever firing its completion callback', async () => {
        const { deps } = makePlaybackHarness();
        const failing = createPlaybackController({
            ...deps,
            fetchFn: async () => ({ ok: false, status: 500, json: async () => ({ error: 'TTS down' }) }),
        });
        let calls = 0;
        await assert.rejects(() => failing.play('msg', 'v', () => { calls++; }), /TTS down/);
        assert.equal(calls, 0, 'a failed start must not complete itself');
        failing.stop();
        assert.equal(calls, 0, 'and a later stop must not fire the discarded callback');
    });
});
