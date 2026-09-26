/**
 * Streaming TTS sentence coordinator for VOICE-002.
 *
 * Splits an in-progress assistant response into sentences (via
 * createSentenceSplitter), synthesizes each sentence with the injected
 * synthesize() transport, and plays them back in generated order through the
 * injected playback controller (createPlaybackController.playBlob).
 *
 * Architecture: two independent progress paths — a synthesis lane and a
 * playback lane — that share state but never await each other. JavaScript's
 * single-threaded event loop plus the single-flight guards below provide
 * mutual exclusion; no timers or polling are used.
 *
 * Invariants:
 * - Playback order always equals generated sentence order. Playback is keyed
 *   by the explicit nextPlaySeq cursor, never by Map insertion order.
 * - At most one synthesis request is active at any instant
 *   (synthesisFlight), and at most one audio item is playing
 *   (playbackFlight).
 * - Synthesis of sentence N+1 is allowed while sentence N is playing, up to
 *   the bounded look-ahead (maxReadyAhead synthesized Blobs may wait in
 *   ready; the remaining sentences stay as cheap pending text).
 * - Generation-safe cancellation: cancel()/failure bumps the session
 *   generation and settles exactly once, so every in-flight synthesis result,
 *   playback start promise, and armed onEnded callback from an older
 *   generation is discarded instead of resuming work.
 * - Once any streaming sentence has been enqueued, the zero-work legacy
 *   handoff is permanently forbidden (duplicate-speech firewall).
 *
 * The coordinator never owns object URLs: it stores synthesized Blobs only,
 * and all URL lifecycle stays inside createPlaybackController.
 */

import { createSentenceSplitter } from './audio.js';

/**
 * Creates a streaming TTS session for one assistant turn.
 *
 * The session is fed the raw streaming protocol incrementally:
 * startSpeaker(voice) on speaker_start, feed(text) for each raw delta,
 * endSpeaker() on speaker_end (which immediately flushes that speaker's
 * unterminated tail with the OLD speaker's voice), and finishInput() on the
 * final done. It may keep synthesizing and playing after the input stream
 * reaches done.
 *
 * @param {{
 *   synthesize: ({ text: string, voice: string, signal: AbortSignal }) => Promise<Blob>,
 *   playback: { playBlob: (blob: Blob, onEnded?: () => void) => Promise<unknown>, stop: () => void },
 *   onFirstAudioStart?: () => void,
 *   onTurnEnd?: (result: { ok: boolean, stopped: boolean, reason?: unknown, error?: unknown }) => void,
 *   maxReadyAhead?: number,
 * }} deps
 *   synthesize: injected transport for POST /api/openparlor/tts/synthesize;
 *     must reject when signal is aborted.
 *   playback: the shared createPlaybackController; this session is its sole
 *     owner while active.
 *   onFirstAudioStart: fired exactly once, only after the first
 *     playback.playBlob() promise has resolved (Audio.play() successfully
 *     started). Never fired before real audio.
 *   onTurnEnd: fired exactly once when the turn settles:
 *     { ok: true, stopped: false } on natural completion,
 *     { ok: false, stopped: true, reason } on cancel(),
 *     { ok: false, stopped: false, error } on synthesis/playback failure.
 *   maxReadyAhead: bounded look-ahead; at most this many synthesized Blobs
 *     may wait ready while another plays. Default 1.
 * @returns {{
 *   startSpeaker: (voice: string) => void,
 *   feed: (text: string) => void,
 *   endSpeaker: () => void,
 *   finishInput: () => { sentenceCount: number, firstAudioStarted: boolean },
 *   cancel: (reason?: unknown) => void,
 *   handoffToLegacy: () => boolean,
 *   sentenceCount: number,
 *   firstAudioStarted: boolean,
 *   active: boolean,
 * }}
 */
