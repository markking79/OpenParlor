/**
 * VOICE-003: Hands-Free barge-in tests.
 *
 * Covers the interrupt contract from the VOICE-003 specification:
 * - createBargeInDetector: sustained-speech confirmation, a threshold that is
 *   strictly stronger than the LISTENING VAD's, candidate lifecycle, release
 *   silence, and the turn-identity token that makes a stale confirmation inert
 * - createEnergyVad.adopt: an already-proven utterance goes straight to
 *   endpoint detection (otherwise a one-word interrupt never ends)
 * - createHandsFreeController: the SPEAKING frame route, the pre-roll
 *   guarantee, exactly-once confirmation, and every path that must cancel a
 *   live candidate (TTS end, conversation switch, device loss, toggle off)
 * - composition with the REAL stop path, streaming turn, streaming TTS
 *   session, playback controller, and legacy group queue
 *
 * Every browser API is an injected fake; there are no sleeps and no
 * wall-clock timing anywhere in this file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    HANDSFREE_STATES,
    DEFAULT_BARGE_IN_OPTIONS,
    createBargeInDetector,
    createEnergyVad,
    createHandsFreeController,
} from '../../public/openparlor/handsfree.js';
import {
    createActiveSendController,
    createStopTurnEffects,
    createStreamingTurnState,
    createTtsOwnershipController,
} from '../../public/openparlor/app.js';
import { createVoiceTurnTimer } from '../../public/openparlor/openparlor.js';
import { createGroupPlaybackQueue, createPlaybackController } from '../../public/openparlor/audio.js';
import { createStreamingTtsSession } from '../../public/openparlor/streaming-tts.js';

// ─── Frame helpers ───────────────────────────────────────────────────────────
// 10 ms mono frames at 16 kHz. The default barge-in sustain is 300 ms (30
// loud frames); the LISTENING VAD start sustain is 200 ms (20 frames) and its
// end silence is 900 ms (90 silent frames).

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 160;
// 10 ms per frame at 16 kHz; the VAD is frame-driven, so durations are in frames.
const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;

function frame(amp) {
    const samples = new Float32Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) samples[i] = amp;
    return { samples, sampleRate: SAMPLE_RATE };
}

/** Well above both thresholds: an unambiguous human interjection. */
const userSpeech = () => frame(0.1);
/** Between the LISTENING threshold (0.01) and the barge threshold (0.03). */
const residualEcho = () => frame(0.02);
const silence = () => frame(0.001);

function feed(hf, count, make = userSpeech) {
    for (let i = 0; i < count; i += 1) hf.onAudioFrame(make());
}

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

async function flushMicrotasks() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await flush();
}

// ─── WAV reader (asserts on the exact bytes handed to STT) ──────────────────

async function parseWav(blob) {
    const buf = Buffer.from(await blob.arrayBuffer());
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
    const channels = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const bits = buf.readUInt16LE(34);
    const dataLen = buf.readUInt32LE(40);
    const count = dataLen / 2;
    const pcm = new Int16Array(count);
    for (let i = 0; i < count; i += 1) pcm[i] = buf.readInt16LE(44 + i * 2);
    return { channels, sampleRate, bits, pcm };
}

const countAbove = (pcm, limit) => pcm.filter((v) => Math.abs(v) >= limit).length;

// ─── createBargeInDetector ───────────────────────────────────────────────────

