/**
 * VOICE-002 Step 2B: streaming TTS coordinator tests.
 *
 * Covers the createStreamingTtsSession contract from the Step 2
 * specification: basic sentence enqueueing, speaker voice identity, the
 * mandatory deterministic synthesis/playback overlap timeline, the bounded
 * one-item look-ahead, cancellation races, failure handling, and the
 * zero-work legacy handoff firewall.
 *
 * The synthesize transport and the playback controller are injected fakes
 * whose promises and onEnded callbacks the tests drive manually, so every
 * interleaving is deterministic. A few tests use the real
 * createPlaybackController to prove the session works against the real
 * playBlob contract.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamingTtsSession } from '../../public/openparlor/streaming-tts.js';
import { createPlaybackController } from '../../public/openparlor/audio.js';

/**
 * Flushes enough microtask ticks for the coordinator's promise chains
 * (synthesize settle -> ready -> playBlob start -> firstAudioStart) to
 * drain. The module itself uses no timers.
 * @returns {Promise<void>}
 */
async function flushMicrotasks() {
    for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
    }
}

/**
 * Deterministic synthesize fake: each request records its arguments and the
 * test resolves/rejects it manually. Tracks in-flight concurrency.
 * @returns {{
 *   synth: (req: { text: string, voice: string, signal: AbortSignal }) => Promise<Blob>,
 *   requests: Array<{ text: string, voice: string, signal: AbortSignal, resolve: (b: Blob) => void, reject: (e: unknown) => void }>,
 *   inFlight: number,
 *   maxInFlight: number,
 * }}
 */
function createManualSynth() {
    const requests = [];
    let inFlight = 0;
    let maxInFlight = 0;

    function synth({ text, voice, signal }) {
        const request = {
            text: text,
            voice: voice,
            signal: signal,
            settled: false,
        };
        requests.push(request);
        return new Promise((resolve, reject) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            request.resolve = (blob) => {
                if (request.settled) return;
                request.settled = true;
                inFlight -= 1;
                resolve(blob);
            };
            request.reject = (error) => {
                if (request.settled) return;
                request.settled = true;
                inFlight -= 1;
                reject(error);
            };
        });
    }

    return {
        synth: synth,
        requests: requests,
        get inFlight() { return inFlight; },
        get maxInFlight() { return maxInFlight; },
    };
}

/**
 * Deterministic playback fake mirroring the createPlaybackController
 * contract: playBlob records the call, resolves the start on a microtask,
 * and the armed onEnded fires exactly once (natural endPlay or stop()).
 * stop() fires the currently armed callback, like the real controller.
 * @returns {{
 *   playBlob: (blob: Blob, onEnded?: () => void) => Promise<void>,
 *   stop: () => void,
 *   endPlay: (play: object) => void,
 *   plays: Array<{ index: number, blob: Blob, onEnded: (() => void) | null, started: boolean, ended: boolean }>,
 *   startedSeq: () => number[],
 *   stopCalls: number,
 *   maxActive: number,
 * }}
 */
function createManualPlayback() {
    const plays = [];
    let activeCount = 0;
    let maxActive = 0;
    let armedOnEnded = null;
    let stopCalls = 0;

    function playBlob(blob, onEnded) {
        const play = {
            index: plays.length,
            blob: blob,
            onEnded: typeof onEnded === 'function' ? onEnded : null,
            started: false,
            ended: false,
        };
        plays.push(play);
        armedOnEnded = play.onEnded;
        return Promise.resolve().then(() => {
            if (play.ended) return;
            play.started = true;
            activeCount += 1;
            maxActive = Math.max(maxActive, activeCount);
        });
    }

    function endPlay(play) {
        if (play.ended) return;
        play.ended = true;
        if (armedOnEnded === play.onEnded) {
            armedOnEnded = null;
        }
        if (play.started) {
            activeCount -= 1;
        }
        if (play.onEnded) {
            play.onEnded();
        }
    }

    function stop() {
        stopCalls += 1;
        if (!armedOnEnded) return;
        const play = plays.find((p) => p.onEnded === armedOnEnded);
        armedOnEnded = null;
        if (play) {
            endPlay(play);
        }
    }

    return {
        playBlob: playBlob,
        stop: stop,
        endPlay: endPlay,
        plays: plays,
        startedSeq: () => plays.filter((p) => p.started).map((p) => p.index),
        get stopCalls() { return stopCalls; },
        get maxActive() { return maxActive; },
    };
}

/**
 * Wires a session to manual fakes and records callback invocations.
 * @param {{
 *   synthesize?: (req: { text: string, voice: string, signal: AbortSignal }) => Promise<Blob>,
 *   playback?: object,
 *   maxReadyAhead?: number,
 * }} [options]
 * @returns {{
 *   session: object,
 *   synth: object,
 *   playback: object,
 *   firstStarts: number[],
 *   turnEnds: object[],
 * }}
 */
