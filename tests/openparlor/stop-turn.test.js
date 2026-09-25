// ─── VOICE-002 Step 2E: user-visible stop generation control ─────────────────
// Unit tests for the extracted stop contract:
// - createResponseStartProgress: per-speaker pending window with injected
//   clock/timers; identity-guarded start/stop/complete/setName/isPending so a
//   stale send can never tick into, complete, or clear a newer send's window
// - createActiveSendController: per-send identity ({ token, abortController,
//   stoppedByUser }); the Send button doubles as Stop and is never disabled
//   while a turn is in flight; idempotent user Stop (mark -> teardown ->
//   abort -> idle); external abort that must NOT be classified as a user
//   stop; identity-safe settle for stale catch/finally paths
// - createSendCompletionHandler: classification of a send's stream error
//   (user Stop vs external abort vs real failure) and stale-send isolation —
//   an aborted send's rejection may land AFTER a newer send has begun, and
//   must never touch the newer send's turn, button, or error state
// - createStopTurnEffects + createTtsOwnershipController composed with the
//   REAL streaming turn, streaming TTS session, playback controller, legacy
//   group queue, and Hands-Free controller: Stop during streaming playback
//   (SPEAKING -> LISTENING), Stop before the first token (WAITING ->
//   LISTENING, no stuck timers/progress), Stop during legacy queue playback
//   (stale onAllDone must not fire), and idle Stop
//
// User Stop deliberately preserves the partial assistant text: the user-stop
// completion path asserts that no error effect (which would overwrite the
// bubble with "Connection error") can run for a stopped send.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    STREAMING_TURN_MODES,
    createActiveSendController,
    createResponseStartProgress,
    createSendCompletionHandler,
    createStopTurnEffects,
    createStreamingTurnState,
    createTtsOwnershipController,
} from '../../public/openparlor/app.js';
import {
    createGroupPlaybackQueue,
    createPlaybackController,
    createVoiceTurnTimer,
} from '../../public/openparlor/audio.js';
import { HANDSFREE_STATES, createHandsFreeController } from '../../public/openparlor/handsfree.js';
import {
    createFirstTokenEstimator,
    estimateResponseStartProgress,
    formatResponseStartProgress,
} from '../../public/openparlor/progress.js';
import { createStreamingTtsSession } from '../../public/openparlor/streaming-tts.js';

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

// ─── createResponseStartProgress ─────────────────────────────────────────────