describe('createBargeInDetector', () => {
    it('uses a threshold strictly stronger than the LISTENING VAD default', () => {
        const vad = createEnergyVad({});
        assert.ok(
            DEFAULT_BARGE_IN_OPTIONS.speechThreshold > 0.01,
            'the barge-in threshold must sit above the LISTENING VAD default',
        );
        assert.equal(vad.preRollMs, 300, 'pre-roll stays in the recommended 250-400 ms band');
    });

    it('confirms only after the sustained window, and reports how far back speech reaches', () => {
        const confirmations = [];
        const detector = createBargeInDetector({
            onConfirm: (info) => { confirmations.push(info); },
        });
        const token = detector.arm();
        for (let i = 0; i < 29; i += 1) detector.processFrame(userSpeech());
        assert.equal(confirmations.length, 0, '290 ms of speech is not yet confirmed');
        detector.processFrame(userSpeech()); // the 30th frame = 300 ms
        assert.equal(confirmations.length, 1, '300 ms of sustained speech confirms');
        assert.equal(confirmations[0].token, token, 'the confirmation carries the turn identity');
        assert.equal(confirmations[0].lookbackMs, 300, 'lookback is the confirmed sustained length');
        assert.equal(detector.isArmed, false, 'confirmation is one-shot');
    });

    it('ignores silence, and residual AI echo below the stronger threshold', () => {
        const confirmations = [];
        const detector = createBargeInDetector({ onConfirm: (i) => confirmations.push(i) });
        detector.arm();
        for (let i = 0; i < 200; i += 1) detector.processFrame(silence());
        for (let i = 0; i < 200; i += 1) detector.processFrame(residualEcho());
        assert.equal(confirmations.length, 0, 'neither silence nor sub-threshold echo interrupts');
    });

    it('a short loud burst never confirms', () => {
        const confirmations = [];
        const detector = createBargeInDetector({ onConfirm: (i) => confirmations.push(i) });
        detector.arm();
        // A cough / a click on the desk: 150 ms of energy, then quiet.
        for (let i = 0; i < 15; i += 1) detector.processFrame(userSpeech());
        for (let i = 0; i < 40; i += 1) detector.processFrame(silence());
        for (let i = 0; i < 15; i += 1) detector.processFrame(userSpeech());
        for (let i = 0; i < 40; i += 1) detector.processFrame(silence());
        assert.equal(confirmations.length, 0, 'no single burst is an interrupt');
        assert.equal(detector.isCandidate, false, 'release silence closes the candidate');
    });

    it('re-anchors the audio on every sustained-run restart', () => {
        const started = [];
        const detector = createBargeInDetector({
            onSustainStart: () => started.push(1),
        });
        detector.arm();
        for (let i = 0; i < 10; i += 1) detector.processFrame(userSpeech());
        for (let i = 0; i < 10; i += 1) detector.processFrame(userSpeech());
        assert.deepEqual(started, [1], 'a continuous run anchors exactly once');
        for (let i = 0; i < 10; i += 1) detector.processFrame(silence()); // 100 ms
        for (let i = 0; i < 5; i += 1) detector.processFrame(userSpeech());
        assert.deepEqual(started, [1, 1], 'a hesitation re-anchors so stale audio is dropped');
    });

    it('closes the candidate on release silence', () => {
        const ended = [];
        const detector = createBargeInDetector({ onCandidateEnd: () => ended.push(1) });
        detector.arm();
        for (let i = 0; i < 10; i += 1) detector.processFrame(userSpeech());
        for (let i = 0; i < 19; i += 1) detector.processFrame(silence());
        assert.deepEqual(ended, [], 'a brief pause does not close the candidate');
        detector.processFrame(silence()); // 200 ms of quiet
        assert.deepEqual(ended, [1]);
        assert.equal(detector.isCandidate, false);
    });

    it('survives a hesitation mid-sentence without confirming or splitting', () => {
        const confirmations = [];
        const detector = createBargeInDetector({ onConfirm: (i) => confirmations.push(i) });
        detector.arm();
        for (let i = 0; i < 20; i += 1) detector.processFrame(userSpeech());
        for (let i = 0; i < 10; i += 1) detector.processFrame(silence()); // 100 ms pause
        for (let i = 0; i < 20; i += 1) detector.processFrame(userSpeech());
        assert.equal(confirmations.length, 0, 'the streak restarts after the hesitation');
        for (let i = 0; i < 20; i += 1) detector.processFrame(userSpeech());
        assert.equal(confirmations.length, 1, 'the rest of the sentence confirms once');
        assert.equal(confirmations[0].lookbackMs, 300, 'lookback covers the sustained tail');
    });

    it('re-arming issues a new identity and drops the previous candidate', () => {
        const detector = createBargeInDetector({ onConfirm: () => {} });
        const first = detector.arm();
        for (let i = 0; i < 20; i += 1) detector.processFrame(userSpeech());
        const second = detector.arm();
        assert.notEqual(second, first, 'every armed turn has its own identity');
        assert.equal(detector.isCandidate, false, 'a candidate never straddles two turns');
        assert.equal(detector.token, second);
    });

    it('disarm() makes a pending candidate inert', () => {
        const confirmations = [];
        const detector = createBargeInDetector({ onConfirm: (i) => confirmations.push(i) });
        detector.arm();
        for (let i = 0; i < 20; i += 1) detector.processFrame(userSpeech());
        detector.disarm();
        for (let i = 0; i < 100; i += 1) detector.processFrame(userSpeech());
        assert.equal(confirmations.length, 0, 'a disarmed detector never confirms');
        assert.equal(detector.isArmed, false);
        assert.equal(detector.token, null);
    });

    it('ignores frames entirely while never armed', () => {
        const confirmations = [];
        const detector = createBargeInDetector({ onConfirm: (i) => confirmations.push(i) });
        for (let i = 0; i < 500; i += 1) detector.processFrame(userSpeech());
        assert.equal(confirmations.length, 0);
    });
});

