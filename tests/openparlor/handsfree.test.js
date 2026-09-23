// ─── TASK-VOICE-HANDSFREE-001: hands-free conversation mode ──────────────────
// Unit tests for the browser-local half-duplex voice loop:
// - createEnergyVad: deterministic, frame-driven RMS endpointing
// - createHandsFreeController: state machine, conversation/epoch guards,
//   TTS cooperation, device loss, and transient-error auto-recovery
// - createContinuousRecorder: ring-buffer timeslice recording, collectBlob,
//   clearBuffer, and mic failure handling
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
    handsFreeStatusText,
    normalizeHandsFreePreference,
} from '../../public/openparlor/handsfree.js';
import {
    createContinuousRecorder,
    createGroupPlaybackQueue,
    createPlaybackController,
} from '../../public/openparlor/audio.js';

// ─── Frame helpers ───────────────────────────────────────────────────────────
// 10 ms mono frames at 16 kHz: 20 loud frames = 200 ms (the default start
// sustain) and 90 silent frames = 900 ms (the default end silence).

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 160;

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

    it('ends the utterance after the sustained silence', () => {
        const ends = [];
        const vad = createEnergyVad({ onSpeechEnd: (reason) => { ends.push(reason); } });
        for (let i = 0; i < 20; i += 1) vad.processFrame(loudFrame());
        assert.equal(vad.isActive, true);
        for (let i = 0; i < 89; i += 1) vad.processFrame(silentFrame()); // 890 ms
        assert.equal(vad.isActive, true);
        vad.processFrame(silentFrame()); // 900 ms
        assert.equal(vad.isActive, false);
        assert.deepEqual(ends, ['silence']);
    });

    it('ends the utterance at the max duration cap', () => {
        const ends = [];
        const vad = createEnergyVad({ onSpeechEnd: (reason) => { ends.push(reason); } });
        for (let i = 0; i < 20; i += 1) vad.processFrame(loudFrame());
        // utteranceStartMs is 0, so the cap hits at clockMs = 15000 (1500 frames).
        for (let i = 0; i < 1479; i += 1) vad.processFrame(loudFrame());
        assert.equal(vad.isActive, true);
        vad.processFrame(loudFrame());
        assert.equal(vad.isActive, false);
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
        clearCalls: 0,
        sent: [],
        blobSince: [],
        events: [],
    };
    const timers = makeFakeTimers();
    let nowValue = 1000;
    const controller = createHandsFreeController({
        getConversationId: () => env.convId,
        getEpoch: () => env.epoch,
        startListening: async () => { env.startCalls += 1; },
        stopListening: () => { env.stopCalls += 1; },
        getUtteranceBlob: (sinceMs) => {
            env.blobSince.push(sinceMs);
            return new Blob(['utterance']);
        },
        clearUtteranceBuffer: () => { env.clearCalls += 1; },
        transcribe: async () => 'hello world',
        onSendText: async (text) => { env.sent.push(text); },
        now: () => nowValue,
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
        // The blob request covers the utterance minus the VAD pre-roll.
        assert.deepEqual(env.blobSince, [700], 'sinceMs = 1000 (start) - 300 (pre-roll)');
        controller.markResponseComplete();
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
    });

    it('returns to listening when there is no utterance blob', async () => {
        const { controller, env, talkAndStop } = makeController({
            getUtteranceBlob: () => null,
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
        assert.equal(env.clearCalls, 1, 'the in-flight utterance buffer was cleared');
        await flush(); // the discarded transcribe call happens in a microtask
        resolveTranscribe('late');
        await flush();
        assert.deepEqual(env.sent, []);
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
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
});
describe('createHandsFreeController TTS cooperation', () => {
    it('markSpeakingStart() discards an in-flight utterance and holds the VAD', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        feed(controller, 20, loudFrame);
        assert.equal(controller.state, HANDSFREE_STATES.HEARING);
        controller.markSpeakingStart();
        assert.equal(controller.state, HANDSFREE_STATES.SPEAKING);
        assert.equal(env.clearCalls, 1, 'the in-flight utterance was discarded');
        // While speaking, even a complete utterance must be ignored.
        feed(controller, 20, loudFrame);
        feed(controller, 90, silentFrame);
        assert.equal(controller.state, HANDSFREE_STATES.SPEAKING);
        await flush();
        assert.deepEqual(env.sent, []);
        assert.equal(env.blobSince.length, 0);
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
// ─── createContinuousRecorder ────────────────────────────────────────────────

function makeFakeMedia() {
    const stopped = [];
    const stream = {
        getTracks: () => [{ stop: () => { stopped.push('stopped'); } }],
    };
    const getUserMediaCalls = [];
    const instances = [];
    const Ctor = class FakeMediaRecorder {
        constructor(s, options) {
            this.stream = s;
            this.options = options || {};
            this.state = 'inactive';
            this.ondataavailable = null;
            instances.push(this);
        }
        start(timeslice) {
            this.state = 'recording';
            this.timeslice = timeslice;
        }
        stop() {
            this.state = 'inactive';
        }
        static isTypeSupported(mime) {
            return mime === 'audio/webm';
        }
    };
    const getUserMedia = async (constraints) => {
        getUserMediaCalls.push(constraints);
        return stream;
    };
    return { Ctor, getUserMedia, getUserMediaCalls, instances, stopped, stream };
}

describe('createContinuousRecorder', () => {
    it('starts recording with the timeslice and reports state changes', async () => {
        const m = makeFakeMedia();
        const states = [];
        const rec = createContinuousRecorder({
            getUserMedia: m.getUserMedia,
            MediaRecorderCtor: m.Ctor,
            onStateChange: (s) => { states.push(s); },
        });
        assert.equal(rec.state, 'idle');
        assert.equal(rec.isRecording, false);
        await rec.start();
        assert.equal(rec.state, 'recording');
        assert.equal(rec.isRecording, true);
        assert.equal(m.instances.length, 1);
        assert.equal(m.instances[0].timeslice, 250, 'default timeslice');
        assert.deepEqual(states, ['recording']);
        rec.stop();
        assert.equal(rec.state, 'idle');
        assert.deepEqual(m.stopped, ['stopped'], 'the mic track is stopped');
    });

    it('collectBlob() returns the chunks since the given time and prunes them', async () => {
        const m = makeFakeMedia();
        let t = 0;
        const rec = createContinuousRecorder({
            getUserMedia: m.getUserMedia,
            MediaRecorderCtor: m.Ctor,
            now: () => t,
        });
        await rec.start();
        const r = m.instances[0];
        t = 0; r.ondataavailable({ data: new Blob(['a']) });
        t = 100; r.ondataavailable({ data: new Blob(['b']) });
        t = 200; r.ondataavailable({ data: new Blob(['c']) });
        const blob = rec.collectBlob(50);
        assert.ok(blob instanceof Blob);
        assert.equal(blob.type, 'audio/webm');
        assert.equal(blob.size, 2, 'only chunks at/after sinceMs (b + c)');
        assert.equal(rec.collectBlob(100), null, 'consumed chunks are removed from the ring');
        t = 300; r.ondataavailable({ data: new Blob(['d']) });
        assert.equal(rec.collectBlob(250).size, 1, 'a later utterance only sees new audio');
    });

    it('collectBlob() returns null without consuming anything on a miss', async () => {
        const m = makeFakeMedia();
        let t = 0;
        const rec = createContinuousRecorder({
            getUserMedia: m.getUserMedia,
            MediaRecorderCtor: m.Ctor,
            now: () => t,
        });
        await rec.start();
        const r = m.instances[0];
        r.ondataavailable({ data: new Blob(['a']) });
        assert.equal(rec.collectBlob(50), null, 'no chunk at/after sinceMs');
        assert.equal(rec.collectBlob(0).size, 1, 'the chunk is still in the ring');
    });

    it('collectBlob() returns null on an empty ring', async () => {
        const m = makeFakeMedia();
        const rec = createContinuousRecorder({
            getUserMedia: m.getUserMedia,
            MediaRecorderCtor: m.Ctor,
        });
        await rec.start();
        assert.equal(rec.collectBlob(0), null);
    });

    it('clearBuffer() empties the ring', async () => {
        const m = makeFakeMedia();
        const rec = createContinuousRecorder({
            getUserMedia: m.getUserMedia,
            MediaRecorderCtor: m.Ctor,
        });
        await rec.start();
        const r = m.instances[0];
        r.ondataavailable({ data: new Blob(['a']) });
        rec.clearBuffer();
        assert.equal(rec.collectBlob(0), null);
    });

    it('ignores empty dataavailable events', async () => {
        const m = makeFakeMedia();
        const rec = createContinuousRecorder({
            getUserMedia: m.getUserMedia,
            MediaRecorderCtor: m.Ctor,
        });
        await rec.start();
        const r = m.instances[0];
        r.ondataavailable({ data: new Blob([]) });
        r.ondataavailable({ data: null });
        assert.equal(rec.collectBlob(0), null);
    });

    it('prunes ring entries older than maxBufferMs', async () => {
        const m = makeFakeMedia();
        let t = 0;
        const rec = createContinuousRecorder({
            getUserMedia: m.getUserMedia,
            MediaRecorderCtor: m.Ctor,
            now: () => t,
            maxBufferMs: 100,
        });
        await rec.start();
        const r = m.instances[0];
        t = 0; r.ondataavailable({ data: new Blob(['old']) });
        t = 200; r.ondataavailable({ data: new Blob(['new']) });
        assert.equal(rec.collectBlob(0).size, 3, 'only the recent chunk survived');
    });

    it('falls back to the fallback constraint when the first request fails', async () => {
        const m = makeFakeMedia();
        let call = 0;
        const rec = createContinuousRecorder({
            getUserMedia: async () => {
                call += 1;
                if (call === 1) throw new Error('constraint rejected');
                return m.stream;
            },
            MediaRecorderCtor: m.Ctor,
            fallbackConstraint: { audio: true },
        });
        await rec.start();
        assert.equal(rec.state, 'recording');
        assert.equal(call, 2);
    });

    it('rejects start on a mic permission denial, preserving the error name', async () => {
        const m = makeFakeMedia();
        const rec = createContinuousRecorder({
            getUserMedia: async () => {
                const e = new Error('denied');
                e.name = 'NotAllowedError';
                throw e;
            },
            MediaRecorderCtor: m.Ctor,
        });
        await assert.rejects(rec.start(), (e) => {
            assert.equal(e.name, 'NotAllowedError', 'name preserved so the controller maps permission-denied');
            assert.equal(e.message, 'Microphone permission denied.');
            return true;
        });
        assert.equal(rec.state, 'error');
        assert.equal(rec.error, 'Microphone permission denied.');
    });

    it('rejects start when the mic is unavailable', async () => {
        const rec = createContinuousRecorder({
            getUserMedia: async () => { throw new Error('no device'); },
            MediaRecorderCtor: makeFakeMedia().Ctor,
        });
        await assert.rejects(rec.start(), /Microphone unavailable\./);
        assert.equal(rec.state, 'error');
        assert.equal(rec.error, 'Microphone unavailable.');
    });

    it('rejects start when MediaRecorder is unavailable', async () => {
        const rec = createContinuousRecorder({
            getUserMedia: makeFakeMedia().getUserMedia,
            MediaRecorderCtor: null,
        });
        await assert.rejects(rec.start(), /MediaRecorder is not supported in this browser\./);
        assert.equal(rec.state, 'error');
        assert.equal(rec.error, 'MediaRecorder is not supported in this browser.');
    });

    it('rejects start when the MediaRecorder constructor or start() throws', async () => {
        const m = makeFakeMedia();
        class ThrowingRecorder extends m.Ctor {
            start() { throw new Error('boom'); }
        }
        const rec = createContinuousRecorder({
            getUserMedia: m.getUserMedia,
            MediaRecorderCtor: ThrowingRecorder,
        });
        await assert.rejects(rec.start(), /Could not start the microphone\./);
        assert.equal(rec.state, 'error');
        assert.equal(rec.error, 'Could not start the microphone.');
    });

    it('borrows a shared stream without stopping its tracks', async () => {
        const m = makeFakeMedia();
        const rec = createContinuousRecorder({
            getUserMedia: () => Promise.resolve(m.stream),
            MediaRecorderCtor: m.Ctor,
            ownsStream: false,
        });
        await rec.start();
        assert.equal(rec.state, 'recording');
        rec.stop();
        assert.equal(m.stopped.length, 0, 'a borrowed stream is never stopped by the recorder');
        assert.equal(rec.state, 'idle');
    });

    it('stop() is safe when nothing is active', () => {
        const m = makeFakeMedia();
        const rec = createContinuousRecorder({
            getUserMedia: m.getUserMedia,
            MediaRecorderCtor: m.Ctor,
        });
        rec.stop();
        assert.equal(rec.state, 'idle');
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

// ─── Recorder startup failure × Hands-Free (integration) ───────────────────
// A continuous-recorder startup failure must reject startListening so the
// controller lands in a controlled error state — never LISTENING — while the
// app-level teardown (mirrored here) stops the shared mic stream exactly
// once so the microphone indicator goes off.

describe('recorder startup failure × hands-free (integration)', () => {
    function makeSharedMicWiring(getUserMedia, MediaRecorderCtor) {
        const track = { stopped: 0, stop() { this.stopped += 1; } };
        const sharedStream = { getTracks: () => [track] };
        const recorder = createContinuousRecorder({
            getUserMedia,
            MediaRecorderCtor,
            ownsStream: false,
        });
        const startListening = async () => {
            try {
                await recorder.start();
            } catch (e) {
                recorder.stop();
                for (const t of sharedStream.getTracks()) t.stop();
                throw e;
            }
        };
        return { track, startListening, recorder };
    }

    it('never reports LISTENING when the continuous recorder fails to start', async () => {
        const states = [];
        const { track, startListening, recorder } = makeSharedMicWiring(
            () => Promise.resolve({ getTracks: () => [track] }),
            null, // unsupported MediaRecorder → start() must reject
        );
        const hf = createHandsFreeController({
            getConversationId: () => 'conv-1',
            startListening,
            stopListening: () => {},
            onStateChange: (s) => { states.push(s); },
        });
        await hf.enable();
        assert.equal(hf.state, HANDSFREE_STATES.ERROR, 'a failed recorder must leave a controlled error state');
        assert.equal(hf.stateInfo.error, 'microphone');
        assert.equal(states[states.length - 1], HANDSFREE_STATES.ERROR, 'the final reported state is error, not listening');
        assert.equal(track.stopped, 1, 'the shared mic track stops exactly once (indicator off)');
        assert.equal(recorder.state, 'idle', 'the recorder is torn down');
    });

    it('maps a recorder permission denial to permission-denied', async () => {
        const deny = new Error('denied');
        deny.name = 'NotAllowedError';
        const { track, startListening } = makeSharedMicWiring(
            () => Promise.reject(deny),
            makeFakeMedia().Ctor,
        );
        const hf = createHandsFreeController({
            getConversationId: () => 'conv-1',
            startListening,
            stopListening: () => {},
        });
        await hf.enable();
        assert.equal(hf.state, HANDSFREE_STATES.ERROR);
        assert.equal(hf.stateInfo.error, 'permission-denied', 'the preserved error name selects the denial message');
        assert.equal(track.stopped, 1, 'the shared mic track stops exactly once (indicator off)');
    });
});