function makeProgress() {
    let nowMs = 0;
    let nextInterval = 0;
    const intervals = new Map();
    const ticks = [];
    const clears = [];
    const completions = [];
    const observed = [];
    // defaultMs 4000 + observe(4000) keeps the EMA exactly at 4000 so the
    // expected labels are deterministic.
    const estimator = createFirstTokenEstimator({ storage: null, defaultMs: 4000 });
    estimator.observe(4000);
    const progress = createResponseStartProgress({
        estimator,
        now: () => nowMs,
        setIntervalFn: (fn, ms) => {
            const id = ++nextInterval;
            intervals.set(id, { fn, ms });
            return id;
        },
        clearIntervalFn: (id) => {
            clears.push(id);
            intervals.delete(id);
        },
        onTick: (label) => { ticks.push(label); },
        onCompleted: (name, bubble) => { completions.push([name, bubble]); },
    });
    const env = { ticks, clears, completions, observed, progress, liveIntervals: () => [...intervals.keys()] };
    Object.defineProperty(env, 'nowMs', {
        get: () => nowMs,
        set: (v) => { nowMs = v; },
    });
    const observeSpy = estimator.observe.bind(estimator);
    estimator.observe = (ms) => { observed.push(ms); return observeSpy(ms); };
    return env;
}
describe('createResponseStartProgress', () => {
    it('start opens a per-speaker window and tick reports the estimate on the injected clock', () => {
        const env = makeProgress();
        const msg = {};
        env.progress.start(msg, 'Ada');
        assert.equal(env.liveIntervals().length, 1, 'one tick interval armed');
        assert.equal(env.progress.isPending(msg), true);
        env.nowMs = 1500;
        env.progress.tick();
        const expected = formatResponseStartProgress(
            'Ada',
            estimateResponseStartProgress({ elapsedMs: 1500, expectedMs: 4000 }),
        );
        assert.deepEqual(env.ticks, [expected]);
    });

    it('stop clears the window and its timer exactly once; a stale tick is a no-op', () => {
        const env = makeProgress();
        const msg = {};
        env.progress.start(msg, 'Ada');
        env.progress.stop();
        assert.equal(env.liveIntervals().length, 0);
        assert.equal(env.clears.length, 1);
        assert.equal(env.progress.isPending(msg), false);
        env.nowMs = 2000;
        env.progress.tick();
        assert.equal(env.ticks.length, 0, 'a stale tick must not render');
        env.progress.stop();
        assert.equal(env.clears.length, 1, 'double stop must not double-clear');
    });

    it('stop is safe when nothing is pending', () => {
        const env = makeProgress();
        env.progress.stop();
        assert.equal(env.clears.length, 0, 'no timer was ever armed');
        assert.equal(env.liveIntervals().length, 0);
    });

    it('complete observes the elapsed wait and fires onCompleted exactly once', () => {
        const env = makeProgress();
        const msg = {};
        const bubble = {};
        env.progress.start(msg, 'Ada');
        env.nowMs = 3000;
        env.progress.complete(msg, bubble);
        assert.deepEqual(env.observed, [3000]);
        assert.deepEqual(env.completions, [['Ada', bubble]]);
        assert.equal(env.liveIntervals().length, 0);
        env.progress.complete(msg, bubble);
        assert.equal(env.observed.length, 1, 'complete is idempotent');
        assert.equal(env.completions.length, 1);
    });

    it('a stale complete from an older send is a no-op (identity guard)', () => {
        const env = makeProgress();
        const older = {};
        const newer = {};
        env.progress.start(older, 'Ada');
        env.progress.start(newer, 'Grace'); // newer send re-arms the window
        env.nowMs = 1000;
        env.progress.complete(older, {});
        assert.equal(env.observed.length, 0, 'stale send cannot fold a latency sample');
        assert.equal(env.completions.length, 0);
        assert.equal(env.progress.isPending(older), false);
        assert.equal(env.progress.isPending(newer), true, 'the newer window is untouched');
        env.progress.complete(newer, {});
        assert.equal(env.completions.length, 1);
    });

    it('setName attaches the speaker identity to a running window', () => {
        const env = makeProgress();
        const msg = {};
        env.progress.start(msg); // name unknown at send time
        env.progress.setName('Ada');
        env.nowMs = 400;
        env.progress.tick();
        const expected = formatResponseStartProgress(
            'Ada',
            estimateResponseStartProgress({ elapsedMs: 400, expectedMs: 4000 }),
        );
        assert.deepEqual(env.ticks, [expected]);
    });

    it('the estimate can never read as complete before real text arrives', () => {
        const env = makeProgress();
        const msg = {};
        env.progress.start(msg, 'Ada');
        env.nowMs = 100000;
        env.progress.tick();
        const expected = formatResponseStartProgress(
            'Ada',
            estimateResponseStartProgress({ elapsedMs: 100000, expectedMs: 4000 }),
        );
        assert.deepEqual(env.ticks, [expected]);
        assert.ok(!env.ticks[0].includes('~100%'), 'capped below 100%');
    });
});

// ─── createActiveSendController ──────────────────────────────────────────────

function makeFakeButton() {
    return {
        textContent: 'Send',
        disabled: false,
        attrs: {},
        setAttribute(key, value) { this.attrs[key] = value; },
    };
}