// ─── createEnergyVad.adopt ───────────────────────────────────────────────────

describe('createEnergyVad.adopt (VOICE-003)', () => {
    it('starts endpoint detection immediately for an already-proven utterance', () => {
        const ends = [];
        const vad = createEnergyVad({
            onSpeechStart: () => assert.fail('adopt must not re-run the start detector'),
            onSpeechEnd: (reason) => { ends.push(reason); },
        });
        vad.hold();
        vad.adopt(300);
        assert.equal(vad.isHeld, false, 'adopt releases the TTS hold');
        assert.equal(vad.isActive, true, 'the utterance is already in progress');
        // VOICE-004: endpointing is adaptive, and adopt() credits the 300 ms
        // of speech already spent, so ask the detector for its own threshold.
        const frames = Math.ceil(vad.requiredSilenceMs / FRAME_MS);
        for (let i = 0; i < frames - 1; i += 1) vad.processFrame(silence());
        assert.deepEqual(ends, [], 'the pause is not quite long enough yet');
        vad.processFrame(silence());
        assert.deepEqual(ends, ['silence'], 'a one-word interrupt can still end');
    });

    it('credits already-elapsed speech to the max-duration cap', () => {
        const ends = [];
        // Explicit cap so this asserts the CREDIT, not the default value.
        const vad = createEnergyVad({ maxUtteranceMs: 1000, onSpeechEnd: (reason) => { ends.push(reason); } });
        // A 0.9 s lookback plus 0.2 s of frames crosses the 1 s cap.
        vad.adopt(900);
        for (let i = 0; i < 20; i += 1) vad.processFrame(silence());
        assert.deepEqual(ends, ['max-duration'], 'the cap is measured from the real onset');
    });
});

// ─── Hands-Free controller: SPEAKING frame routing ──────────────────────────

function makeController(overrides = {}) {
    const env = {
        convId: 'conv-1',
        epoch: 1,
        startCalls: 0,
        stopCalls: 0,
        sent: [],
        blobs: [],
        events: [],
        bargeIns: [],
    };
    const controller = createHandsFreeController({
        getConversationId: () => env.convId,
        getEpoch: () => env.epoch,
        startListening: async () => { env.startCalls += 1; },
        stopListening: () => { env.stopCalls += 1; },
        transcribe: async (blob) => {
            env.blobs.push(blob);
            return 'wait';
        },
        onSendText: async (text) => { env.sent.push(text); },
        onBargeInConfirm: (info) => { env.bargeIns.push(info); },
        onStateChange: (state) => { env.events.push(state); },
        ...overrides,
    });
    return { controller, env };
}