export function createStreamingTtsSession(deps) {
    const {
        synthesize,
        playback,
        onFirstAudioStart = null,
        onTurnEnd = null,
        maxReadyAhead = 1,
    } = deps;

    // --- Speaker state -----------------------------------------------------
    let splitter = null;
    let currentVoice = '';
    let speakerOpen = false;

    // --- Turn state ---------------------------------------------------------
    let inputClosed = false;
    let settled = false;

    // Bumped on cancel() and failure so every in-flight async callback from
    // an older generation is provably stale.
    let generation = 0;

    // --- Pipeline state ------------------------------------------------------
    // Monotonic; sequence IDs are never derived from queue length and never
    // recycled.
    let nextSeq = 0;
    // Explicit playback cursor: playback is only ever allowed to start the
    // sentence whose seq equals nextPlaySeq, in order.
    let nextPlaySeq = 0;

    // [{ seq, text, voice }] — cheap pending text queue.
    const pendingSynthesis = [];
    // Single in-flight synthesis: { seq, text, voice, generation, controller }.
    let synthesisFlight = null;
    // Synthesized Blobs awaiting playback, keyed by seq: seq -> { blob, text, voice }.
    const ready = new Map();
    // Single in-flight playback: { seq, generation, token }.
    let playbackFlight = null;
    let playTokenCounter = 0;

    let sentenceCount = 0;
    let firstAudioStarted = false;

    /**
     * Assigns a monotonic seq and queues one sentence for synthesis.
     * @param {string} text
     * @param {string} voice
     * @returns {void}
     */
    function enqueueSentence(text, voice) {
        const trimmed = typeof text === 'string' ? text.trim() : '';
        if (!trimmed || !voice) return;
        const seq = nextSeq;
        nextSeq += 1;
        sentenceCount += 1;
        pendingSynthesis.push({ seq: seq, text: trimmed, voice: voice });
        kickPlayback();
        kickSynthesis();
        maybeFinish();
    }

    /**
     * Synthesis lane. Starts the next pending sentence's synthesis when no
     * synthesis is in flight and the ready-ahead bound is not saturated.
     * Never awaits playback.
     * @returns {void}
     */
    function kickSynthesis() {
        if (settled) return;
        if (synthesisFlight) return;
        if (pendingSynthesis.length === 0) {
            maybeFinish();
            return;
        }
        if (ready.size >= maxReadyAhead) return;

        const item = pendingSynthesis.shift();
        const controller = new AbortController();
        const localGeneration = generation;
        const flight = {
            seq: item.seq,
            text: item.text,
            voice: item.voice,
            generation: localGeneration,
            controller: controller,
        };
        synthesisFlight = flight;

        // Call the transport synchronously so a synchronous throw becomes a
        // current-generation failure here instead of escaping kickSynthesis;
        // the result itself is handled asynchronously below.
        let result;
        try {
            result = synthesize({
                text: item.text,
                voice: item.voice,
                signal: controller.signal,
            });
        } catch (error) {
            failTurn(error);
            return;
        }
        Promise.resolve(result)
            .then((blob) => {
                // Stale (cancelled/failed turn, or a newer flight took over):
                // discard the result. It must never enter ready.
                if (settled || generation !== localGeneration || synthesisFlight !== flight) return;
                ready.set(item.seq, { blob: blob, text: item.text, voice: item.voice });
            })
            .catch((error) => {
                // An abort caused by cancel()/failure is not a second failure;
                // a genuine error on the current generation fails the turn.
                if (settled || generation !== localGeneration || synthesisFlight !== flight) return;
                failTurn(error);
            })
            .finally(() => {
                if (synthesisFlight === flight) {
                    synthesisFlight = null;
                }
                // kickPlayback MUST run first: a just-ready blob moves
                // ready -> playing before kickSynthesis re-evaluates the
                // ready-ahead bound, which is what lets the next synthesis
                // start while the previous sentence is still playing.
                kickPlayback();
                kickSynthesis();
                maybeFinish();
            });
    }

    /**
     * Playback lane. Starts playback of exactly the nextPlaySeq sentence
     * when it is ready and no playback is in flight. Never awaits synthesis.
     * @returns {void}
     */
    function kickPlayback() {
        if (settled) return;
        if (playbackFlight) return;
        if (!ready.has(nextPlaySeq)) {
            maybeFinish();
            return;
        }

        const item = ready.get(nextPlaySeq);
        ready.delete(nextPlaySeq);
        const localGeneration = generation;
        const token = playTokenCounter;
        playTokenCounter += 1;
        const seq = nextPlaySeq;
        playbackFlight = { seq: seq, generation: localGeneration, token: token };

        const onEnded = () => {
            // Stale callback (cancel/failure changed the generation, or this
            // flight is no longer the current one): ignore. It must never
            // advance nextPlaySeq or start new audio.
            if (settled || generation !== localGeneration
                || !playbackFlight || playbackFlight.token !== token) {
                return;
            }
            playbackFlight = null;
            nextPlaySeq += 1;
            kickPlayback();
            kickSynthesis();
            maybeFinish();
        };

        // playBlob resolves only after Audio.play() has successfully started.
        // Completion is NOT represented by that promise — it comes only from
        // onEnded. The call itself is synchronous so a synchronous throw
        // becomes a current-generation failure instead of escaping.
        let startPromise;
        try {
            startPromise = playback.playBlob(item.blob, onEnded);
        } catch (error) {
            failTurn(error);
            return;
        }
        Promise.resolve(startPromise)
            .then(() => {
                if (settled || generation !== localGeneration
                    || !playbackFlight || playbackFlight.token !== token) {
                    return;
                }
                if (!firstAudioStarted) {
                    firstAudioStarted = true;
                    if (onFirstAudioStart) onFirstAudioStart();
                }
            })
            .catch((error) => {
                if (settled || generation !== localGeneration
                    || !playbackFlight || playbackFlight.token !== token) {
                    return;
                }
                failTurn(error);
            });
    }


    /**
     * Natural turn completion. Allowed only when input is closed, at least
     * one sentence was streamed, and every piece of pipeline work has
     * drained. While input is open, an empty pipeline is NOT completion —
     * the LLM may simply be between sentences. A zero-sentence (no-work)
     * turn also never completes here: the app decides between a silent
     * zero-work legacy handoff (handoffToLegacy) and cancel().
     * @returns {void}
     */
    function maybeFinish() {
        if (settled) return;
        if (!inputClosed) return;
        if (sentenceCount === 0) return;
        if (pendingSynthesis.length > 0) return;
        if (synthesisFlight) return;
        if (ready.size > 0) return;
        if (playbackFlight) return;
        if (nextPlaySeq !== nextSeq) return;
        settle({ ok: true, stopped: false });
    }

    /**
     * Invalidates every part of the turn: pending text, ready Blobs,
     * in-flight synthesis (aborted), current playback (stopped), and speaker
     * state. Stale async callbacks from the aborted generation are dropped by
     * their generation guards.
     * @returns {void}
     */
    function teardown() {
        pendingSynthesis.length = 0;
        ready.clear();
        if (synthesisFlight) {
            synthesisFlight.controller.abort();
            synthesisFlight = null;
        }
        playbackFlight = null;
        // The playback controller fires its armed onEnded for this stop; the
        // session ignores it because the generation already changed.
        playback.stop();
        splitter = null;
        currentVoice = '';
        speakerOpen = false;
    }

    /**
     * Settles the turn exactly once (natural completion, cancel, or failure
     * all funnel through here).
     * @param {{ ok: boolean, stopped: boolean, reason?: unknown, error?: unknown }} result
     * @returns {void}
     */
    function settle(result) {
        if (settled) return;
        settled = true;
        inputClosed = true;
        teardown();
        if (onTurnEnd) onTurnEnd(result);
    }

    /**
     * Fails the turn on a current-generation synthesis or playback error.
     * Exactly-once via the settled guard; no legacy fallback is possible
     * afterwards because the session is settled.
     * @param {unknown} error
     * @returns {void}
     */
    function failTurn(error) {
        if (settled) return;
        generation += 1;
        settle({ ok: false, stopped: false, error: error });
    }

    /**
     * Cancels the turn (user Stop, toggle off, conversation switch, stream
     * error). Idempotent; settles exactly once with stopped: true.
     * @param {unknown} [reason]
     * @returns {void}
     */
    function cancel(reason) {
        if (settled) return;
        generation += 1;
        settle({ ok: false, stopped: true, reason: reason });
    }


    /**
     * Opens a speaker (raw speaker_start). Defensively flushes a still-open
     * previous speaker first so its tail is never lost or mis-attributed.
     * A voiceless speaker is open but produces no synthesis work.
     * @param {string} voice
     * @returns {void}
     */
    function startSpeaker(voice) {
        if (settled || inputClosed) return;
        if (speakerOpen) endSpeaker();
        splitter = createSentenceSplitter();
        currentVoice = voice || '';
        speakerOpen = true;
    }

    /**
     * Feeds raw delta text (NOT accumulated message text) to the open
     * speaker's splitter. Every emitted sentence is enqueued immediately.
     * @param {string} text
     * @returns {void}
     */
    function feed(text) {
        if (settled || inputClosed || !speakerOpen || currentVoice === '') return;
        if (typeof text !== 'string') return;
        const sentences = splitter.feed(text);
        for (const sentence of sentences) {
            enqueueSentence(sentence, currentVoice);
        }
    }

    /**
     * Closes the open speaker (raw speaker_end). Idempotent. Flushes the
     * speaker's unterminated tail immediately, using the PREVIOUS speaker's
     * voice — never the next speaker's.
     * @returns {void}
     */
    function endSpeaker() {
        if (settled || inputClosed || !speakerOpen) return;
        const voice = currentVoice;
        const activeSplitter = splitter;
        splitter = null;
        currentVoice = '';
        speakerOpen = false;
        if (voice !== '' && activeSplitter) {
            const tails = activeSplitter.finish();
            for (const sentence of tails) {
                enqueueSentence(sentence, voice);
            }
        }
    }

    /**
     * Marks the input stream complete (final done). Idempotent. Closes any
     * open speaker, then lets the pipeline drain; a turn with sentences
     * settles naturally once all queued sentences have finished playing.
     * A zero-sentence turn instead stays open for handoffToLegacy()/cancel().
     * @returns {{ sentenceCount: number, firstAudioStarted: boolean }}
     *   Synchronous summary for app-level fallback decisions.
     */
    function finishInput() {
        if (!settled) {
            if (speakerOpen) endSpeaker();
            inputClosed = true;
            kickPlayback();
            kickSynthesis();
            maybeFinish();
        }
        return {
            sentenceCount: sentenceCount,
            firstAudioStarted: firstAudioStarted,
        };
    }

    /**
     * Zero-work legacy handoff. Succeeds only when the streaming session has
     * produced no synthesis/playback work that could duplicate speech:
     * input closed, zero sentences ever enqueued, no first audio, and no
     * pending pipeline state. On success it silently settles the session
     * WITHOUT calling onTurnEnd, so the app may run its existing
     * full-response TTS path unchanged. Once any sentence was enqueued this
     * permanently returns false (duplicate-speech firewall).
     * @returns {boolean} true when the app may fall back to legacy TTS.
     */
    function handoffToLegacy() {
        if (settled || !inputClosed) return false;
        if (sentenceCount !== 0 || firstAudioStarted) return false;
        if (pendingSynthesis.length > 0 || synthesisFlight
            || ready.size > 0 || playbackFlight) {
            return false;
        }
        settled = true;
        inputClosed = true;
        splitter = null;
        currentVoice = '';
        speakerOpen = false;
        return true;
    }

    return {
        startSpeaker: startSpeaker,
        feed: feed,
        endSpeaker: endSpeaker,
        finishInput: finishInput,
        cancel: cancel,
        handoffToLegacy: handoffToLegacy,
        get sentenceCount() {
            return sentenceCount;
        },
        get firstAudioStarted() {
            return firstAudioStarted;
        },
        // The session is active until it settles (completion, cancel,
        // failure) or is abandoned by a successful zero-work handoff.
        get active() {
            return !settled;
        },
    };
}