describe('createActiveSendController', () => {
    it('begin registers a send: the button becomes Stop and stays enabled', () => {
        const button = makeFakeButton();
        const ctrl = createActiveSendController({ button });
        const send = ctrl.begin();
        assert.equal(button.textContent, 'Stop');
        assert.equal(button.attrs['aria-label'], 'Stop generating response');
        assert.equal(button.disabled, false, 'the Stop control must remain enabled');
        assert.equal(ctrl.isSending(), true);
        assert.equal(ctrl.active, send);
        assert.ok(send.token >= 1);
        assert.equal(send.stoppedByUser, false);
        assert.equal(send.abortController.signal.aborted, false);
    });

    it('stopUser marks the send BEFORE teardown and abort, then returns to idle', () => {
        const button = makeFakeButton();
        const seen = [];
        const ctrl = createActiveSendController({
            button,
            onStop: (send) => {
                seen.push({
                    marked: send.stoppedByUser,
                    aborted: send.abortController.signal.aborted,
                    stillActive: ctrl.active === send,
                });
            },
        });
        const send = ctrl.begin();
        const result = ctrl.stopUser();
        assert.equal(result, send);
        assert.deepEqual(seen, [{ marked: true, aborted: false, stillActive: true }],
            'mark -> teardown (while still active, pre-abort) order');
        assert.equal(send.abortController.signal.aborted, true);
        assert.equal(button.textContent, 'Send');
        assert.equal(button.attrs['aria-label'], 'Send message');
        assert.equal(button.disabled, false);
        assert.equal(ctrl.isSending(), false);
        assert.equal(ctrl.active, null);
    });

    it('stopUser is idempotent and safe when no turn is active', () => {
        const onStop = [];
        const ctrl = createActiveSendController({ button: makeFakeButton(), onStop: (s) => onStop.push(s) });
        const send = ctrl.begin();
        assert.equal(ctrl.stopUser(), send);
        assert.equal(ctrl.stopUser(), null, 'second Stop is a no-op');
        assert.equal(onStop.length, 1, 'teardown runs exactly once');
        assert.equal(ctrl.stopUser(), null, 'Stop with no active send is a no-op');
        assert.equal(onStop.length, 1);
    });

    it('abortExternal aborts WITHOUT marking a user stop', () => {
        const button = makeFakeButton();
        const ctrl = createActiveSendController({ button });
        const send = ctrl.begin();
        const result = ctrl.abortExternal();
        assert.equal(result, send);
        assert.equal(send.abortController.signal.aborted, true);
        assert.equal(send.stoppedByUser, false,
            'an external abort must keep the delete path\u2019s classification');
        assert.equal(button.textContent, 'Send');
        assert.equal(ctrl.isSending(), false);
        assert.equal(ctrl.abortExternal(), null);
    });

    it('settle is identity-safe: a superseded send cannot release a newer send', () => {
        const button = makeFakeButton();
        const ctrl = createActiveSendController({ button });
        const a = ctrl.begin();
        const b = ctrl.begin(); // supersedes a
        assert.equal(ctrl.settle(a), false, 'stale send cannot settle');
        assert.equal(button.textContent, 'Stop', 'the newer send keeps Stop state');
        assert.equal(ctrl.active, b);
        assert.equal(ctrl.settle(b), true);
        assert.equal(button.textContent, 'Send');
        assert.equal(ctrl.isSending(), false);
    });

    it('each send owns its AbortController; tokens are monotonic', () => {
        const ctrl = createActiveSendController({ button: makeFakeButton() });
        const a = ctrl.begin();
        a.abortController.abort();
        const b = ctrl.begin();
        assert.ok(b.token > a.token);
        assert.equal(b.abortController.signal.aborted, false,
            'aborting the old send must not abort the new one');
        assert.equal(ctrl.active, b);
    });
});

// ─── createSendCompletionHandler ─────────────────────────────────────────────

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });
const networkError = () => new Error('network down');