describe('Hands-Free barge-in detection (SPEAKING)', () => {
    it('sustained user speech interrupts; silence and residual echo do not', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        feed(controller, 60, silence); // the AI is quiet
        feed(controller, 100, residualEcho); // its voice bleeding into the mic
        assert.equal(env.bargeIns.length, 0, 'the AI talking is not a user interrupt');
        assert.equal(controller.state, HANDSFREE_STATES.SPEAKING);
        feed(controller, 29, userSpeech);
        assert.equal(env.bargeIns.length, 0, '290 ms is below the sustained window');
        feed(controller, 1, userSpeech);
        assert.equal(env.bargeIns.length, 1, '300 ms of sustained speech confirms');
    });

    it('confirms exactly once per turn, however long the user keeps talking', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        feed(controller, 120, userSpeech);
        feed(controller, 200, silence);
        assert.equal(env.bargeIns.length, 1, 'one interrupt, one notification');
        await flush();
        assert.deepEqual(env.sent, ['wait'], 'exactly one message is produced');
    });

    it('preserves the pre-roll so the first word is not lost', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        feed(controller, 30, userSpeech); // the interrupt that confirms
        feed(controller, 10, userSpeech); // the user keeps going
        feed(controller, 90, silence);
        await flush();
        assert.equal(env.blobs.length, 1, 'one STT request');
        const wav = await parseWav(env.blobs[0]);
        // All 40 loud frames must be present, so the leading word that
        // triggered the interrupt is not clipped away.
        assert.equal(
            countAbove(wav.pcm, 1000),
            40 * FRAME_SAMPLES,
            'every frame of the confirmed interrupt survives into the WAV',
        );
    });

    it('never leaks AI audio into the interrupt', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        // Louder AI bleed, then a 150 ms gap — under the 200 ms release
        // silence, so the candidate survives, but the sustained streak breaks
        // and the capture re-anchors on the interjection.
        feed(controller, 29, () => frame(0.5));
        feed(controller, 15, silence);
        assert.equal(env.bargeIns.length, 0, 'the bleed alone is not an interrupt');
        feed(controller, 30, userSpeech); // the real interjection
        feed(controller, 90, silence);
        await flush();
        const wav = await parseWav(env.blobs[0]);
        assert.equal(
            countAbove(wav.pcm, 10000),
            0,
            'no TTS-amplitude sample reached the interrupting utterance',
        );
        assert.equal(
            countAbove(wav.pcm, 1000),
            30 * FRAME_SAMPLES,
            'the interjection is captured whole, starting at its own onset',
        );
    });

    it('drops the speculative audio when a candidate dies before confirming', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        feed(controller, 20, userSpeech); // candidate opens
        feed(controller, 40, silence); // ...and is released without confirming
        // A separate later interjection must not inherit that abandoned audio.
        feed(controller, 30, userSpeech);
        feed(controller, 90, silence);
        await flush();
        assert.equal(env.blobs.length, 1);
        const wav = await parseWav(env.blobs[0]);
        assert.equal(
            countAbove(wav.pcm, 1000),
            30 * FRAME_SAMPLES,
            'the abandoned candidate audio was discarded',
        );
    });

    it('moves to HEARING before notifying the app, so teardown cannot reopen listening', async () => {
        const seen = [];
        const { controller } = makeController({
            onBargeInConfirm: () => { seen.push(controller.state); },
        });
        await controller.enable();
        controller.markSpeakingStart();
        feed(controller, 30, userSpeech);
        assert.deepEqual(seen, [HANDSFREE_STATES.HEARING],
            'the app is notified only after the state left SPEAKING');
        assert.equal(controller.state, HANDSFREE_STATES.HEARING);
    });

    it('one barge-in produces one STT request', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        feed(controller, 30, userSpeech);
        feed(controller, 90, silence);
        await flush();
        // More silence afterwards: the VAD is already reset, so no second
        // utterance can be produced.
        feed(controller, 200, silence);
        await flush();
        assert.equal(env.blobs.length, 1, 'exactly one transcription');
        assert.deepEqual(env.sent, ['wait']);
    });
});