function createHarness(options = {}) {
    const synth = createManualSynth();
    const playback = options.playback || createManualPlayback();
    const firstStarts = [];
    const turnEnds = [];
    const session = createStreamingTtsSession({
        synthesize: options.synthesize || synth.synth,
        playback: playback,
        onFirstAudioStart: () => { firstStarts.push(1); },
        onTurnEnd: (result) => { turnEnds.push(result); },
        maxReadyAhead: options.maxReadyAhead,
    });
    return { session: session, synth: synth, playback: playback, firstStarts: firstStarts, turnEnds: turnEnds };
}

/**
 * Mock Audio supporting addEventListener/emit, matching the pattern used by
 * the createPlaybackController tests.
 * @returns {object}
 */
function makeEventMockAudio() {
    const listeners = {};
    return {
        src: '',
        played: false,
        paused: false,
        async play() { this.played = true; },
        pause() { this.paused = true; },
        addEventListener(type, fn) {
            if (!listeners[type]) {
                listeners[type] = [];
            }
            listeners[type].push(fn);
        },
        emit(type) {
            for (const fn of listeners[type] || []) {
                fn();
            }
        },
    };
}

/**
 * Real createPlaybackController wired to mock URL/Audio factories.
 * @returns {{ controller: object, audios: object[] }}
 */
function makeRealPlaybackController() {
    const audios = [];
    let urlCounter = 0;
    const controller = createPlaybackController({
        createObjectURL: () => {
            urlCounter += 1;
            return `blob:st-${urlCounter}`;
        },
        revokeObjectURL: () => {},
        audioFactory: (url) => {
            const audio = makeEventMockAudio();
            audio.src = url;
            audios.push(audio);
            return audio;
        },
    });
    return { controller: controller, audios: audios };
}