function makeHandler(overrides = {}) {
    const calls = { settle: [], stream: 0, userStop: [], error: [] };
    const handler = createSendCompletionHandler({
        settle: (s) => { calls.settle.push(s); return overrides.settleResult !== false; },
        onStreamException: () => { calls.stream += 1; },
        onUserStop: (s) => { calls.userStop.push(s); },
        onError: (s) => { calls.error.push(s); },
    });
    return { handler, calls };
}

describe('createSendCompletionHandler', () => {
    it('user Stop abort: no stream error, no error state, no settle', () => {
        const { handler, calls } = makeHandler();
        const send = { token: 1, stoppedByUser: true, abortController: new AbortController() };
        handler.handleCatch(send, abortError());
        assert.deepEqual(calls.userStop, [send]);
        assert.equal(calls.stream, 0, 'a user Stop must never touch the streaming turn');
        assert.equal(calls.error.length, 0, 'no error state: the partial text is preserved');
        assert.equal(calls.settle.length, 0, 'the stop path already released the identity');
    });

    it('external abort: returns quietly, nothing runs', () => {
        const { handler, calls } = makeHandler();
        const send = { token: 1, stoppedByUser: false, abortController: new AbortController() };
        handler.handleCatch(send, abortError());
        assert.equal(calls.userStop.length, 0, 'an external abort is not a user stop');
        assert.equal(calls.stream, 0, 'the delete path owns the teardown');
        assert.equal(calls.error.length, 0);
        assert.equal(calls.settle.length, 0);
    });

    it('real error while current: settles the captured turn and the error state', () => {
        const { handler, calls } = makeHandler();
        const send = { token: 1, stoppedByUser: false, abortController: new AbortController() };
        handler.handleCatch(send, networkError());
        assert.equal(calls.stream, 1, 'the captured turn must not hang (Step 2C)');
        assert.equal(calls.settle.length, 1);
        assert.deepEqual(calls.error, [send]);
    });

    it('real error while superseded: the captured turn still settles, but no error state', () => {
        const { handler, calls } = makeHandler({ settleResult: false });
        const send = { token: 1, stoppedByUser: false, abortController: new AbortController() };
        handler.handleCatch(send, networkError());
        assert.equal(calls.stream, 1);
        assert.equal(calls.error.length, 0, 'a superseded send must not render an error state');
        assert.equal(calls.userStop.length, 0);
    });

    it('non-Error throws are treated as real failures', () => {
        const { handler, calls } = makeHandler();
        const send = { token: 1, stoppedByUser: false, abortController: new AbortController() };
        handler.handleCatch(send, 'boom');
        assert.equal(calls.stream, 1);
        assert.equal(calls.error.length, 1);
    });

    it('end-to-end: a stale send\u2019s abort landing after a newer send cannot mutate it', () => {
        const button = makeFakeButton();
        const calls = { stream: 0, userStop: 0, error: 0 };
        const ctrl = createActiveSendController({ button });
        const handler = createSendCompletionHandler({
            settle: (s) => ctrl.settle(s),
            onStreamException: () => { calls.stream += 1; },
            onUserStop: () => { calls.userStop += 1; },
            onError: () => { calls.error += 1; },
        });
        const a = ctrl.begin();
        a.stoppedByUser = true; // as stopUser() marks it
        a.abortController.abort();
        const b = ctrl.begin(); // newer send starts before a\u2019s rejection lands
        assert.equal(button.textContent, 'Stop');

        handler.handleCatch(a, abortError()); // stale user-stop catch
        handler.handleFinally(a);             // stale finally

        assert.equal(calls.userStop, 1);
        assert.equal(calls.stream, 0, 'the stale abort must not touch the newer send\u2019s turn');
        assert.equal(calls.error, 0);
        assert.equal(button.textContent, 'Stop', 'the newer send keeps Stop state');
        assert.equal(ctrl.active, b);
        assert.equal(ctrl.isSending(), true);

        handler.handleFinally(b); // the newer send settles normally
        assert.equal(button.textContent, 'Send');
        assert.equal(ctrl.isSending(), false);
    });
});