describe('Hands-Free barge-in cancellation paths', () => {
    it('TTS ending naturally while a candidate exists is handled safely', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        feed(controller, 20, userSpeech); // candidate opens, not yet confirmed
        controller.markSpeakingEnd();
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
        assert.equal(env.bargeIns.length, 0);
        // The remaining 100 ms of that candidate must not confirm anything.
        feed(controller, 10, userSpeech);
        assert.equal(env.bargeIns.length, 0, 'the ended turn cannot be interrupted');
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
        // The ordinary loop still works afterwards.
        feed(controller, 20, userSpeech);
        feed(controller, 90, silence);
        await flush();
        assert.deepEqual(env.sent, ['wait']);
    });

    it('a second speaking turn gets its own identity', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        const firstToken = controller.bargeIn.token;
        controller.markSpeakingEnd();
        controller.markSpeakingStart();
        assert.notEqual(controller.bargeIn.token, firstToken, 'a new turn is a new identity');
        feed(controller, 30, userSpeech);
        assert.equal(env.bargeIns.length, 1, 'the current turn is still interruptible');
    });

    it('a conversation switch invalidates a live candidate', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        feed(controller, 20, userSpeech); // candidate opens
        controller.invalidate(); // the user switches conversation mid-interrupt
        assert.equal(env.bargeIns.length, 0, 'the old candidate is dropped');
        feed(controller, 100, userSpeech);
        assert.equal(env.bargeIns.length, 0, 'a stale candidate can never cancel a newer turn');
    });

    it('disabling hands-free invalidates a live candidate', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        feed(controller, 20, userSpeech);
        controller.disable();
        assert.equal(controller.state, HANDSFREE_STATES.OFF);
        feed(controller, 200, userSpeech);
        assert.equal(env.bargeIns.length, 0, 'a disabled session interrupts nothing');
    });

    it('device loss invalidates a live candidate', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        feed(controller, 20, userSpeech);
        controller.onDeviceLost();
        assert.equal(controller.stateInfo.error, 'device-lost');
        feed(controller, 200, userSpeech);
        assert.equal(env.bargeIns.length, 0);
    });

    it('normal Hands-Free without any interrupt is unchanged', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        feed(controller, 20, userSpeech);
        feed(controller, 90, silence);
        await flush();
        assert.deepEqual(env.sent, ['wait'], 'the ordinary listen/answer loop still works');
        assert.equal(env.bargeIns.length, 0);
        // And a following turn still speaks.
        controller.markSpeakingStart();
        assert.equal(controller.state, HANDSFREE_STATES.SPEAKING);
        controller.markSpeakingEnd();
        assert.equal(controller.state, HANDSFREE_STATES.LISTENING);
    });

    it('a short one-word interrupt cannot leave Hands-Free stuck in HEARING', async () => {
        const { controller, env } = makeController();
        await controller.enable();
        controller.markSpeakingStart();
        feed(controller, 30, userSpeech); // "wait"
        assert.equal(controller.state, HANDSFREE_STATES.HEARING);
        feed(controller, 90, silence);
        await flush();
        assert.deepEqual(env.sent, ['wait'], 'the interrupt was endpointed and sent');
        assert.notEqual(controller.state, HANDSFREE_STATES.HEARING);
    });
});

// ─── Composition: the real stop path, turn, session, playback ───────────────
//
// These are the tests that actually prove the interrupt does not corrupt the
// rest of the pipeline. Everything below the Hands-Free controller is the same
// wiring app.js uses — real createStreamingTurnState, real
// createStreamingTtsSession, real playback controller, real legacy group
// queue, real Stop effects, and a real AbortController. Only the TTS fetch,
// the Audio element, and the sentence synthesizer are fakes.