describe('createStreamingTtsSession basics', () => {
    test('first complete sentence creates exactly one synthesis request', async () => {
        const { session, synth } = createHarness();
        session.startSpeaker('af_heart');
        session.feed('Hello world.');
        // The trailing period is not confirmed until following whitespace.
        assert.equal(synth.requests.length, 0);
        session.feed(' More.');
        assert.equal(synth.requests.length, 1, 'one request for the first complete sentence');
        assert.equal(synth.requests[0].text, 'Hello world.');
    });

    test('synthesis request carries the sentence text and speaker voice', async () => {
        const { session, synth } = createHarness();
        session.startSpeaker('am_adam');
        session.feed('First line. Second line. ');
        assert.equal(synth.requests.length, 1);
        assert.equal(synth.requests[0].text, 'First line.');
        assert.equal(synth.requests[0].voice, 'am_adam');
    });

    test('finishInput flushes the unterminated tail', async () => {
        const { session, synth } = createHarness();
        session.startSpeaker('v');
        session.feed('The end');
        assert.equal(synth.requests.length, 0);
        session.finishInput();
        assert.equal(synth.requests.length, 1);
        assert.equal(synth.requests[0].text, 'The end');
    });

    test('finishInput is idempotent', async () => {
        const { session, synth, turnEnds } = createHarness();
        session.startSpeaker('v');
        session.feed('One. ');
        const first = session.finishInput();
        const second = session.finishInput();
        assert.deepEqual(first, { sentenceCount: 1, firstAudioStarted: false });
        assert.deepEqual(second, first);
        assert.equal(synth.requests.length, 1);
        await flushMicrotasks();
        assert.equal(turnEnds.length, 0, 'completion awaits playback, not a double finish');
    });

    test('feed after finishInput is a no-op', async () => {
        const { session, synth } = createHarness();
        session.startSpeaker('v');
        session.finishInput();
        session.feed('Late. ');
        assert.equal(synth.requests.length, 0);
        assert.equal(session.sentenceCount, 0);
    });

    test('startSpeaker and feed after cancel are no-ops', () => {
        const { session, synth } = createHarness();
        session.cancel('x');
        session.startSpeaker('v');
        session.feed('Late. ');
        assert.equal(synth.requests.length, 0);
    });

    test('endSpeaker flushes the unterminated tail immediately, before finishInput', async () => {
        const { session, synth } = createHarness();
        session.startSpeaker('v');
        session.feed('Trailing words');
        assert.equal(synth.requests.length, 0);
        session.endSpeaker();
        assert.equal(synth.requests.length, 1, 'tail synthesized at speaker_end, not at done');
        assert.equal(synth.requests[0].text, 'Trailing words');
        session.finishInput();
        assert.equal(synth.requests.length, 1, 'no duplicate tail at done');
    });

    test('speaker_end flushes the tail with the OLD voice; next speaker uses the new voice', async () => {
        const { session, synth } = createHarness();
        session.startSpeaker('af_heart');
        session.feed('From A');
        session.startSpeaker('am_adam');
        assert.equal(synth.requests.length, 1, 'speaker A tail is enqueued and synthesized at speaker_end');
        assert.equal(synth.requests[0].text, 'From A');
        assert.equal(synth.requests[0].voice, 'af_heart', 'tail must use the OLD speaker voice');
        session.feed('From B. ');
        assert.equal(synth.requests.length, 1, 'single-flight: second sentence waits for the tail');
        synth.requests[0].resolve(new Blob(['a']));
        await flushMicrotasks();
        assert.equal(synth.requests.length, 2);
        assert.equal(synth.requests[1].text, 'From B.');
        assert.equal(synth.requests[1].voice, 'am_adam', 'next speaker uses the new voice');
    });

    test('muted speaker creates no synthesis', async () => {
        const { session, synth } = createHarness();
        session.startSpeaker('');
        session.feed('Silent. Still silent. ');
        assert.equal(synth.requests.length, 0);
        assert.equal(session.sentenceCount, 0);
        session.endSpeaker();
        assert.equal(synth.requests.length, 0, 'muted tail is not synthesized');
    });

    test('voiced speaker after a muted speaker works', async () => {
        const { session, synth } = createHarness();
        session.startSpeaker('');
        session.feed('Muted. ');
        session.startSpeaker('v2');
        session.feed('Audible. ');
        assert.equal(synth.requests.length, 1);
        assert.equal(synth.requests[0].text, 'Audible.');
        assert.equal(synth.requests[0].voice, 'v2');
    });


    test('sentenceCount is accurate across speakers and tails', async () => {
        const { session, synth } = createHarness({ maxReadyAhead: 3 });
        session.startSpeaker('v1');
        session.feed('One. Two');
        session.startSpeaker('v2');
        session.feed('Three. Four');
        session.endSpeaker();
        session.finishInput();
        assert.equal(session.sentenceCount, 4);
        assert.equal(synth.requests.length, 1, 'single-flight: only sentence 1 synthesizes first');
        // Each resolved blob frees the ready-ahead bound for one more
        // synthesis; with maxReadyAhead 3 all four requests are issued
        // after three resolutions.
        synth.requests[0].resolve(new Blob(['1']));
        await flushMicrotasks();
        assert.equal(synth.requests.length, 2);
        synth.requests[1].resolve(new Blob(['2']));
        await flushMicrotasks();
        assert.equal(synth.requests.length, 3);
        synth.requests[2].resolve(new Blob(['3']));
        await flushMicrotasks();
        assert.equal(synth.requests.length, 4);
        assert.deepEqual(synth.requests.map((r) => [r.text, r.voice]), [
            ['One.', 'v1'],
            ['Two', 'v1'],
            ['Three.', 'v2'],
            ['Four', 'v2'],
        ]);
    });

    test('natural completion calls onTurnEnd exactly once with ok', async () => {
        const { session, synth, playback, turnEnds, firstStarts } = createHarness();
        session.startSpeaker('v');
        session.feed('One. Two. ');
        session.finishInput();
        synth.requests[0].resolve(new Blob(['1']));
        await flushMicrotasks();
        synth.requests[1].resolve(new Blob(['2']));
        await flushMicrotasks();
        playback.endPlay(playback.plays[0]);
        await flushMicrotasks();
        assert.equal(turnEnds.length, 0, 'sentence 2 is still playing');
        playback.endPlay(playback.plays[1]);
        await flushMicrotasks();
        assert.equal(turnEnds.length, 1);
        assert.equal(turnEnds[0].ok, true);
        assert.equal(turnEnds[0].stopped, false);
        assert.equal(firstStarts.length, 1);
        assert.equal(session.active, false);
        // A repeated late end must not re-settle.
        playback.plays[1].onEnded();
        await flushMicrotasks();
        assert.equal(turnEnds.length, 1);
    });

    test('cancel twice calls onTurnEnd once', () => {
        const { session, turnEnds } = createHarness();
        session.cancel('user-stop');
        assert.equal(turnEnds.length, 1);
        assert.deepEqual(turnEnds[0], { ok: false, stopped: true, reason: 'user-stop' });
        session.cancel('again');
        assert.equal(turnEnds.length, 1, 'cancel is idempotent');
        assert.equal(session.active, false);
    });

    test('an empty pipeline is not completion while input is still open', async () => {
        const { session, synth, playback, turnEnds } = createHarness();
        session.startSpeaker('v');
        session.feed('One. ');
        synth.requests[0].resolve(new Blob(['1']));
        await flushMicrotasks();
        playback.endPlay(playback.plays[0]);
        await flushMicrotasks();
        assert.equal(turnEnds.length, 0, 'the LLM may simply be between sentences');
        assert.equal(session.active, true);
        session.finishInput();
        await flushMicrotasks();
        assert.equal(turnEnds.length, 1);
        assert.equal(turnEnds[0].ok, true);
    });

    test('input closed with zero streamable sentences awaits handoff without settling', async () => {
        const { session, turnEnds } = createHarness();
        session.startSpeaker('');
        session.feed('Nothing. ');
        session.finishInput();
        await flushMicrotasks();
        assert.equal(turnEnds.length, 0, 'a zero-sentence turn must not self-settle (spec 17)');
        assert.equal(session.active, true, 'session stays open for the handoff decision');
        assert.equal(session.sentenceCount, 0);
        assert.equal(session.handoffToLegacy(), true, 'zero work: handoff to legacy allowed');
        assert.equal(session.active, false, 'successful handoff settles silently');
        assert.equal(turnEnds.length, 0, 'handoff never fires onTurnEnd');
    });
});


