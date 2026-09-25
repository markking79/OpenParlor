/**
 * VOICE-002 Step 2D: unified TTS playback ownership tests.
 *
 * Covers the single app-level ownership teardown contract
 * (createTtsOwnershipController in app.js) across every ownership
 * transition: manual Play / Replay / Stop, new send, conversation switch,
 * toggle-off, and recording start — against the REAL playback controller,
 * legacy group queue, streaming TTS session, and Hands-Free controller.
 * Only the TTS fetch, the audio element, and the sentence synthesizer are
 * deterministic fakes; fake audio "ends" only when the test fires its
 * 'ended' event. No sleeps or arbitrary timers are used.
 *
 * Regression focus: the Step 2D hazard where groupQueue.clear() alone
 * leaves an active legacy playItem promise unsettled (a replacement play()
 * suppresses its completion callback via cancelCurrent), plus the missing
 * teardowns (new conversation, recording start, new send) that let old
 * audio continue into new ownership.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTtsOwnershipController, createStreamingTurnState } from '../../public/openparlor/app.js';
import { createPlaybackController, createGroupPlaybackQueue } from '../../public/openparlor/audio.js';
import { createStreamingTtsSession } from '../../public/openparlor/streaming-tts.js';
import { createHandsFreeController, HANDSFREE_STATES } from '../../public/openparlor/handsfree.js';

// One event-loop tick: the queue loop and promise chains settle on
// microtasks/immediates, never on timers.
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

/** Enough microtask ticks for synthesize -> ready -> playBlob -> first audio. */
async function flushMicrotasks() {
    for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
    }
    await flush();
}

/**
 * Deterministic playback harness: fake TTS fetch, object URLs, and Audio
 * elements. Each fake audio records play()/pause() and exposes end() to
 * fire its 'ended' listener exactly as the browser would.
 */
