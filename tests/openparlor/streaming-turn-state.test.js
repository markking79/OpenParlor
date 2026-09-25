/**
 * VOICE-002 Step 2C: per-turn streaming TTS state machine tests.
 *
 * Covers the createStreamingTurnState contract from the Step 2C
 * specification: the exactly-once streaming/legacy decision at the first
 * eligible speaker_start, no second session, no restart after error/done/
 * toggle/failure, no legacy TTS after any streamed sentence, the zero-work
 * legacy handoff, identity-safe cancellation (voice leakage prevention on
 * switch/delete/new/send), stale callback safety, Hands-Free settle timing,
 * speaker_end routing, and the missing-done stream-error cleanup.
 *
 * The session factory and all app-level effects (identity, eligibility,
 * voice resolution, first-audio, settle) are injected fakes, so every
 * interleaving is deterministic. The module under test is the exported pure
 * helper in app.js, which Node can import because the browser bootstrap is
 * guarded by a document check.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { STREAMING_TURN_MODES, createStreamingTurnState } from '../../public/openparlor/app.js';

/**
 * Deterministic session factory fake. Records every interaction and lets the
 * test fire the session's hooks (first audio, natural end, failure) to
 * simulate the real session's async settlement points. cancel() settles
 * exactly once with stopped: true, mirroring createStreamingTtsSession.
 * @returns {{
 *   sessions: Array<object>,
 *   createSession: (hooks: { onFirstAudioStart: () => void, onTurnEnd: (r: object) => void }) => object,
 * }}
 */
function createFakeSessions() {
    const sessions = [];

    function createSession(hooks) {
        const session = {
            hooks,
            voices: [],
            fed: [],
            endCount: 0,
            finishCount: 0,
            sentenceCount: 0,
            firstAudioFired: false,
            cancelled: null,
            inputClosed: false,
            settled: false,
            handoffCalled: 0,
            handoffResult: true,
            startSpeaker: (voice) => {
                if (session.settled || session.inputClosed) return;
                session.voices.push(voice);
            },
            feed: (text) => {
                if (session.settled || session.inputClosed) return;
                session.fed.push(text);
            },
            endSpeaker: () => {
                if (session.settled || session.inputClosed) return;
                session.endCount += 1;
            },
            finishInput: () => {
                session.finishCount += 1;
                if (!session.settled) session.inputClosed = true;
                return { sentenceCount: session.sentenceCount, firstAudioStarted: session.firstAudioFired };
            },
            cancel: (reason) => {
                if (session.settled) return;
                session.settled = true;
                session.cancelled = reason;
                hooks.onTurnEnd({ ok: false, stopped: true, reason });
            },
            handoffToLegacy: () => {
                session.handoffCalled += 1;
                if (session.handoffResult && !session.settled) session.settled = true;
                return session.handoffResult;
            },
            fireFirstAudio() {
                if (session.firstAudioFired) return;
                session.firstAudioFired = true;
                hooks.onFirstAudioStart();
            },
            fireNaturalEnd() {
                hooks.onTurnEnd({ ok: true, stopped: false });
            },
            fireFailure() {
                hooks.onTurnEnd({ ok: false, stopped: false, error: new Error('synthesis failed') });
            },
        };
        sessions.push(session);
        return session;
    }

    return { sessions, createSession };
}

/**
 * App-level effect recorder plus dependency factory. `current` is mutated by
 * tests to simulate identity changes (conversation switch/delete/new) and
 * eligibility changes (toggle off, recording, stream error).
 * @param {{ current: boolean, eligible: boolean, voices?: Record<string, string> }} current
 * @returns {{ effects: Array<unknown>, current: object, deps: () => object }}
 */
function createAppDeps(current) {
    const effects = [];
    const voices = Object.assign({ c1: 'voice-a', c2: 'voice-b' }, current.voices || {});
    delete current.voices;
    return {
        effects,
        current,
        deps: () => ({
            isCurrent: () => current.current,
            isEligible: () => current.eligible
                && !current.recording
                && !current.recordingInterruptionPending,
            resolveVoice: (characterId) => voices[characterId] || '',
            onFirstAudio: () => { effects.push('firstAudio'); },
            onTurnSettled: (state, result) => {
                effects.push({
                    type: 'settled',
                    firstAudioStarted: state.firstAudioStarted,
                    ok: result.ok,
                    stopped: result.stopped,
                    reason: result.reason,
                });
            },
        }),
    };
}