describe('mandatory deterministic overlap (spec section 34)', () => {
    test('synthesis of sentence 2 overlaps playback of sentence 1, in exact order', async () => {
        const { session, synth, playback, firstStarts, turnEnds } = createHarness();
        const blobOne = new Blob(['one']);
        const blobTwo = new Blob(['two']);

        session.startSpeaker('af_heart');
        session.feed('First. Second. ');

        // A. synthesis 1 starts
        assert.equal(synth.requests.length, 1, 'A: synthesis 1 in flight');
        assert.equal(synth.requests[0].text, 'First.');
        assert.equal(synth.inFlight, 1);

        // B. synthesis 1 completes
        synth.requests[0].resolve(blobOne);
        await flushMicrotasks();

        // C. playback 1 starts
        assert.equal(playback.plays.length, 1, 'C: playback 1 started');
        assert.equal(playback.plays[0].started, true);
        assert.equal(playback.plays[0].ended, false);
        assert.equal(playback.plays[0].blob, blobOne);

        // D. DO NOT signal playback 1 ended.
        // E. synthesis 2 starts WHILE playback 1 remains active
        assert.equal(synth.requests.length, 2, 'E: synthesis 2 started during playback 1');
        assert.equal(synth.requests[1].text, 'Second.');
        assert.equal(synth.inFlight, 1);
        assert.equal(playback.plays[0].ended, false, 'playback 1 still active');
        assert.equal(session.firstAudioStarted, true);

        // F. synthesis 2 completes
        synth.requests[1].resolve(blobTwo);
        await flushMicrotasks();

        // G. playback 2 has NOT started yet
        assert.equal(playback.plays.length, 1, 'G: playback 2 must not start before playback 1 ends');

        // H. concurrency bounds
        assert.equal(synth.maxInFlight, 1, 'H: max synthesis concurrency == 1');
        assert.equal(playback.maxActive, 1, 'H: max playback concurrency == 1');

        // I. signal playback 1 ended
        playback.endPlay(playback.plays[0]);
        await flushMicrotasks();

        // J. playback 2 now starts
        assert.equal(playback.plays.length, 2, 'J: playback 2 started after playback 1 ended');
        assert.equal(playback.plays[1].started, true);
        assert.equal(playback.plays[1].blob, blobTwo);

        // K. signal playback 2 ended
        playback.endPlay(playback.plays[1]);
        await flushMicrotasks();

        // L. finish input / complete turn
        const summary = session.finishInput();
        await flushMicrotasks();

        // M. exact playback order and completion
        assert.deepEqual(summary, { sentenceCount: 2, firstAudioStarted: true });
        assert.deepEqual(playback.startedSeq(), [0, 1], 'M: exact playback order is sentence 1, sentence 2');
        assert.equal(turnEnds.length, 1);
        assert.equal(turnEnds[0].ok, true);
        assert.equal(turnEnds[0].stopped, false);
        assert.equal(firstStarts.length, 1, 'onFirstAudioStart fired exactly once');
        assert.equal(session.active, false);
    });

    test('one-item lookahead: sentence 3 stays pending until sentence 2 plays', async () => {
        const { session, synth, playback, turnEnds } = createHarness();

        session.startSpeaker('af_heart');
        session.feed('One. Two. Three. ');
        assert.equal(synth.requests.length, 1, 'sentence 1 synthesizes first');
        assert.equal(synth.requests[0].text, 'One.');

        synth.requests[0].resolve(new Blob(['one']));
        await flushMicrotasks();
        assert.equal(playback.plays.length, 1, 'sentence 1 plays');
        assert.equal(synth.requests.length, 2, 'sentence 2 synthesizes while sentence 1 plays');
        assert.equal(synth.requests[1].text, 'Two.');

        synth.requests[1].resolve(new Blob(['two']));
        await flushMicrotasks();
        assert.equal(playback.plays.length, 1, 'sentence 2 waits ready; must not play yet');
        assert.equal(synth.requests.length, 2, 'sentence 3 must NOT synthesize while a blob waits ready');

        // sentence 1 ends -> sentence 2 moves ready -> playing -> sentence 3 may start
        playback.endPlay(playback.plays[0]);
        await flushMicrotasks();
        assert.equal(playback.plays.length, 2);
        assert.equal(playback.plays[1].started, true, 'sentence 2 now plays');
        assert.equal(synth.requests.length, 3, 'sentence 3 synthesizes only after sentence 2 started playing');
        assert.equal(synth.requests[2].text, 'Three.');

        // drain to completion
        synth.requests[2].resolve(new Blob(['three']));
        await flushMicrotasks();
        assert.equal(playback.plays.length, 2, 'sentence 3 waits ready while sentence 2 plays');
        playback.endPlay(playback.plays[1]);
        await flushMicrotasks();
        assert.equal(playback.plays.length, 3, 'sentence 3 plays after sentence 2 ends');
        playback.endPlay(playback.plays[2]);
        await flushMicrotasks();
        session.finishInput();
        await flushMicrotasks();

        assert.deepEqual(playback.startedSeq(), [0, 1, 2], 'exact playback order');
        assert.equal(synth.maxInFlight, 1, 'max synthesis concurrency == 1');
        assert.equal(playback.maxActive, 1, 'max playback concurrency == 1');
        assert.equal(turnEnds.length, 1);
        assert.equal(turnEnds[0].ok, true);
        assert.equal(session.active, false);
    });
});