function makePlaybackHarness() {
    const created = [];
    const revoked = [];
    let urlCount = 0;
    const audioFactory = (url) => {
        const audio = {
            src: url,
            played: false,
            paused: false,
            _onEnded: null,
            async play() { this.played = true; },
            pause() { this.paused = true; },
            addEventListener(event, fn) {
                if (event === 'ended') this._onEnded = fn;
            },
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

/** Audio elements that actually started and were not released. */
function activeAudios(created) {
    return created.filter((a) => a.played && !a.paused && a.src !== '');
}

/** Real Hands-Free controller with recorded state transitions. */
function makeHf() {
    const transitions = [];
    const hf = createHandsFreeController({
        getConversationId: () => 'conv-1',
        startListening: async () => {},
        stopListening: () => {},
        onStateChange: (state) => { transitions.push(state); },
    });
    return { hf, transitions };
}

/**
 * Legacy group queue wired exactly like app.js: an item settles only when
 * its own playback completion fires, or its start resolves null (it was
 * superseded before producing audio).
 */
function makeLegacyQueue(playback, onAllDone = null) {
    return createGroupPlaybackQueue({
        playItem: (text, voice) => new Promise((resolve, reject) => {
            let settled = false;
            const onEnd = () => {
                if (!settled) { settled = true; resolve(); }
            };
            playback.play(text, voice, onEnd)
                .then((url) => {
                    if (url === null) onEnd();
                })
                .catch((e) => {
                    if (!settled) { settled = true; reject(e); }
                });
        }),
        onAllDone,
    });
}

/**
 * Per-turn streaming state wired exactly like app.js's sendMessage:
 * real createStreamingTurnState + real createStreamingTtsSession with the
 * app-level Hands-Free effects on first audio and on settle.
 */
function makeStreamingTurn({ playback, synthesize, hf }) {
    return createStreamingTurnState({
        isCurrent: () => true,
        isEligible: () => true,
        resolveVoice: () => 'voice-a',
        createSession: (hooks) => createStreamingTtsSession({
            playback,
            synthesize,
            onFirstAudioStart: hooks.onFirstAudioStart,
            onTurnEnd: hooks.onTurnEnd,
        }),
        onFirstAudio: () => {
            if (hf) hf.markSpeakingStart();
        },
        onTurnSettled: (state) => {
            if (!hf) return;
            if (state.firstAudioStarted) hf.markSpeakingEnd();
            else hf.markResponseComplete();
        },
    });
}

/**
 * Deterministic sentence synthesizer: resolves with a Blob on the next
 * microtask unless the request signal was aborted (cancel/failure).
 */
function makeSynth() {
    const requests = [];
    const synthesize = ({ text, voice, signal }) => new Promise((resolve, reject) => {
        const req = { text, voice, done: false };
        requests.push(req);
        if (signal) {
            signal.addEventListener('abort', () => {
                req.done = true;
                reject(new Error('aborted'));
            }, { once: true });
        }
        Promise.resolve().then(() => {
            if (!req.done) { req.done = true; resolve(new Blob([text])); }
        });
    });
    return { synthesize, requests };
}

/**
 * The app-level ownership controller under test, with every dependency
 * wrapped so the teardown ordering is observable.
 */
function makeOwnership({ turnRef, queue, playback, hf, order, timer }) {
    return createTtsOwnershipController({
        cancelStreamingTurn: (reason) => {
            order.push('cancel:' + reason);
            if (turnRef.current) turnRef.current.cancel(reason);
        },
        groupQueue: {
            clear: () => { order.push('queue.clear'); queue.clear(); },
        },
        playback: {
            stop: () => { order.push('playback.stop'); playback.stop(); },
        },
        timer: {
            cancel: () => {
                order.push('timer.cancel');
                if (timer) timer.cancel();
            },
        },
        markSpeakingEnd: () => {
            order.push('markSpeakingEnd');
            if (hf) hf.markSpeakingEnd();
        },
        refreshButtons: () => { order.push('refreshButtons'); },
    });
}

describe('VOICE-002 Step 2D: teardown ordering contract', () => {
    test('stopActiveTts always runs cancel -> clear -> stop -> timer -> HF end -> buttons', () => {
        const order = [];
        let hfEnds = 0;
        const ownership = createTtsOwnershipController({
            cancelStreamingTurn: (reason) => { order.push('cancel:' + reason); },
            groupQueue: { clear: () => { order.push('queue.clear'); } },
            playback: { stop: () => { order.push('playback.stop'); } },
            timer: { cancel: () => { order.push('timer.cancel'); } },
            markSpeakingEnd: () => { order.push('markSpeakingEnd'); hfEnds++; },
            refreshButtons: () => { order.push('refreshButtons'); },
        });

        ownership.stopActiveTts('test');
        assert.deepEqual(order, [
            'cancel:test', 'queue.clear', 'playback.stop', 'timer.cancel', 'refreshButtons',
        ]);
        assert.equal(hfEnds, 0, 'no HF end without the option');

        order.length = 0;
        ownership.stopActiveTts('test', { markSpeakingEnd: true });
        assert.deepEqual(order, [
            'cancel:test', 'queue.clear', 'playback.stop', 'timer.cancel',
            'markSpeakingEnd', 'refreshButtons',
        ]);
        assert.equal(hfEnds, 1, 'the HF end runs after stop, before button refresh');
    });

    test('clear() then stop() deterministically settles an active legacy playItem', async () => {
        // The Step 2D hazard: without the stop() after clear(), a
        // replacement play() would suppress the active item's completion
        // callback via cancelCurrent() and its promise (and the queue loop)
        // would never settle.
        const { deps, created } = makePlaybackHarness();
        const playback = createPlaybackController(deps);
        let allDoneCount = 0;
        const queue = makeLegacyQueue(playback, () => { allDoneCount++; });
        queue.enqueue('one', 'v1');
        const playAllPromise = queue.playAll();
        await flush();
        assert.equal(created.length, 1, 'item 1 is playing');
        assert.equal(created[0].played, true);

        // Teardown exactly as stopActiveTts performs it.
        queue.clear();
        playback.stop();
        await flush();
        const settled = await Promise.race([
            playAllPromise.then(() => 'settled'),
            flush().then(() => 'pending'),
        ]);
        assert.equal(settled, 'settled', 'the interrupted playAll must settle, not hang');
        assert.equal(allDoneCount, 0, 'the invalidated loop must not fire onAllDone');
        assert.equal(queue.isPlaying, false);
        assert.equal(queue.pending, 0);

        // A replacement play must not resurrect the old item.
        await playback.play('new', 'v', () => {});
        await flush();
        assert.equal(created.length, 2, 'only the new playback exists');
        assert.equal(created[0].paused, true);
        assert.equal(activeAudios(created).length, 1, 'never more than one active audio');
    });
});

describe('manual Play / Replay / Stop while a legacy item is actively playing', () => {
    function makeLegacyPlayingScenario() {
        const { deps, created } = makePlaybackHarness();
        const playback = createPlaybackController(deps);
        const { hf, transitions } = makeHf();
        let allDoneCount = 0;
        const queue = makeLegacyQueue(playback, () => { allDoneCount++; });
        queue.enqueue('one', 'v1');
        queue.enqueue('two', 'v2');
        const playAllPromise = queue.playAll();
        return {
            playback, hf, transitions, queue, created,
            allDone: () => allDoneCount,
            playAllPromise,
        };
    }

    async function startLegacyPlaying(s) {
        await s.hf.enable();
        await flush();
        assert.equal(s.created.length, 1, 'legacy item 1 is playing');
        // sendMessage marks one speaking phase at queue start.
        s.hf.markSpeakingStart();
        assert.equal(s.hf.state, HANDSFREE_STATES.SPEAKING);
    }

    test('manual Play: old item settles, loop does not resume, manual audio owns', async () => {
        const s = makeLegacyPlayingScenario();
        await startLegacyPlaying(s);

        // The app's manual Play wiring: teardown, then the new playback.
        const ownership = makeOwnership({
            turnRef: { current: null },
            queue: s.queue, playback: s.playback, hf: s.hf, order: [],
        });
        ownership.stopActiveTts('manual-playback');
        s.hf.markSpeakingStart();
        let manualEnds = 0;
        await s.playback.play('manual message', 'vm', () => { manualEnds++; });
        await flush();

        const settled = await Promise.race([
            s.playAllPromise.then(() => 'settled'),
            flush().then(() => 'pending'),
        ]);
        assert.equal(settled, 'settled', 'the old queue item must settle');
        assert.equal(s.allDone(), 0, 'the old loop must not fire onAllDone');
        assert.equal(s.created.length, 2, 'item 2 never starts; only the manual audio is added');
        assert.equal(s.created[1].played, true, 'the manual audio owns playback');
        assert.equal(s.created[0].paused, true, 'the legacy audio is stopped');
        assert.equal(manualEnds, 0, 'teardown must not complete the new playback');
        assert.equal(s.playback.isPlaying, true);
        assert.equal(s.queue.isPlaying, false, 'no stuck queue state');
        assert.equal(activeAudios(s.created).length, 1, 'never more than one active audio');
        assert.equal(s.hf.state, HANDSFREE_STATES.SPEAKING, 'the speaking phase continues into the manual playback');
    });

    test('manual Replay: same guarantees as Play', async () => {
        const s = makeLegacyPlayingScenario();
        await startLegacyPlaying(s);

        const ownership = makeOwnership({
            turnRef: { current: null },
            queue: s.queue, playback: s.playback, hf: s.hf, order: [],
        });
        ownership.stopActiveTts('manual-playback');
        s.hf.markSpeakingStart();
        let replayEnds = 0;
        await s.playback.replay('manual message', 'vm', () => { replayEnds++; });
        await flush();

        const settled = await Promise.race([
            s.playAllPromise.then(() => 'settled'),
            flush().then(() => 'pending'),
        ]);
        assert.equal(settled, 'settled', 'the old queue item must settle');
        assert.equal(s.allDone(), 0, 'the old loop must not fire onAllDone');
        assert.equal(s.created.length, 2, 'item 2 never starts; only the replay audio is added');
        assert.equal(s.created[1].played, true, 'the replay audio owns playback');
        assert.equal(s.created[0].paused, true, 'the legacy audio is stopped');
        assert.equal(replayEnds, 0, 'teardown must not complete the new playback');
        assert.equal(activeAudios(s.created).length, 1, 'never more than one active audio');
        assert.equal(s.hf.state, HANDSFREE_STATES.SPEAKING);
    });

    test('manual Stop: queue drains cleanly and no queued item starts afterwards', async () => {
        const s = makeLegacyPlayingScenario();
        await startLegacyPlaying(s);

        const ownership = makeOwnership({
            turnRef: { current: null },
            queue: s.queue, playback: s.playback, hf: s.hf, order: [],
        });
        ownership.stopActiveTts('playback-stop', { markSpeakingEnd: true });
        await flush();

        const settled = await Promise.race([
            s.playAllPromise.then(() => 'settled'),
            flush().then(() => 'pending'),
        ]);
        assert.equal(settled, 'settled');
        assert.equal(s.allDone(), 0, 'the invalidated loop must not fire onAllDone');
        assert.equal(s.created.length, 1, 'item 2 never starts');
        assert.equal(s.created[0].paused, true);
        assert.equal(s.playback.isPlaying, false);
        assert.equal(s.queue.isPlaying, false, 'no stuck isPlaying state');
        assert.equal(s.hf.state, HANDSFREE_STATES.LISTENING, 'the speaking phase ends');
        await flush();
        await flush();
        assert.equal(s.created.length, 1, 'no stale sentence may begin later');
    });

    test('Stop while the next legacy item is still synthesizing: that item never starts', async () => {
        const { deps, created } = makePlaybackHarness();
        let fetchCount = 0;
        const gates = [];
        const fetchFn = async () => {
            fetchCount += 1;
            if (fetchCount > 1) {
                // The second (next-item) synthesis is gated until the test
                // releases it — deterministically "in flight".
                await new Promise((resolve) => { gates.push(resolve); });
            }
            return { ok: true, blob: async () => new Blob(['fake-audio']), json: async () => ({}) };
        };
        const playback = createPlaybackController({ ...deps, fetchFn });
        const queue = makeLegacyQueue(playback, null);
        queue.enqueue('one', 'v1');
        queue.enqueue('two', 'v2');
        const playAllPromise = queue.playAll();
        await flush();
        created[0].end(); // item 1 ends naturally; item 2 begins synthesizing
        await flush();
        assert.equal(fetchCount, 2, 'item 2 fetch is in flight');
        assert.equal(created.length, 1, 'item 2 has no audio yet');

        const ownership = makeOwnership({
            turnRef: { current: null },
            queue, playback, hf: null, order: [],
        });
        ownership.stopActiveTts('playback-stop', { markSpeakingEnd: true });

        // Now the in-flight synthesis completes — it is too late.
        gates[0]();
        await flush();
        await flush();
        assert.equal(created.length, 1, 'the interrupted item never produces audio');
        const settled = await Promise.race([
            playAllPromise.then(() => 'settled'),
            flush().then(() => 'pending'),
        ]);
        assert.equal(settled, 'settled', 'the queue settles despite the late fetch');
    });
});

describe('manual Play / Stop while a streaming sentence is playing', () => {
    async function makeStreamingPlayingScenario() {
        const { deps, created } = makePlaybackHarness();
        const playback = createPlaybackController(deps);
        const { hf, transitions } = makeHf();
        await hf.enable();
        const { synthesize } = makeSynth();
        const turn = makeStreamingTurn({ playback, synthesize, hf });
        const turnRef = { current: turn };
        const queue = makeLegacyQueue(playback, null);
        const ownership = makeOwnership({
            turnRef, queue, playback, hf, order: [],
        });
        turn.onSpeakerStart('char-1');
        turn.onDelta('First sentence. Second sentence. Third sentence.');
        await flushMicrotasks();
        assert.equal(created.length, 1, 'sentence 1 is playing');
        assert.equal(hf.state, HANDSFREE_STATES.SPEAKING);
        return { playback, hf, transitions, turn, turnRef, queue, ownership, created };
    }

    test('manual Play: session cancels, stale streaming onEnded cannot restart playback', async () => {
        const s = await makeStreamingPlayingScenario();

        // The app's manual Play wiring: teardown, then the new playback.
        s.ownership.stopActiveTts('manual-playback');
        s.hf.markSpeakingStart();
        let manualEnds = 0;
        await s.playback.play('manual message', 'vm', () => { manualEnds++; });
        await flushMicrotasks();

        assert.equal(s.turn.mode, 'stopped', 'the session is terminal');
        assert.equal(s.created.length, 2, 'no streamed sentence 2 may start');
        assert.equal(s.created[1].played, true, 'the manual audio owns playback');
        assert.equal(s.created[0].paused, true, 'the streamed audio is stopped');
        assert.equal(activeAudios(s.created).length, 1, 'never more than one active audio');

        // A stale 'ended' from the old streamed audio must do nothing.
        s.created[0].end();
        await flushMicrotasks();
        assert.equal(s.created.length, 2, 'the stale ended event must not start sentence 2');
        assert.equal(manualEnds, 0, 'the stale ended event must not complete the manual playback');
        assert.equal(s.playback.isPlaying, true, 'the new owner is untouched');
    });

    test('Stop: pending and ready sentences never play', async () => {
        const s = await makeStreamingPlayingScenario();
        // Look-ahead: sentence 2 may already be synthesized (ready) while
        // sentence 1 plays; neither may play after Stop.

        s.ownership.stopActiveTts('playback-stop', { markSpeakingEnd: true });
        await flushMicrotasks();
        await flushMicrotasks();
        assert.equal(s.created.length, 1, 'no further sentence may start');
        assert.equal(s.playback.isPlaying, false);
        assert.equal(s.turn.mode, 'stopped', 'the session is terminal');
        assert.equal(s.hf.state, HANDSFREE_STATES.LISTENING, 'the speaking phase ends exactly once');

        // A stale end from the stopped streamed audio resurrects nothing.
        s.created[0].end();
        await flushMicrotasks();
        assert.equal(s.created.length, 1);
        assert.equal(s.hf.state, HANDSFREE_STATES.LISTENING);
    });
});

describe('new send while the previous turn audio is active', () => {
    test('legacy queue playing: old audio stops, no old queue callback affects the new turn', async () => {
        const { deps, created } = makePlaybackHarness();
        const playback = createPlaybackController(deps);
        const { hf } = makeHf();
        await hf.enable();
        let allDoneCount = 0;
        const queue = makeLegacyQueue(playback, () => { allDoneCount++; });
        queue.enqueue('old one', 'v1');
        queue.enqueue('old two', 'v2');
        const oldPlayAll = queue.playAll();
        await flush();
        assert.equal(created.length, 1, 'old item 1 is playing');
        hf.markSpeakingStart(); // sendMessage marks the phase at queue start

        // The app's new-send wiring (Step 2D).
        const ownership = makeOwnership({
            turnRef: { current: null },
            queue, playback, hf, order: [],
        });
        ownership.stopActiveTts('superseded-send', { markSpeakingEnd: true });
        await flush();

        const settled = await Promise.race([
            oldPlayAll.then(() => 'settled'),
            flush().then(() => 'pending'),
        ]);
        assert.equal(settled, 'settled', 'the old queue must settle');
        assert.equal(allDoneCount, 0, 'no stale onAllDone for the new turn');
        assert.equal(created.length, 1, 'old item 2 never plays');
        assert.equal(created[0].paused, true);
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING, 'the old speaking phase ends');

        // The new turn's own legacy queue works under the new ownership.
        queue.enqueue('new one', 'v3');
        const newPlayAll = queue.playAll();
        await flush();
        assert.equal(created.length, 2, 'the new turn audio starts');
        assert.equal(allDoneCount, 0, 'the new turn is not completed by the old callback');
        created[1].end();
        await newPlayAll;
        assert.equal(allDoneCount, 1, 'the new turn completes exactly once, by its own completion');
    });

    test('streaming playing: session cancels, stale callbacks ignored', async () => {
        const { deps, created } = makePlaybackHarness();
        const playback = createPlaybackController(deps);
        const { hf } = makeHf();
        await hf.enable();
        const { synthesize } = makeSynth();
        const turn = makeStreamingTurn({ playback, synthesize, hf });
        const turnRef = { current: turn };
        const queue = makeLegacyQueue(playback, null);
        const ownership = makeOwnership({
            turnRef, queue, playback, hf, order: [],
        });
        turn.onSpeakerStart('char-1');
        turn.onDelta('First sentence. Second sentence.');
        await flushMicrotasks();
        assert.equal(created.length, 1, 'sentence 1 is playing');
        assert.equal(hf.state, HANDSFREE_STATES.SPEAKING);

        ownership.stopActiveTts('superseded-send', { markSpeakingEnd: true });
        await flushMicrotasks();

        assert.equal(turn.mode, 'stopped', 'the session is terminal');
        assert.equal(created.length, 1, 'sentence 2 never plays');
        assert.equal(created[0].paused, true);
        assert.equal(playback.isPlaying, false);
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING, 'the speaking phase ends');

        // A stale end from the old streamed audio does nothing.
        created[0].end();
        await flushMicrotasks();
        assert.equal(created.length, 1);
        assert.equal(hf.state, HANDSFREE_STATES.LISTENING);
    });
});