function makeFakeAudio(registry) {
    const audio = {
        src: '',
        played: false,
        paused: false,
        endedHandler: null,
        addEventListener(type, fn) { if (type === 'ended') audio.endedHandler = fn; },
        play() { audio.played = true; return Promise.resolve(); },
        pause() { this.paused = true; },
        fireEnded() {
            const handler = this.endedHandler;
            this.endedHandler = null;
            if (handler) handler();
        },
    };
    registry.push(audio);
    return audio;
}

/**
 * A synthesizer whose requests stay in flight until the test either resolves
 * them (to let real audio start) or aborts them (to observe cancellation).
 */
function makeSynthesize() {
    const flights = [];
    const synthesize = ({ text, voice, signal }) => new Promise((resolve, reject) => {
        const flight = { text, voice, signal, resolve, reject, done: false };
        flights.push(flight);
        if (signal) {
            signal.addEventListener('abort', () => {
                if (flight.done) return;
                flight.done = true;
                reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
            }, { once: true });
        }
    });
    const resolveAll = () => {
        for (const flight of flights) {
            if (flight.done) continue;
            flight.done = true;
            flight.resolve(new Blob(['audio-' + flight.text]));
        }
    };
    return { synthesize, flights, resolveAll };
}

/** Audio elements that actually started and have not been released. */
const activeAudios = (audios) => audios.filter((a) => a.played && !a.paused && a.src !== '');

/**
 * The full app-level turn stack, with a real Hands-Free controller whose
 * barge-in confirmation is routed through the EXACT Stop path
 * (createStopTurnEffects + createActiveSendController), matching
 * onHandsFreeBargeIn in app.js.
 */
function makeTurnStack() {
    const calls = { settled: [], bargeIns: [], stopProgress: 0, refreshButtons: 0 };
    const audios = [];
    const sent = [];
    const { synthesize, flights, resolveAll } = makeSynthesize();
    let urlSeq = 0;
    const playback = createPlaybackController({
        fetchFn: async () => ({ ok: true, blob: async () => new Blob(['a']), json: async () => ({}) }),
        createObjectURL: () => `blob:barge-${(++urlSeq)}`,
        revokeObjectURL: () => {},
        audioFactory: (url) => Object.assign(makeFakeAudio(audios), { src: url }),
    });
    const groupQueue = createGroupPlaybackQueue({
        playItem: async () => {},
        onAllDone: () => { hf.markSpeakingEnd(); },
    });
    const timer = createVoiceTurnTimer();

    const hf = createHandsFreeController({
        getConversationId: () => 'conv-1',
        getEpoch: () => 1,
        startListening: async () => {},
        stopListening: () => {},
        transcribe: async () => 'wait',
        onSendText: async (text) => { sent.push(text); },
        // The interrupt is a user Stop: same path, same ordering, same
        // guarantees. Nothing about it is a second cancellation system.
        onBargeInConfirm: () => { calls.bargeIns.push(1); send.stopUser(); },
    });

    // A turn is terminal once cancelled, so each send gets its own — exactly
    // as sendMessage() does in app.js.
    let turn = null;
    const newTurn = () => {
        turn = createStreamingTurnState({
            isCurrent: () => true,
            isEligible: () => true,
            resolveVoice: () => 'voice-a',
            createSession: (hooks) => createStreamingTtsSession({
                synthesize,
                playback,
                onFirstAudioStart: hooks.onFirstAudioStart,
                onTurnEnd: hooks.onTurnEnd,
            }),
            onFirstAudio: () => { hf.markSpeakingStart(); },
            onTurnSettled: (state) => {
                calls.settled.push({ firstAudioStarted: state.firstAudioStarted });
                if (state.firstAudioStarted) hf.markSpeakingEnd();
                else hf.markResponseComplete();
            },
        });
        return turn;
    };

    const ownership = createTtsOwnershipController({
        cancelStreamingTurn: (reason) => { if (turn) turn.cancel(reason); },
        groupQueue,
        playback,
        timer,
        markSpeakingEnd: () => { hf.markSpeakingEnd(); },
        refreshButtons: () => { calls.refreshButtons += 1; },
    });
    const stopEffects = createStopTurnEffects({
        stopActiveTts: (reason, options) => ownership.stopActiveTts(reason, options),
        getHandsfree: () => hf,
        stopProgress: () => { calls.stopProgress += 1; },
    });
    const send = createActiveSendController({
        button: { textContent: '', disabled: false, setAttribute: () => {} },
        onStop: () => { stopEffects(); },
    });

    /**
     * One send: a fresh send identity AND a fresh turn, exactly as
     * sendMessage() does in app.js (begin() then createStreamingTurnState).
     * @returns {{ send: object, turn: object }}
     */
    const beginSend = () => ({ send: send.begin(), turn: newTurn() });

    return { hf, playback, groupQueue, timer, calls, flights, resolveAll, audios, send, ownership, sent, beginSend };
}