describe('cancellation and races (spec section 36)', () => {
    test('cancel before any input settles once with no work', () => {
        const { session, synth, playback, turnEnds } = createHarness();
        session.cancel('user-stop');
        assert.equal(turnEnds.length, 1);
        assert.deepEqual(turnEnds[0], { ok: false, stopped: true, reason: 'user-stop' });
        assert.equal(synth.requests.length, 0, 'no synthesis started');
        assert.equal(playback.stopCalls, 1, 'playback explicitly stopped');
        assert.equal(playback.plays.length, 0, 'no playback started');
        assert.equal(session.active, false);
    });

    test('cancel during synthesis aborts the signal; the late rejection is ignored', async () => {
        const { session, synth, playback, turnEnds } = createHarness();
        session.startSpeaker('v');
        session.feed('Hello. ');
        assert.equal(synth.requests.length, 1);
        session.cancel('stop');
        assert.equal(synth.requests[0].signal.aborted, true, 'in-flight synthesis aborted');
        // The transport rejects with AbortError after the abort.
        synth.requests[0].reject(new Error('aborted'));
        await flushMicrotasks();
        assert.equal(turnEnds.length, 1, 'the abort is not a second failure');
        assert.equal(turnEnds[0].stopped, true);
        assert.equal(playback.plays.length, 0, 'no playback after cancel');
        assert.equal(session.active, false);
        session.feed('More. ');
        assert.equal(synth.requests.length, 1, 'feed after cancel is a no-op');
    });

    test('synthesis resolving after abort is discarded; no stale Blob playback', async () => {
        const { session, synth, playback, turnEnds } = createHarness();
        session.startSpeaker('v');
        session.feed('Hello. ');
        session.cancel('stop');
        synth.requests[0].resolve(new Blob(['stale']));
        await flushMicrotasks();
        assert.equal(turnEnds.length, 1);
        assert.equal(turnEnds[0].stopped, true);
        assert.equal(playback.plays.length, 0, 'stale Blob must never be played');
        assert.equal(session.active, false);
    });

    test('cancel during playback stops audio and drops ready and pending queues', async () => {
        const { session, synth, playback, turnEnds } = createHarness();
        session.startSpeaker('v');
        session.feed('One. Two. Three. ');
        synth.requests[0].resolve(new Blob(['one']));
        await flushMicrotasks();
        synth.requests[1].resolve(new Blob(['two']));
        await flushMicrotasks();
        assert.equal(playback.plays.length, 1, 'sentence 1 playing, sentence 2 ready, sentence 3 pending');
        session.cancel('stop');
        await flushMicrotasks();
        assert.equal(turnEnds.length, 1);
        assert.equal(turnEnds[0].stopped, true);
        assert.equal(playback.stopCalls, 1, 'current playback stopped');
        assert.equal(playback.plays.length, 1, 'ready sentence 2 must not start after cancel');
        assert.equal(synth.requests.length, 2, 'pending sentence 3 must not synthesize after cancel');
        assert.equal(session.active, false);
        const summary = session.finishInput();
        assert.deepEqual(summary, { sentenceCount: 3, firstAudioStarted: true });
        assert.equal(turnEnds.length, 1, 'finishInput after cancel must not re-settle');
    });

    test('a stale onEnded after cancel cannot advance the sequence or start audio', async () => {
        const { session, synth, playback, turnEnds } = createHarness();
        session.startSpeaker('v');
        session.feed('One. Two. ');
        synth.requests[0].resolve(new Blob(['one']));
        await flushMicrotasks();
        synth.requests[1].resolve(new Blob(['two']));
        await flushMicrotasks();
        session.cancel('stop');
        await flushMicrotasks();
        const playsBefore = playback.plays.length;
        // Simulate a late/duplicated onEnded from the stopped playback.
        playback.plays[0].onEnded();
        await flushMicrotasks();
        assert.equal(playback.plays.length, playsBefore, 'stale onEnded must not start the ready sentence');
        assert.equal(turnEnds.length, 1, 'stale onEnded must not settle the turn again');
        assert.equal(session.active, false);
    });


    test('failure and cancel race settles exactly once, in both orders', async () => {
        // Order A: cancel wins, then a genuine error arrives.
        {
            const { session, synth, turnEnds } = createHarness();
            session.startSpeaker('v');
            session.feed('Hello. ');
            session.cancel('stop');
            synth.requests[0].reject(new Error('network'));
            await flushMicrotasks();
            assert.equal(turnEnds.length, 1);
            assert.equal(turnEnds[0].stopped, true, 'cancel result wins');
        }
        // Order B: error wins, then cancel arrives.
        {
            const { session, synth, turnEnds } = createHarness();
            session.startSpeaker('v');
            session.feed('Hello. ');
            synth.requests[0].reject(new Error('503'));
            await flushMicrotasks();
            assert.equal(turnEnds.length, 1);
            assert.equal(turnEnds[0].ok, false);
            assert.equal(turnEnds[0].stopped, false, 'failure result wins');
            session.cancel('stop');
            assert.equal(turnEnds.length, 1, 'late cancel must not re-settle');
            assert.equal(session.active, false);
        }
    });

    test('playBlob rejecting or resolving after cancel does not double-settle', async () => {
        // Reject after cancel.
        {
            let rejectStart = null;
            const playback = {
                playBlob: () => new Promise((resolve, reject) => { rejectStart = reject; }),
                stop: () => {},
            };
            const synth = createManualSynth();
            const turnEnds = [];
            const session = createStreamingTtsSession({
                synthesize: synth.synth,
                playback: playback,
                onTurnEnd: (result) => { turnEnds.push(result); },
            });
            session.startSpeaker('v');
            session.feed('Hello. ');
            synth.requests[0].resolve(new Blob(['x']));
            await flushMicrotasks();
            session.cancel('stop');
            await flushMicrotasks();
            rejectStart(new Error('start failed'));
            await flushMicrotasks();
            assert.equal(turnEnds.length, 1, 'late start rejection must not re-settle');
            assert.equal(turnEnds[0].stopped, true);
            assert.equal(session.active, false);
        }
        // Resolve after cancel.
        {
            let resolveStart = null;
            const playback = {
                playBlob: () => new Promise((resolve) => { resolveStart = resolve; }),
                stop: () => {},
            };
            const synth = createManualSynth();
            const firstStarts = [];
            const turnEnds = [];
            const session = createStreamingTtsSession({
                synthesize: synth.synth,
                playback: playback,
                onFirstAudioStart: () => { firstStarts.push(1); },
                onTurnEnd: (result) => { turnEnds.push(result); },
            });
            session.startSpeaker('v');
            session.feed('Hello. ');
            synth.requests[0].resolve(new Blob(['x']));
            await flushMicrotasks();
            session.cancel('stop');
            await flushMicrotasks();
            resolveStart('blob:late');
            await flushMicrotasks();
            assert.equal(turnEnds.length, 1, 'late start resolution must not re-settle');
            assert.equal(turnEnds[0].stopped, true);
            assert.equal(firstStarts.length, 0, 'a late start after cancel must not count as first audio');
            assert.equal(session.firstAudioStarted, false);
        }
    });

    test('callbacks from an old cancelled turn cannot affect a new turn', async () => {
        const playback = createManualPlayback();

        const synthA = createManualSynth();
        const turnEndsA = [];
        const sessionA = createStreamingTtsSession({
            synthesize: synthA.synth,
            playback: playback,
            onTurnEnd: (result) => { turnEndsA.push(result); },
        });
        sessionA.startSpeaker('v');
        sessionA.feed('Old. ');
        synthA.requests[0].resolve(new Blob(['old']));
        await flushMicrotasks();
        sessionA.cancel('switch');
        await flushMicrotasks();
        assert.equal(turnEndsA.length, 1);
        assert.equal(playback.plays.length, 1);

        const synthB = createManualSynth();
        const firstStartsB = [];
        const turnEndsB = [];
        const sessionB = createStreamingTtsSession({
            synthesize: synthB.synth,
            playback: playback,
            onFirstAudioStart: () => { firstStartsB.push(1); },
            onTurnEnd: (result) => { turnEndsB.push(result); },
        });
        sessionB.startSpeaker('v');
        sessionB.feed('New. ');
        synthB.requests[0].resolve(new Blob(['new']));
        await flushMicrotasks();
        assert.equal(playback.plays.length, 2, 'new turn plays on the same controller');
        assert.equal(firstStartsB.length, 1);

        // Fire A's stale onEnded now.
        playback.plays[0].onEnded();
        await flushMicrotasks();
        assert.equal(turnEndsB.length, 0, 'old-turn onEnded must not settle the new turn');
        assert.equal(playback.plays.length, 2, 'old-turn onEnded must not advance the new turn');
        assert.equal(turnEndsA.length, 1, 'old-turn onEnded must not re-settle the old turn');

        // The new turn still completes normally.
        sessionB.finishInput();
        await flushMicrotasks();
        playback.endPlay(playback.plays[1]);
        await flushMicrotasks();
        assert.equal(turnEndsB.length, 1);
        assert.equal(turnEndsB[0].ok, true);
        // Play 0 (old turn) started BEFORE its cancel; play 1 (new turn)
        // started after. The point of the test is that the old turn's
        // stale onEnded above neither settled nor advanced the new turn.
        assert.deepEqual(playback.startedSeq(), [0, 1], 'old sentence started before cancel, new after');
    });
});