// ─── Stop teardown composed with the real audio/turn/hands-free pieces ──────

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 160;
function frame(amp) {
    const samples = new Float32Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) samples[i] = amp;
    return { samples, sampleRate: SAMPLE_RATE };
}
const loudFrame = () => frame(0.1);
const silentFrame = () => frame(0.001);

function makeHandsfree() {
    const env = { sent: [], events: [] };
    const hf = createHandsFreeController({
        getConversationId: () => 'conv-1',
        getEpoch: () => 1,
        startListening: async () => {},
        stopListening: () => {},
        transcribe: async () => 'hello',
        onSendText: async (text) => { env.sent.push(text); },
        onStateChange: (state) => { env.events.push(state); },
    });
    // 20 loud frames start the utterance; 90 silent frames endpoint it.
    const talkAndStop = () => {
        for (let i = 0; i < 20; i += 1) hf.onAudioFrame(loudFrame());
        for (let i = 0; i < 90; i += 1) hf.onAudioFrame(silentFrame());
    };
    return { hf, env, talkAndStop };
}

function makeFakeAudio(registry) {
    const audio = {
        src: '',
        played: false,
        paused: false,
        endedHandler: null,
        addEventListener(type, fn) { if (type === 'ended') audio.endedHandler = fn; },
        play() { audio.played = true; return Promise.resolve(); },
        pause() { audio.paused = true; },
        fireEnded() {
            const handler = audio.endedHandler;
            audio.endedHandler = null;
            if (handler) handler();
        },
    };
    registry.push(audio);
    return audio;
}

function makeFakeSynthesize() {
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
    return { synthesize, flights };
}
function makeComposition({ handsfree: hf = null, playItem = null } = {}) {
    const calls = {
        firstAudio: 0,
        settled: [],
        onAllDone: 0,
        refreshButtons: 0,
        stopProgress: 0,
    };
    const audios = [];
    const revoked = [];
    let urlSeq = 0;
    const playback = createPlaybackController({
        createObjectURL: () => 'blob:fake-' + (++urlSeq),
        revokeObjectURL: (url) => { revoked.push(url); },
        audioFactory: (url) => Object.assign(makeFakeAudio(audios), { src: url }),
    });
    const synth = makeFakeSynthesize();
    const groupQueue = createGroupPlaybackQueue({
        playItem: playItem || (async () => {}),
        onAllDone: () => { calls.onAllDone += 1; },
    });
    const timer = createVoiceTurnTimer();
    let turn = null;
    turn = createStreamingTurnState({
        isCurrent: () => true,
        isEligible: () => true,
        resolveVoice: () => 'voice-a',
        createSession: (hooks) => createStreamingTtsSession({
            synthesize: synth.synthesize,
            playback,
            onFirstAudioStart: hooks.onFirstAudioStart,
            onTurnEnd: hooks.onTurnEnd,
        }),
        onFirstAudio: () => {
            calls.firstAudio += 1;
            if (hf) hf.markSpeakingStart();
        },
        onTurnSettled: (state, result) => {
            calls.settled.push({ firstAudioStarted: state.firstAudioStarted, result });
            if (hf) {
                if (state.firstAudioStarted) hf.markSpeakingEnd();
                else hf.markResponseComplete();
            }
        },
    });
    const ttsOwnership = createTtsOwnershipController({
        cancelStreamingTurn: (reason) => { turn.cancel(reason); },
        groupQueue,
        playback,
        timer,
        markSpeakingEnd: () => { if (hf) hf.markSpeakingEnd(); },
        refreshButtons: () => { calls.refreshButtons += 1; },
    });
    const stopTurn = createStopTurnEffects({
        stopActiveTts: (reason, options) => ttsOwnership.stopActiveTts(reason, options),
        getHandsfree: () => hf,
        stopProgress: () => { calls.stopProgress += 1; },
    });
    return { turn, playback, groupQueue, timer, calls, stopTurn, synth, audios, revoked };
}