describe('barge-in composed with the real stop path', () => {
    it('aborts the model stream, makes the turn terminal, and stops the audio', async () => {
        const s = makeTurnStack();
        await s.hf.enable();
        const { send, turn } = s.beginSend();
        assert.equal(send.abortController.signal.aborted, false);

        // The AI starts answering: a streamed sentence plays real audio.
        turn.onSpeakerStart('c1');
        turn.onDelta('Hello there. ');
        turn.onDone();
        s.resolveAll();
        await flushMicrotasks();
        assert.equal(s.hf.state, HANDSFREE_STATES.SPEAKING, 'the AI is audibly speaking');
        assert.equal(activeAudios(s.audios).length, 1, 'audio is playing');
        const sentencesSynthesized = s.flights.length;

        // The user interrupts.
        feed(s.hf, 30, userSpeech);
        assert.equal(s.calls.bargeIns.length, 1, 'the interrupt was confirmed');
        assert.equal(send.abortController.signal.aborted, true, 'the model stream was aborted');
        assert.equal(s.hf.state, HANDSFREE_STATES.HEARING, 'capturing the interjection');

        // The turn is terminal: no new synthesis, no restart, exactly one settle.
        await flushMicrotasks();
        assert.equal(s.flights.length, sentencesSynthesized, 'no sentence was started after the Stop');
        assert.equal(s.calls.settled.length, 1, 'the turn settled exactly once');
        assert.equal(turn.mode, 'stopped');
        assert.equal(activeAudios(s.audios).length, 0, 'the AI audio stopped immediately');
        assert.equal(s.calls.stopProgress, 1, 'the response-start window was cancelled');
    });

    it('pending sentences never begin after the interrupt', async () => {
        const s = makeTurnStack();
        await s.hf.enable();
        const { turn } = s.beginSend();
        turn.onSpeakerStart('c1');
        turn.onDelta('First sentence. ');
        turn.onDelta('Second sentence that was still being generated. ');
        turn.onDone();
        s.resolveAll();
        await flushMicrotasks();
        assert.equal(s.audios.filter((a) => a.played).length, 1, 'only the first sentence started');

        feed(s.hf, 30, userSpeech);
        await flushMicrotasks();
        // The second sentence was synthesized but must never reach playback.
        assert.equal(
            s.audios.filter((a) => a.played).length,
            1,
            'a synthesized-but-unplayed sentence stays unplayed',
        );
        assert.equal(activeAudios(s.audios).length, 0);
    });

    it('preserves the partial assistant text instead of reporting an error', async () => {
        const s = makeTurnStack();
        await s.hf.enable();
        const { send, turn } = s.beginSend();
        turn.onSpeakerStart('c1');
        turn.onDelta('I was about to say something long. ');
        turn.onDone();
        s.resolveAll();
        await flushMicrotasks();

        feed(s.hf, 30, userSpeech);
        assert.equal(send.stoppedByUser, true, 'the interrupt is classified as a user Stop');
        // The turn settles as a stop, never as a failure: nothing runs the
        // error effect that would overwrite the bubble with a connection error.
        assert.deepEqual(s.calls.settled, [{ firstAudioStarted: true }]);
    });

    it('an interrupt during a legacy group-queue reply also stops cleanly', async () => {
        const s = makeTurnStack();
        await s.hf.enable();
        s.send.begin();
        s.hf.markSpeakingStart(); // legacy path marks the phase at queue start
        assert.equal(s.hf.state, HANDSFREE_STATES.SPEAKING);
        feed(s.hf, 30, userSpeech);
        assert.equal(s.calls.bargeIns.length, 1);
        assert.equal(s.hf.state, HANDSFREE_STATES.HEARING,
            'the stale onAllDone cannot reopen listening');
        await flushMicrotasks();
        assert.equal(s.groupQueue.isPlaying, false);
        assert.equal(s.hf.state, HANDSFREE_STATES.HEARING,
            'a stale queue callback never clobbers the interrupting utterance');
    });

    it('manual Stop still works unchanged alongside barge-in', async () => {
        const s = makeTurnStack();
        await s.hf.enable();
        const { send, turn } = s.beginSend();
        turn.onSpeakerStart('c1');
        turn.onDelta('Stop me. ');
        turn.onDone();
        s.resolveAll();
        await flushMicrotasks();
        assert.equal(s.hf.state, HANDSFREE_STATES.SPEAKING);

        s.send.stopUser();
        assert.equal(send.abortController.signal.aborted, true);
        assert.equal(s.hf.state, HANDSFREE_STATES.LISTENING, 'Stop settles back to listening');
        assert.equal(activeAudios(s.audios).length, 0);
        assert.equal(s.calls.bargeIns.length, 0, 'a manual Stop is not a barge-in');
    });

    it('an interrupt with no model turn in flight still stops the audio', async () => {
        const s = makeTurnStack();
        await s.hf.enable();
        // Manual Play: audio ownership without an active send.
        const playing = s.playback.play('a message', 'voice-a', () => { s.hf.markSpeakingEnd(); });
        s.hf.markSpeakingStart();
        await playing;
        assert.equal(s.hf.state, HANDSFREE_STATES.SPEAKING);
        assert.equal(activeAudios(s.audios).length, 1);

        feed(s.hf, 30, userSpeech);
        assert.equal(s.calls.bargeIns.length, 1);
        // stopUser() with no active send is a no-op, which is exactly the case
        // onHandsFreeBargeIn handles with the audio-only fallback in app.js.
        assert.equal(s.send.stopUser(), null);
        s.ownership.stopActiveTts('barge-in', { markSpeakingEnd: true });
        assert.equal(activeAudios(s.audios).length, 0, 'the audio owner was released');
        assert.equal(s.hf.state, HANDSFREE_STATES.HEARING,
            'the interrupting utterance is untouched by the teardown');
    });

    it('the whole loop survives repeated interrupts', async () => {
        const s = makeTurnStack();
        await s.hf.enable();

        for (let round = 1; round <= 2; round += 1) {
            // A turn starts and the AI answers out loud.
            const { turn } = s.beginSend();
            turn.onSpeakerStart('c1');
            turn.onDelta(`Answer number ${round}. `);
            turn.onDone();
            s.resolveAll();
            await flushMicrotasks();
            assert.equal(s.hf.state, HANDSFREE_STATES.SPEAKING, `round ${round} is speaking`);

            // The user interrupts and keeps talking for a moment.
            feed(s.hf, 30, userSpeech);
            feed(s.hf, 10, userSpeech);
            assert.equal(s.hf.state, HANDSFREE_STATES.HEARING, `round ${round} captured`);

            // Then stops talking: the interrupt is transcribed and sent.
            feed(s.hf, 90, silence);
            await flushMicrotasks();
            assert.equal(s.sent.length, round, `round ${round} produced one send`);
            assert.equal(s.sent[round - 1], 'wait');
            assert.equal(s.calls.bargeIns.length, round, 'one interrupt per round');
        }
    });
});