describe('failure (spec section 37)', () => {
    test('synthesis error before first audio fails the turn', async () => {
        const { session, synth, playback, turnEnds } = createHarness();
        session.startSpeaker('v');
        session.feed('Hello. ');
        const error = new Error('tts 503');
        synth.requests[0].reject(error);
        await flushMicrotasks();
        assert.equal(turnEnds.length, 1);
        assert.equal(turnEnds[0].ok, false);
        assert.equal(turnEnds[0].stopped, false);
        assert.equal(turnEnds[0].error, error);
        assert.equal(playback.plays.length, 0, 'no playback after synthesis failure');
        assert.equal(session.active, false);
        assert.equal(session.firstAudioStarted, false);
        assert.equal(session.handoffToLegacy(), false, 'no legacy fallback once a sentence existed');
    });

    test('synthesis error after first sentence played fails the turn without fallback', async () => {
        const { session, synth, playback, turnEnds } = createHarness();
        session.startSpeaker('v');
        session.feed('One. Two. ');
        synth.requests[0].resolve(new Blob(['one']));
        await flushMicrotasks();
        playback.endPlay(playback.plays[0]);
        await flushMicrotasks();
        assert.equal(session.firstAudioStarted, true);
        const error = new Error('tts down');
        synth.requests[1].reject(error);
        await flushMicrotasks();
        assert.equal(turnEnds.length, 1);
        assert.equal(turnEnds[0].ok, false);
        assert.equal(turnEnds[0].error, error);
        assert.equal(playback.plays.length, 1, 'no further playback after failure');
        assert.equal(session.handoffToLegacy(), false, 'already-spoken text must never be re-spoken by legacy');
    });

    test('playBlob rejection fails the turn and does not get stuck', async () => {
        const playback = {
            playBlob: () => Promise.reject(new Error('autoplay blocked')),
            stopCalls: 0,
            stop() { this.stopCalls += 1; },
        };
        const synth = createManualSynth();
        const firstStarts = [];
        const turnEnds = [];
        const session = createStreamingTtsSession({
            synthesize: synth.synth,
            playback: playback,
            onFirstAudioStart: () => { firstStarts.push(1); },
            onTurnEnd: (result) => { turnEnds.push(result); },
        });
        session.startSpeaker('v');
        session.feed('Hello. ');
        synth.requests[0].resolve(new Blob(['x']));
        await flushMicrotasks();
        assert.equal(turnEnds.length, 1, 'playback start failure settles the turn');
        assert.equal(turnEnds[0].ok, false);
        assert.equal(turnEnds[0].error instanceof Error, true);
        assert.equal(firstStarts.length, 0, 'onFirstAudioStart must not fire on a failed start');
        assert.equal(session.firstAudioStarted, false);
        assert.equal(session.active, false, 'no stuck playback flight');
        assert.equal(playback.stopCalls, 1, 'failure stops current playback state');
        session.cancel('after');
        assert.equal(turnEnds.length, 1, 'no double settle');
    });

    test('synchronous synthesize throw fails the turn instead of escaping', async () => {
        const error = new Error('sync boom');
        const playback = createManualPlayback();
        const turnEnds = [];
        const session = createStreamingTtsSession({
            synthesize: () => { throw error; },
            playback: playback,
            onTurnEnd: (result) => { turnEnds.push(result); },
        });
        session.startSpeaker('v');
        session.feed('Hello. ');
        await flushMicrotasks();
        assert.equal(turnEnds.length, 1, 'a synchronous transport throw must fail the turn');
        assert.equal(turnEnds[0].error, error);
        assert.equal(session.active, false);
    });
});