function settledEffects(app) {
    return app.effects.filter((e) => e && e.type === 'settled');
}
describe('createStreamingTurnState (VOICE-002 Step 2C)', () => {
    describe('decision at the first speaker_start', () => {
        test('stays undecided and routes nothing before the first speaker_start', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onDelta('hello');
            turn.onSpeakerEnd();

            assert.equal(turn.mode, STREAMING_TURN_MODES.UNDECIDED);
            assert.equal(sessions.length, 0);
            const decision = turn.onDone();
            assert.deepEqual(decision, { runLegacy: true, ttsHandled: false });
        });

        test('creates exactly one session at the first eligible speaker_start', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');

            assert.equal(turn.mode, STREAMING_TURN_MODES.STREAMING);
            assert.equal(sessions.length, 1);
            assert.deepEqual(sessions[0].voices, ['voice-a']);
        });

        test('resolves an empty voice for an unknown character', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('missing');

            assert.deepEqual(sessions[0].voices, ['']);
        });

        test('routes later speaker_start to the same session without re-deciding', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            turn.onSpeakerStart('c2');

            assert.equal(sessions.length, 1, 'no second session');
            assert.deepEqual(sessions[0].voices, ['voice-a', 'voice-b']);
            assert.equal(turn.mode, STREAMING_TURN_MODES.STREAMING);
        });

        test('later speaker_start does not re-check eligibility', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            app.current.eligible = false; // toggled off mid-turn
            turn.onSpeakerStart('c2');

            assert.equal(sessions.length, 1);
            assert.deepEqual(sessions[0].voices, ['voice-a', 'voice-b']);
        });

        test('falls to legacy when ineligible at the first speaker_start', () => {
            const app = createAppDeps({ current: true, eligible: false });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            turn.onSpeakerStart('c2');

            assert.equal(turn.mode, STREAMING_TURN_MODES.LEGACY);
            assert.equal(sessions.length, 0);
            assert.deepEqual(turn.onDone(), { runLegacy: true, ttsHandled: false });
        });

        test('falls to legacy when stale at the first speaker_start', () => {
            const app = createAppDeps({ current: false, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');

            assert.equal(turn.mode, STREAMING_TURN_MODES.LEGACY);
            assert.equal(sessions.length, 0);
        });

        test('does not start streaming while a recording interruption is pending', () => {
            const app = createAppDeps({ current: true, eligible: true, recordingInterruptionPending: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');

            assert.equal(turn.mode, STREAMING_TURN_MODES.LEGACY);
            assert.equal(sessions.length, 0);
        });
    });

    describe('delta and speaker_end routing', () => {
        test('feeds raw deltas only while streaming', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onDelta('before.');
            turn.onSpeakerStart('c1');
            turn.onDelta('one. two.');

            assert.deepEqual(sessions[0].fed, ['one. two.']);

            sessions[0].sentenceCount = 1;
            turn.onDone();
            turn.onDelta('after done.');
            assert.deepEqual(sessions[0].fed, ['one. two.'], 'no feed after done');
        });

        test('routes speaker_end to the session only while streaming', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerEnd();
            assert.equal(sessions.length, 0);

            turn.onSpeakerStart('c1');
            turn.onSpeakerEnd();
            assert.equal(sessions[0].endCount, 1);

            turn.cancel('toggle-off');
            turn.onSpeakerEnd();
            assert.equal(sessions[0].endCount, 1, 'no flush after cancel');
        });
    });

    describe('completion and hands-off at done', () => {
        test('forbids legacy TTS after any streamed sentence', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            sessions[0].sentenceCount = 1;
            const decision = turn.onDone();

            assert.deepEqual(decision, { runLegacy: false, ttsHandled: true });
            assert.equal(sessions[0].handoffCalled, 0);
            assert.equal(sessions[0].finishCount, 1);
            assert.equal(turn.mode, STREAMING_TURN_MODES.STREAMING,
                'still streaming: audio drains after done');
        });

        test('settles on natural completion and keeps ttsHandled on re-done', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            sessions[0].sentenceCount = 1;
            const decision = turn.onDone();
            assert.deepEqual(decision, { runLegacy: false, ttsHandled: true });

            sessions[0].fireNaturalEnd();

            assert.equal(turn.mode, STREAMING_TURN_MODES.COMPLETE);
            assert.equal(settledEffects(app).length, 1);
            assert.equal(settledEffects(app)[0].ok, true);
            assert.equal(settledEffects(app)[0].stopped, false);
            assert.deepEqual(turn.onDone(), { runLegacy: false, ttsHandled: true }, 'onDone is idempotent');
            assert.equal(sessions[0].finishCount, 1);
        });

        test('hands off a zero-work session to legacy at done', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            turn.onDelta('no terminal punctuation yet');
            const decision = turn.onDone();

            assert.equal(sessions[0].handoffCalled, 1);
            assert.deepEqual(decision, { runLegacy: true, ttsHandled: false });
            assert.equal(turn.mode, STREAMING_TURN_MODES.LEGACY);
            assert.equal(sessions[0].cancelled, null, 'handoff does not cancel the session');
            // After handoff the turn is terminal: no further streaming.
            turn.onDelta('more.');
            assert.deepEqual(sessions[0].fed, ['no terminal punctuation yet']);
            assert.deepEqual(turn.onDone(), { runLegacy: false, ttsHandled: true });
        });

        test('fails closed when a zero-work handoff is refused', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            sessions[0].handoffResult = false;
            const decision = turn.onDone();

            assert.deepEqual(decision, { runLegacy: false, ttsHandled: true });
            assert.equal(turn.mode, STREAMING_TURN_MODES.FAILED);
            assert.equal(sessions[0].cancelled, 'stream-handoff-failed');
            assert.equal(settledEffects(app).length, 1);
            assert.equal(settledEffects(app)[0].stopped, true);
            assert.equal(settledEffects(app)[0].reason, 'stream-handoff-failed');
        });

        test('a session that already produced audio can never hand off', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            sessions[0].sentenceCount = 1;
            sessions[0].firstAudioFired = true;
            const decision = turn.onDone();

            assert.equal(sessions[0].handoffCalled, 0, 'no handoff once audio was produced');
            assert.deepEqual(decision, { runLegacy: false, ttsHandled: true });
        });
    });

    describe('failure handling (no legacy fallback)', () => {
        test('settles failed when the session fails mid-stream', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            sessions[0].fireFailure();

            assert.equal(turn.mode, STREAMING_TURN_MODES.FAILED);
            assert.equal(settledEffects(app).length, 1);
            assert.equal(settledEffects(app)[0].ok, false);
            assert.equal(settledEffects(app)[0].stopped, false);

            // A late done record must never run the legacy path.
            assert.deepEqual(turn.onDone(), { runLegacy: false, ttsHandled: true });
            turn.onSpeakerStart('c2');
            assert.equal(sessions.length, 1, 'no restart after failure');
        });

        test('onStreamError cancels an open streaming session and settles', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            turn.onStreamError('stream-ended');

            assert.equal(sessions[0].cancelled, 'stream-ended');
            assert.equal(turn.mode, STREAMING_TURN_MODES.FAILED);
            assert.equal(settledEffects(app).length, 1);
            assert.equal(settledEffects(app)[0].stopped, true);
            assert.equal(settledEffects(app)[0].reason, 'stream-ended');
            assert.deepEqual(turn.onDone(), { runLegacy: false, ttsHandled: true });
        });

        test('onStreamError prevents any restart for the rest of the turn', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            turn.onStreamError('stream-error');
            turn.onSpeakerStart('c2');
            turn.onDelta('more.');

            assert.equal(sessions.length, 1);
            assert.deepEqual(sessions[0].fed, []);
            assert.equal(sessions[0].cancelled, 'stream-error');
        });

        test('onStreamError is a no-op outside streaming mode', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onStreamError('early');
            assert.equal(turn.mode, STREAMING_TURN_MODES.UNDECIDED);
            assert.equal(sessions.length, 0);
            assert.equal(app.effects.length, 0);

            turn.onSpeakerStart('c1');
            turn.cancel('toggle');
            turn.onStreamError('late');
            assert.equal(settledEffects(app).length, 1, 'no double settle');
        });
    });

    describe('cancellation and voice leakage prevention', () => {
        test('cancel while streaming settles with the stop reason', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            turn.cancel('conversation-switch');

            assert.equal(sessions[0].cancelled, 'conversation-switch');
            assert.equal(turn.mode, STREAMING_TURN_MODES.STOPPED);
            assert.equal(settledEffects(app).length, 1);
            assert.equal(settledEffects(app)[0].stopped, true);
            assert.equal(settledEffects(app)[0].reason, 'conversation-switch');
            assert.equal(settledEffects(app)[0].firstAudioStarted, false);

            // Terminal: no restart, no legacy, no double settle.
            turn.onSpeakerStart('c2');
            assert.equal(sessions.length, 1);
            assert.deepEqual(turn.onDone(), { runLegacy: false, ttsHandled: true });
            assert.equal(settledEffects(app).length, 1);
        });

        test('cancel reports first audio to the settle effect (Hands-Free timing)', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            sessions[0].fireFirstAudio();
            assert.deepEqual(app.effects, ['firstAudio']);
            assert.equal(turn.firstAudioStarted, true);

            turn.cancel('new-conversation');

            const settled = settledEffects(app);
            assert.equal(settled.length, 1);
            assert.equal(settled[0].firstAudioStarted, true,
                'app calls markSpeakingEnd, not markResponseComplete');
        });

        test('cancel with a stale identity settles no app effects', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            app.current.current = false; // conversation switched
            turn.cancel('conversation-switch');

            assert.equal(sessions[0].cancelled, 'conversation-switch', 'audio still stops');
            assert.equal(turn.mode, STREAMING_TURN_MODES.STOPPED);
            assert.equal(app.effects.length, 0, 'no effects on the new conversation');
        });

        test('cancel in undecided or legacy mode is silent', () => {
            const app = createAppDeps({ current: true, eligible: false });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1'); // legacy (ineligible)
            turn.cancel('auto-speak-disabled');
            assert.equal(turn.mode, STREAMING_TURN_MODES.STOPPED);
            assert.equal(app.effects.length, 0);
            assert.equal(sessions.length, 0);
            assert.deepEqual(turn.onDone(), { runLegacy: false, ttsHandled: true });

            const app2 = createAppDeps({ current: true, eligible: true });
            const turn2 = createStreamingTurnState(Object.assign(app2.deps(), { createSession }));
            turn2.cancel('conversation-deleted');
            assert.equal(turn2.mode, STREAMING_TURN_MODES.STOPPED);
            assert.equal(app2.effects.length, 0);
        });

        test('cancel is idempotent', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            turn.cancel('playback-stop');
            turn.cancel('playback-stop');

            assert.equal(settledEffects(app).length, 1);
            assert.equal(sessions[0].cancelled, 'playback-stop');
        });

        test('exposes the streaming mode so a new send can supersede it', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            // The app's pre-send guard: if (turn.mode === STREAMING) cancel.
            assert.equal(turn.mode, STREAMING_TURN_MODES.STREAMING);
            if (turn.mode === STREAMING_TURN_MODES.STREAMING) {
                turn.cancel('superseded-send');
            }
            assert.equal(sessions[0].cancelled, 'superseded-send');
            assert.equal(turn.mode, STREAMING_TURN_MODES.STOPPED);

            // A settled (non-streaming) previous turn is not superseded.
            const app2 = createAppDeps({ current: true, eligible: true });
            const turn2 = createStreamingTurnState(Object.assign(app2.deps(), { createSession }));
            turn2.onSpeakerStart('c1');
            turn2.cancel('done');
            assert.notEqual(turn2.mode, STREAMING_TURN_MODES.STREAMING);
        });
    });

    describe('stale callback safety', () => {
        test('ignores a late onTurnEnd from a cancelled session', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            turn.cancel('voice-mode-disabled');
            const settledBefore = settledEffects(app).length;

            // Simulate a stale async settlement from the old generation.
            sessions[0].hooks.onTurnEnd({ ok: true, stopped: false });

            assert.equal(settledEffects(app).length, settledBefore);
            assert.equal(turn.mode, STREAMING_TURN_MODES.STOPPED);
        });

        test('ignores a late first-audio callback from a cancelled session', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            turn.cancel('recording-start');

            sessions[0].hooks.onFirstAudioStart();

            assert.equal(app.effects.filter((e) => e === 'firstAudio').length, 0);
            assert.equal(turn.firstAudioStarted, false);
        });

        test('ignores callbacks after the identity goes stale mid-turn', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            app.current.current = false;
            sessions[0].fireFirstAudio();
            sessions[0].fireNaturalEnd();

            assert.equal(app.effects.length, 0);
            assert.equal(turn.firstAudioStarted, false);
        });

        test('fires the first-audio effect exactly once', () => {
            const app = createAppDeps({ current: true, eligible: true });
            const { sessions, createSession } = createFakeSessions();
            const turn = createStreamingTurnState(Object.assign(app.deps(), { createSession }));

            turn.onSpeakerStart('c1');
            sessions[0].fireFirstAudio();
            sessions[0].fireFirstAudio();

            assert.equal(app.effects.filter((e) => e === 'firstAudio').length, 1);
            assert.equal(turn.firstAudioStarted, true);
        });
    });
});