describe('user Stop teardown (composed with the real pieces)', () => {
    it('stops streaming playback: session settles once, audio stops, SPEAKING settles to LISTENING', async () => {
        const { hf, env, talkAndStop } = makeHandsfree();
        await hf.enable();
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING);
        talkAndStop();
        await flush();
        assert.equal(hf.state, HANDSFREE_STATES.WAITING, 'the turn is in flight, awaiting first token');
        assert.deepEqual(env.sent, ['hello']);

        const comp = makeComposition({ handsfree: hf });
        comp.timer.start();
        comp.turn.onSpeakerStart('char-1');
        comp.turn.onDelta('Hello there. How are you today?');
        assert.equal(comp.synth.flights.length, 1, 'the first sentence is synthesizing');
        comp.synth.flights[0].resolve(new Blob(['x']));
        await flush();

        assert.equal(comp.calls.firstAudio, 1, 'real audio started');
        assert.equal(hf.state, HANDSFREE_STATES.SPEAKING);
        assert.equal(comp.playback.isPlaying, true);
        assert.equal(comp.turn.mode, STREAMING_TURN_MODES.STREAMING);
        assert.equal(comp.audios.length, 1);

        comp.stopTurn(); // the user-Stop effects (run before the abort fires)

        assert.equal(comp.turn.mode, STREAMING_TURN_MODES.STOPPED, 'the streaming owner is terminal');
        assert.equal(comp.calls.settled.length, 1, 'the turn settles exactly once');
        assert.equal(comp.calls.settled[0].firstAudioStarted, true);
        assert.equal(comp.calls.settled[0].result.stopped, true);
        assert.equal(comp.calls.settled[0].result.reason, 'user-stop');
        assert.equal(comp.playback.isPlaying, false);
        assert.equal(comp.audios[0].paused, true, 'the playing audio is paused');
        assert.equal(comp.revoked.length, 1, 'the object URL is released');
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING, 'SPEAKING settles to LISTENING');
        assert.equal(comp.timer.active, false, 'the per-turn timer is cancelled');
        assert.equal(comp.calls.stopProgress, 1, 'the response-start window is cancelled');
        assert.equal(comp.calls.refreshButtons, 1);

        // Stale input and late async work after Stop must be inert.
        comp.turn.onDelta('More text. Even more text.');
        comp.turn.onSpeakerStart('char-2');
        comp.turn.onSpeakerEnd();
        await flush();
        assert.equal(comp.synth.flights.length, 1, 'no synthesis restarts after Stop');
        assert.equal(comp.audios.length, 1, 'no new audio starts after Stop');
        assert.equal(comp.calls.firstAudio, 1);
        assert.equal(comp.calls.settled.length, 1, 'no double settle');
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING);
    });

    it('stops an undecided turn before the first token: WAITING settles to LISTENING, no stuck timers', async () => {
        const { hf, env, talkAndStop } = makeHandsfree();
        await hf.enable();
        talkAndStop();
        await flush();
        assert.equal(hf.state, HANDSFREE_STATES.WAITING);

        const comp = makeComposition({ handsfree: hf });
        comp.timer.start();
        comp.stopTurn(); // Stop pressed before any speaker_start

        assert.equal(comp.turn.mode, STREAMING_TURN_MODES.STOPPED);
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING, 'WAITING settles to LISTENING');
        assert.equal(comp.calls.settled.length, 0,
            'an undecided cancel has no app-level settle; the stop effect owns the settle');
        assert.equal(comp.calls.stopProgress, 1);
        assert.equal(comp.timer.active, false);
        // The last two transitions after the send began: WAITING, then the
        // stop effect's settle to LISTENING (no stuck WAITING state).
        assert.deepEqual(env.events.slice(-2), [HANDSFREE_STATES.WAITING, HANDSFREE_STATES.LISTENING]);
    });

    it('stops streaming synthesis before the first audio: the flight is aborted, nothing plays', async () => {
        const { hf, talkAndStop } = makeHandsfree();
        await hf.enable();
        talkAndStop();
        await flush();
        assert.equal(hf.state, HANDSFREE_STATES.WAITING);

        const comp = makeComposition({ handsfree: hf });
        comp.turn.onSpeakerStart('char-1');
        // The splitter emits a sentence only when a terminator is followed by
        // more text; a second sentence is needed to flush the first.
        comp.turn.onDelta('A very long sentence that is still being synthesized. Another one follows after this.');
        assert.equal(comp.synth.flights.length, 1);
        assert.equal(comp.calls.firstAudio, 0);
        assert.equal(comp.audios.length, 0);
        assert.equal(hf.state, HANDSFREE_STATES.WAITING);

        comp.stopTurn();

        assert.equal(comp.turn.mode, STREAMING_TURN_MODES.STOPPED);
        assert.equal(comp.synth.flights[0].signal.aborted, true, 'the in-flight synthesis is aborted');
        assert.equal(comp.audios.length, 0, 'no audio ever started');
        assert.equal(comp.calls.firstAudio, 0);
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING, 'no first audio, so WAITING settles');
        assert.equal(comp.calls.settled.length, 1);
        assert.equal(comp.calls.settled[0].firstAudioStarted, false);
        assert.equal(comp.calls.settled[0].result.stopped, true);
        assert.equal(comp.calls.stopProgress, 1);

        comp.turn.onDelta('Another sentence.');
        await flush();
        assert.equal(comp.audios.length, 0, 'stale input after Stop is inert');
        assert.equal(comp.calls.settled.length, 1);
    });

    it('stops legacy queue playback: pending items die, stale onAllDone never fires', async () => {
        const { hf } = makeHandsfree();
        await hf.enable();

        let releasePlayItem = null;
        const comp = makeComposition({
            handsfree: hf,
            playItem: () => new Promise((resolve) => { releasePlayItem = resolve; }),
        });
        comp.groupQueue.enqueue('First line.', 'voice-a');
        comp.groupQueue.enqueue('Second line.', 'voice-a');
        const all = comp.groupQueue.playAll();
        await flush();
        assert.equal(comp.groupQueue.isPlaying, true);
        assert.equal(comp.groupQueue.pending, 1, 'the second item is still queued');
        hf.markSpeakingStart(); // the app marks the legacy speaking phase
        assert.equal(hf.state, HANDSFREE_STATES.SPEAKING);

        comp.stopTurn();

        assert.equal(hf.state, HANDSFREE_STATES.LISTENING, 'the legacy speaking phase ends');
        assert.equal(comp.calls.onAllDone, 0);
        assert.equal(comp.calls.stopProgress, 1);

        releasePlayItem(); // the invalidated loop wakes up
        await all;
        await flush();
        assert.equal(comp.calls.onAllDone, 0, 'the stale queue loop must not complete the turn');
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING, 'no stale markSpeakingEnd');
        assert.equal(comp.groupQueue.isPlaying, false);
    });

    it('is safe when idle (no Hands-Free, no turn) and when Hands-Free is merely listening', async () => {
        const comp = makeComposition();
        comp.stopTurn();
        assert.equal(comp.calls.stopProgress, 1);
        assert.equal(comp.calls.refreshButtons, 1);
        assert.equal(comp.turn.mode, STREAMING_TURN_MODES.STOPPED);
        assert.equal(comp.playback.isPlaying, false);

        const { hf } = makeHandsfree();
        await hf.enable();
        const comp2 = makeComposition({ handsfree: hf });
        comp2.stopTurn();
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING, 'LISTENING is untouched');
        assert.equal(comp2.calls.stopProgress, 1);
    });
});
