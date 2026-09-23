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
import {
    HANDSFREE_STATES,
    computeFrameRms,
    createEnergyVad,
    createHandsFreeController,
    handsFreeStatusText,
    normalizeHandsFreePreference,
} from '../../public/openparlor/handsfree.js';
import { createContinuousRecorder } from '../../public/openparlor/audio.js';

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

    it('maps a mic permission denial to a safe error', async () => {
        const m = makeFakeMedia();
        const rec = createContinuousRecorder({
            getUserMedia: async () => {
                const e = new Error('denied');
                e.name = 'NotAllowedError';
                throw e;
            },
            MediaRecorderCtor: m.Ctor,
        });
        await rec.start();
        assert.equal(rec.state, 'error');
        assert.equal(rec.error, 'Microphone permission denied.');
    });

    it('maps an unavailable mic to a safe error', async () => {
        const rec = createContinuousRecorder({
            getUserMedia: async () => { throw new Error('no device'); },
            MediaRecorderCtor: makeFakeMedia().Ctor,
        });
        await rec.start();
        assert.equal(rec.state, 'error');
        assert.equal(rec.error, 'Microphone unavailable.');
    });

    it('errors when MediaRecorder is unavailable', async () => {
        const rec = createContinuousRecorder({
            getUserMedia: makeFakeMedia().getUserMedia,
            MediaRecorderCtor: null,
        });
        await rec.start();
        assert.equal(rec.state, 'error');
        assert.equal(rec.error, 'MediaRecorder is not supported in this browser.');
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