describe('zero-work legacy handoff (spec section 38)', () => {
    test('zero-sentence handoff succeeds silently without onTurnEnd or playback', async () => {
        const { session, synth, playback, turnEnds } = createHarness();
        session.startSpeaker('af_heart');
        // A fenced code block is dropped entirely by the splitter.
        session.feed('```js\nconst x = 1;\n```');
        assert.equal(session.sentenceCount, 0);
        assert.equal(synth.requests.length, 0);
        const summary = session.finishInput();
        assert.deepEqual(summary, { sentenceCount: 0, firstAudioStarted: false });
        await flushMicrotasks();
        assert.equal(session.handoffToLegacy(), true, 'zero work: handoff allowed');
        assert.equal(turnEnds.length, 0, 'abandoned session must not fire onTurnEnd');
        assert.equal(playback.plays.length, 0, 'zero-work handoff must not touch playback');
        assert.equal(playback.stopCalls, 0, 'zero-work handoff must not stop playback');
        assert.equal(session.active, false, 'session is invalidated after handoff');
        assert.equal(session.handoffToLegacy(), false, 'a second handoff is impossible');
        session.startSpeaker('v');
        session.feed('Hello. ');
        assert.equal(synth.requests.length, 0, 'input after handoff is a no-op');
    });

    test('zero-sentence handoff succeeds for a muted speaker only', async () => {
        const { session, synth, turnEnds } = createHarness();
        session.startSpeaker('');
        session.feed('Nothing to say. Here either. ');
        assert.equal(session.sentenceCount, 0);
        session.finishInput();
        await flushMicrotasks();
        assert.equal(session.handoffToLegacy(), true);
        assert.equal(turnEnds.length, 0);
        assert.equal(synth.requests.length, 0);
        assert.equal(session.active, false);
    });

    test('handoff is rejected before finishInput even with zero sentences', () => {
        const { session } = createHarness();
        session.startSpeaker('v');
        assert.equal(session.handoffToLegacy(), false, 'input is still open');
    });

    test('handoff is rejected once a sentence exists, even before any audio', async () => {
        const { session, synth } = createHarness();
        session.startSpeaker('v');
        session.feed('Hi. ');
        assert.equal(session.sentenceCount, 1);
        assert.equal(session.handoffToLegacy(), false, 'input open + sentence queued');
        session.finishInput();
        assert.equal(session.handoffToLegacy(), false, 'input closed + sentence queued');
        synth.requests[0].resolve(new Blob(['x']));
        await flushMicrotasks();
        assert.equal(session.handoffToLegacy(), false, 'synthesis in flight/ready');
    });

    test('handoff is rejected after audio started, even after completion', async () => {
        const { session, synth, playback } = createHarness();
        session.startSpeaker('v');
        session.feed('Hi. ');
        synth.requests[0].resolve(new Blob(['x']));
        await flushMicrotasks();
        assert.equal(session.firstAudioStarted, true);
        assert.equal(session.handoffToLegacy(), false, 'while audio plays');
        playback.endPlay(playback.plays[0]);
        await flushMicrotasks();
        session.finishInput();
        await flushMicrotasks();
        assert.equal(session.handoffToLegacy(), false, 'after the turn completed');
    });
});


describe('integration with the real createPlaybackController', () => {
    test('sentences play in order through real playBlob and the turn completes', async () => {
        const { controller, audios } = makeRealPlaybackController();
        const synthRequests = [];
        const harness = createHarness({
            playback: controller,
            synthesize: async ({ text }) => {
                synthRequests.push(text);
                return new Blob([`audio:${text}`]);
            },
        });
        const { session } = harness;

        session.startSpeaker('af_heart');
        session.feed('One. Two. ');
        session.finishInput();
        await flushMicrotasks();
        assert.equal(synthRequests.length, 2, 'lookahead: sentence 2 synthesized while sentence 1 plays');
        assert.equal(audios.length, 1, 'sentence 1 playing, sentence 2 waiting');
        assert.equal(harness.turnEnds.length, 0);

        audios[0].emit('ended');
        await flushMicrotasks();
        assert.equal(audios.length, 2, 'sentence 2 starts immediately after sentence 1 ends');
        assert.equal(synthRequests.length, 2);

        audios[1].emit('ended');
        await flushMicrotasks();
        assert.equal(harness.turnEnds.length, 1);
        assert.equal(harness.turnEnds[0].ok, true);
        assert.equal(harness.firstStarts.length, 1);
        assert.equal(audios[0].src, 'blob:st-1', 'playback order: sentence 1 first');
        assert.equal(audios[1].src, 'blob:st-2', 'playback order: sentence 2 second');
        assert.equal(controller.isPlaying, false);
        assert.equal(session.active, false);
    });

    test('onFirstAudioStart fires only after the first real Audio.play() resolves', async () => {
        let resolvePlay = null;
        const controller = createPlaybackController({
            createObjectURL: () => 'blob:fa-1',
            revokeObjectURL: () => {},
            audioFactory: (url) => {
                const audio = makeEventMockAudio();
                audio.src = url;
                audio.play = () => new Promise((resolve) => {
                    resolvePlay = resolve;
                });
                return audio;
            },
        });
        const synth = createManualSynth();
        const firstStarts = [];
        const turnEnds = [];
        const session = createStreamingTtsSession({
            synthesize: synth.synth,
            playback: controller,
            onFirstAudioStart: () => { firstStarts.push(1); },
            onTurnEnd: (result) => { turnEnds.push(result); },
        });

        session.startSpeaker('v');
        session.feed('Hello. ');
        session.finishInput();
        await flushMicrotasks();
        assert.equal(synth.requests.length, 1);
        assert.equal(session.firstAudioStarted, false, 'synthesis in flight, no audio yet');
        assert.equal(firstStarts.length, 0);

        synth.requests[0].resolve(new Blob(['x']));
        await flushMicrotasks();
        assert.equal(session.firstAudioStarted, false, 'Audio.play() is still pending');
        assert.equal(firstStarts.length, 0);

        resolvePlay();
        await flushMicrotasks();
        assert.equal(session.firstAudioStarted, true, 'first audio started only after play() resolved');
        assert.equal(firstStarts.length, 1);
    });

    test('cancel with the real controller stops audio and drops the ready queue', async () => {
        const { controller, audios } = makeRealPlaybackController();
        const synth = createManualSynth();
        const turnEnds = [];
        const session = createStreamingTtsSession({
            synthesize: synth.synth,
            playback: controller,
            onTurnEnd: (result) => { turnEnds.push(result); },
        });

        session.startSpeaker('v');
        session.feed('One. Two. ');
        session.finishInput();
        synth.requests[0].resolve(new Blob(['one']));
        await flushMicrotasks();
        synth.requests[1].resolve(new Blob(['two']));
        await flushMicrotasks();
        assert.equal(audios.length, 1, 'sentence 2 waits ready while sentence 1 plays');

        session.cancel('stop');
        await flushMicrotasks();
        assert.equal(turnEnds.length, 1);
        assert.equal(turnEnds[0].stopped, true);
        assert.equal(audios[0].paused, true, 'current audio paused');
        assert.equal(audios.length, 1, 'ready sentence 2 never started');
        assert.equal(controller.isPlaying, false);

        // A late ended event from the torn-down audio must not re-settle.
        audios[0].emit('ended');
        await flushMicrotasks();
        assert.equal(turnEnds.length, 1);
        assert.equal(audios.length, 1);
        assert.equal(session.active, false);
    });
});
