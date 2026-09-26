// ─── OpenParlor browser application ─────────────────────────────────────────────
// Split from openparlor.js in STAB-007. Runs only in a browser context; the
// entry module (openparlor.js) imports it for its side effects.

import { formatRelativeTime, normalizeServiceError } from './ui.js';

export function validateConversationTitle(title) {
    if (typeof title !== 'string') return { valid: false, title: '', error: 'Title is required.' };
    const trimmed = title.trim();
    if (!trimmed) return { valid: false, title: '', error: 'Title cannot be empty.' };
    if (trimmed.length > 200) return { valid: false, title: '', error: 'Title must be 200 characters or fewer.' };
    return { valid: true, title: trimmed, error: '' };
}

export function createScrollScheduler(rafFn) {
    let scheduled = false;
    let callback = null;
    return {
        schedule(fn) {
            callback = fn;
            if (!scheduled) {
                scheduled = true;
                rafFn(() => {
                    scheduled = false;
                    const cb = callback;
                    callback = null;
                    if (cb) cb();
                });
            }
        },
    };
}

export function normalizeSidebarCollapsed(value) {
    return value === true || value === 'true';
}

export function createSidebarState(storage, keys) {
    function get(side) {
        try {
            return normalizeSidebarCollapsed(storage.getItem(keys[side]));
        } catch {
            return false;
        }
    }
    function set(side, collapsed) {
        try {
            storage.setItem(keys[side], collapsed ? 'true' : 'false');
        } catch {
            // storage unavailable
        }
    }
    return { get, set };
}

export function shouldShowMemorySection({ hasConversation, hasCharacter, memoryCount }) {
    return hasConversation && hasCharacter && memoryCount > 0;
}

export function createMemoryRefreshGuard() {
    // Generation 0 is the "no refresh in flight" sentinel: begin() issues
    // 1-based generations, and isCurrent must never accept the sentinel.
    let generation = 0;
    return {
        begin() {
            return ++generation;
        },
        isCurrent(gen) {
            return gen > 0 && gen === generation;
        },
    };
}

export const STREAMING_TURN_MODES = Object.freeze({
    UNDECIDED: 'undecided',
    STREAMING: 'streaming',
    LEGACY: 'legacy',
    FAILED: 'failed',
    STOPPED: 'stopped',
    COMPLETE: 'complete',
});

/**
 * Per-turn streaming TTS state machine (VOICE-002 Step 2C).
 *
 * Wraps exactly one streaming TTS session (created via deps.createSession,
 * which must return a createStreamingTtsSession surface) across one
 * assistant turn and makes the streaming-vs-legacy TTS decision exactly
 * once, at the first speaker_start. The decision is final: later
 * speaker_start records only route that speaker's voice, and stream errors,
 * done, toggles, or conversation changes can never restart streaming or
 * resurrect a settled session. The only streaming -> legacy transition is a
 * successful zero-work handoff at the final done; once any sentence was
 * streamed, the legacy full-response TTS path is forbidden for the turn.
 *
 * Identity safety: the session callbacks (onFirstAudioStart/onTurnEnd)
 * re-check deps.isCurrent() and the captured session instance before
 * applying app-level effects, so a stale turn can never move the Hands-Free
 * state or the turn timer of a newer turn.
 *
 * @param {{
 *   isCurrent: () => boolean,
 *   isEligible: () => boolean,
 *   resolveVoice: (characterId: string) => string,
 *   createSession: (hooks: {
 *     onFirstAudioStart: () => void,
 *     onTurnEnd: (result: object) => void,
 *   }) => object,
 *   onFirstAudio: () => void,
 *   onTurnSettled: (state: object, result: object) => void,
 * }} deps
 *   isCurrent: whether the identity captured at send time (conversation id
 *     + selection epoch) still matches the app's current identity.
 *   isEligible: whether streaming is allowed at decision time: auto-speak or
 *     voice mode enabled, recorder not recording, no pending recording
 *     interruption, and the stream has not already errored.
 *   resolveVoice: maps a speaker_start character id to its TTS voice (''
 *     when the character has none).
 *   createSession: creates the turn's streaming session; the returned object
 *     must expose the createStreamingTtsSession surface (startSpeaker,
 *     feed, endSpeaker, finishInput, cancel, handoffToLegacy).
 *   onFirstAudio: app-level effect for the first REAL audio of this turn
 *     (mark TTS ready, Hands-Free WAITING -> SPEAKING).
 *   onTurnSettled: app-level effect once this turn's audio has ended
 *     (completion, failure, or explicit cancel): mark speaking end when
 *     first audio started, otherwise complete a still-waiting response.
 *     The factory passes its own state so the app can read
 *     firstAudioStarted.
 * @returns {{
 *   get mode(): string,
 *   get firstAudioStarted(): boolean,
 *   onSpeakerStart: (characterId: string) => void,
 *   onDelta: (text: string) => void,
 *   onSpeakerEnd: () => void,
 *   onStreamError: (reason?: string) => void,
 *   onDone: () => { runLegacy: boolean, ttsHandled: boolean },
 *   cancel: (reason: string) => void,
 * }}
 */
export function createStreamingTurnState(deps) {
    let mode = STREAMING_TURN_MODES.UNDECIDED;
    let session = null;
    let firstAudioStarted = false;
    let doneHandled = false;

    const state = {
        get mode() { return mode; },
        get firstAudioStarted() { return firstAudioStarted; },
    };

    // Applies the app-level settle effect only while this turn's identity is
    // still the app's current identity.
    function settleEffects(result) {
        if (deps.isCurrent()) deps.onTurnSettled(state, result);
    }

    function onSpeakerStart(characterId) {
        if (mode === STREAMING_TURN_MODES.STREAMING) {
            // Decision is final: only route this speaker's voice. Never
            // create a second session or re-decide.
            if (session) session.startSpeaker(deps.resolveVoice(characterId));
            return;
        }
        if (mode !== STREAMING_TURN_MODES.UNDECIDED) return; // terminal
        if (deps.isCurrent() && deps.isEligible()) {
            mode = STREAMING_TURN_MODES.STREAMING;
            const created = deps.createSession({
                onFirstAudioStart: () => {
                    if (!deps.isCurrent() || session !== created) return;
                    firstAudioStarted = true;
                    deps.onFirstAudio();
                },
                onTurnEnd: (result) => {
                    if (!deps.isCurrent() || session !== created) return;
                    if (result.stopped) return; // settles via cancel()/onStreamError()
                    session = null;
                    mode = result.ok ? STREAMING_TURN_MODES.COMPLETE : STREAMING_TURN_MODES.FAILED;
                    deps.onTurnSettled(state, result);
                },
            });
            session = created;
            created.startSpeaker(deps.resolveVoice(characterId));
        } else {
            // Ineligible or stale identity at the first speaker_start: the
            // existing legacy full-response path is the only permitted
            // source of audio for this turn.
            mode = STREAMING_TURN_MODES.LEGACY;
        }
    }

    function onDelta(text) {
        // Raw incremental delta text, never the accumulated message content.
        if (mode === STREAMING_TURN_MODES.STREAMING && session) session.feed(text);
    }

    function onSpeakerEnd() {
        if (mode === STREAMING_TURN_MODES.STREAMING && session) session.endSpeaker();
    }

    // Abnormal input termination (stream error record, or the reader ended
    // without a done record). Cancels the session and settles the
    // app-level effects; a turn that already settled is untouched, and no
    // legacy fallback is ever run afterwards.
    function onStreamError(reason) {
        if (mode !== STREAMING_TURN_MODES.STREAMING || !session) return;
        mode = STREAMING_TURN_MODES.FAILED;
        const current = session;
        session = null;
        current.cancel(reason || 'stream-error');
        settleEffects({
            ok: false,
            stopped: true,
            reason: reason || 'stream-error',
            firstAudioStarted: firstAudioStarted,
        });
    }

    function onDone() {
        if (doneHandled) return { runLegacy: false, ttsHandled: true };
        doneHandled = true;
        if (mode === STREAMING_TURN_MODES.STREAMING && session) {
            const current = session;
            const summary = current.finishInput();
            if (summary.sentenceCount > 0) {
                // At least one streamed sentence: this turn's audio is owned
                // by the streaming session until it settles. Legacy TTS is
                // forbidden; ttsHandled keeps the app from treating the turn
                // as a no-speak response (Hands-Free stays WAITING until the
                // first real audio, then SPEAKING until the last audio ends).
                return { runLegacy: false, ttsHandled: true };
            }
            if (current.handoffToLegacy()) {
                // Zero-work handoff: the session produced no synthesis or
                // playback work, so the legacy full-response path may run
                // unchanged (it re-checks every app-level condition).
                mode = STREAMING_TURN_MODES.LEGACY;
                session = null;
                return { runLegacy: true, ttsHandled: false };
            }
            // Unreachable in practice (a zero-sentence session always
            // handoffs cleanly); fail closed: speak nothing, no legacy.
            mode = STREAMING_TURN_MODES.FAILED;
            session = null;
            current.cancel('stream-handoff-failed');
            settleEffects({
                ok: false,
                stopped: true,
                reason: 'stream-handoff-failed',
                firstAudioStarted: firstAudioStarted,
            });
            return { runLegacy: false, ttsHandled: true };
        }
        // Legacy/undecided: the existing shouldAutoSpeak check applies.
        if (mode === STREAMING_TURN_MODES.FAILED || mode === STREAMING_TURN_MODES.STOPPED) {
            // The turn's audio outcome already settled via onStreamError()
            // or cancel(); mark it handled so the app's no-speak tail does
            // not re-apply the settle effects. Never run legacy.
            return { runLegacy: false, ttsHandled: true };
        }
        return {
            runLegacy: mode === STREAMING_TURN_MODES.LEGACY || mode === STREAMING_TURN_MODES.UNDECIDED,
            ttsHandled: false,
        };
    }

    // External invalidation: conversation switch/delete, new conversation,
    // voice toggle off. Cancels the session and settles the app-level
    // effects only while this turn's identity is still the current one.
    function cancel(reason) {
        if (mode === STREAMING_TURN_MODES.STREAMING && session) {
            mode = STREAMING_TURN_MODES.STOPPED;
            const current = session;
            session = null;
            current.cancel(reason);
            settleEffects({
                ok: false,
                stopped: true,
                reason: reason,
                firstAudioStarted: firstAudioStarted,
            });
            return;
        }
        if (mode === STREAMING_TURN_MODES.UNDECIDED || mode === STREAMING_TURN_MODES.LEGACY) {
            mode = STREAMING_TURN_MODES.STOPPED;
        }
    }

    return Object.assign(state, {
        onSpeakerStart: onSpeakerStart,
        onDelta: onDelta,
        onSpeakerEnd: onSpeakerEnd,
        onStreamError: onStreamError,
        onDone: onDone,
        cancel: cancel,
    });
}

/**
 * Single app-level TTS ownership teardown (VOICE-002 Step 2D).
 *
 * Every path that takes audio ownership (manual Play/Replay/Stop, new send,
 * conversation switch/delete/new, toggle-off, recording start) must route
 * through stopActiveTts() so the teardown ordering is identical everywhere:
 *
 *   1. cancelStreamingTurn(reason)
 *      The streaming owner is made terminal first. Its internal teardown
 *      stops the playback it owns and settles Hands-Free for the dead turn
 *      (exactly once, via its own settle path).
 *   2. groupQueue.clear()
 *      The legacy queue is invalidated: pending items never play, and the
 *      in-flight playAll loop exits on wake WITHOUT onAllDone (its
 *      generation changed), so a stale queue can never end a newer
 *      Hands-Free speaking phase.
 *   3. playback.stop()
 *      Deliberately AFTER clear(): stop() FIRES the currently armed
 *      completion callback, which is what deterministically settles an
 *      active legacy playItem promise. Without it, a replacement play()
 *      would suppress that callback via cancelCurrent() and the playItem
 *      promise (and its queue loop) would never settle. A second stop()
 *      after a streaming cancel is a no-op (no armed callback left).
 *   4. timer.cancel()
 *      onAllDone cannot cancel the per-turn timer (step 2 invalidated the
 *      loop), so teardown owns it; idempotent.
 *   5. options.markSpeakingEnd
 *      Explicit Hands-Free speaking end for owners whose normal
 *      completion is skipped by the generation bump (legacy queue, manual
 *      playback). No-op when Hands-Free is not in SPEAKING, so callers may
 *      pass it unconditionally where the streaming owner has already
 *      settled (new send). Callers that hand Hands-Free to invalidate()
 *      (conversation switch/delete/new) omit it.
 *   6. refreshButtons()
 *
 * The whole sequence is synchronous: by the time a caller starts new
 * playback afterwards, every old owner is terminal and no old callback can
 * touch the new owner's playback or Hands-Free state.
 *
 * @param {{
 *   cancelStreamingTurn: (reason: string) => void,
 *   groupQueue: { clear: () => void },
 *   playback: { stop: () => void },
 *   timer?: { cancel: () => void },
 *   markSpeakingEnd?: () => void,
 *   refreshButtons?: () => void,
 * }} deps
 * @returns {{ stopActiveTts: (reason: string, options?: { markSpeakingEnd?: boolean }) => void }}
 */
export function createTtsOwnershipController(deps) {
    function stopActiveTts(reason, options = {}) {
        deps.cancelStreamingTurn(reason);
        deps.groupQueue.clear();
        deps.playback.stop();
        if (deps.timer) deps.timer.cancel();
        if (options.markSpeakingEnd && deps.markSpeakingEnd) deps.markSpeakingEnd();
        if (deps.refreshButtons) deps.refreshButtons();
    }
    return { stopActiveTts };
}

/**
 * Estimated response-start progress state machine (DOGFOOD-007), extracted
 * from the browser bootstrap (VOICE-002 Step 2E) so the Stop/abort
 * cancellation contract is deterministically testable.
 *
 * pendingStart tracks the speaker currently awaiting its first visible
 * token; the window is per-speaker so sequential group replies never share
 * or morph state. Every effect is identity-guarded by the message object,
 * so a stale stop/complete/tick from an older send cannot touch a newer
 * send's indicator (Step 2E).
 *
 * All timing is injected — the clock (now) and the 200 ms tick interval
 * (setIntervalFn/clearIntervalFn) — so tests run against a fake clock and
 * never touch real timers.
 *
 * @param {{
 *   estimator: { observe: (ms: number) => void, expectedMs: () => number },
 *   now: () => number,
 *   setIntervalFn: (fn: () => void, ms: number) => unknown,
 *   clearIntervalFn: (id: unknown) => void,
 *   onTick: (label: string) => void,
 *   onCompleted: (name: string, bubble: unknown) => void,
 * }} deps
 */
export function createResponseStartProgress(deps) {
    let pendingStart = null;
    let timerId = null;

    function tick() {
        if (!pendingStart) {
            stop();
            return;
        }
        deps.onTick(formatResponseStartProgress(
            pendingStart.name,
            estimateResponseStartProgress({
                elapsedMs: deps.now() - pendingStart.startedAt,
                expectedMs: deps.estimator.expectedMs(),
            }),
        ));
    }

    function start(msg, name) {
        pendingStart = { msg, startedAt: deps.now(), name: name || '' };
        if (timerId === null) {
            timerId = deps.setIntervalFn(tick, 200);
        }
    }

    function stop() {
        pendingStart = null;
        if (timerId !== null) {
            deps.clearIntervalFn(timerId);
            timerId = null;
        }
    }

    // Fold the observed first-token latency into the browser-local estimate
    // and remove the indicator; the delta path only updates the bubble, so
    // the speaker label is fixed up by the caller (onCompleted).
    function complete(msg, bubble) {
        if (!pendingStart || pendingStart.msg !== msg) return;
        const name = pendingStart.name;
        deps.estimator.observe(deps.now() - pendingStart.startedAt);
        stop();
        if (name && bubble) deps.onCompleted(name, bubble);
    }

    function isPending(msg) {
        return pendingStart !== null && pendingStart.msg === msg;
    }

    // Attach the speaker identity to an already-running window (the first
    // speaker_start assigns the name to the message that has waited since
    // send time).
    function setName(name) {
        if (pendingStart) pendingStart.name = name || '';
    }

    return {
        start,
        stop,
        complete,
        tick,
        isPending,
        setName,
        get pending() { return pendingStart; },
    };
}

/**
 * VOICE-002 Step 2E: the user-Stop teardown sequence, extracted from the
 * browser bootstrap so it is deterministically testable against the real
 * streaming turn, legacy queue, playback, and Hands-Free pieces.
 *
 * Order matters (Step 2D ownership contract + Step 2E Stop semantics):
 * 1. stopActiveTts('user-stop', { markSpeakingEnd: true }) — the single
 *    ownership teardown: makes the streaming turn terminal (no synthesis
 *    restart, no stale callback), clears the legacy queue, stops the
 *    active playback, cancels the turn timer, and ends a legacy/manual
 *    owner's SPEAKING phase (guarded no-op when the streaming owner
 *    already settled it or Hands-Free is not SPEAKING).
 * 2. Hands-Free WAITING settle: the ownership path settles SPEAKING, but
 *    an undecided turn (no speaker_start yet) leaves Hands-Free in
 *    WAITING — markResponseComplete moves it to LISTENING (guarded no-op
 *    otherwise, including Hands-Free off or already settled).
 * 3. stopProgress(): the response-start window is terminal now; its timer
 *    must not tick into a newer turn.
 *
 * The caller (createActiveSendController.stopUser) runs this BEFORE the
 * abort fires, so TTS ownership is released before the network stream is
 * aborted and no stray callback can run after it.
 *
 * @param {{
 *   stopActiveTts: (reason: string, options?: object) => void,
 *   getHandsfree: () => ({ state: string, markResponseComplete: () => void } | null),
 *   stopProgress: () => void,
 * }} deps
 * @returns {() => void}
 */
export function createStopTurnEffects(deps) {
    return function stopTurnEffects() {
        deps.stopActiveTts('user-stop', { markSpeakingEnd: true });
        const hf = deps.getHandsfree();
        if (hf && hf.state === HANDSFREE_STATES.WAITING) {
            hf.markResponseComplete();
        }
        deps.stopProgress();
    };
}

/**
 * VOICE-002 Step 2E: active-send identity for the chat send pipeline.
 *
 * Every send captures its own identity object
 * ({ token, abortController, stoppedByUser }). All post-completion effects
 * (the send's catch/finally) check the CAPTURED identity against this
 * controller instead of a module-level flag, so a send superseded by a
 * user Stop or a conversation delete can never mutate a newer send's
 * button state, progress, or Hands-Free state.
 *
 * The Send button is never disabled while a turn is in flight: it shows
 * "Stop" and stays enabled so the user can abort (Step 2E). Only
 * conversation availability (updateChatHeader) controls the disabled
 * state.
 *
 * @param {{
 *   button: { textContent: string, disabled: boolean, setAttribute: (k: string, v: string) => void },
 *   onStop?: (send: object) => void,
 * }} deps
 */
export function createActiveSendController(deps) {
    let sendToken = 0;
    let current = null;

    function updateButton() {
        const stopping = current !== null;
        deps.button.textContent = stopping ? 'Stop' : 'Send';
        deps.button.setAttribute('aria-label', stopping
            ? 'Stop generating response'
            : 'Send message');
    }

    /**
     * Register a new send and return its captured identity. Its
     * abortController is the only controller that may be aborted for this
     * send. Supersedes any previous identity: the old send's catch/finally
     * become stale from this point on.
     */
    function begin() {
        sendToken += 1;
        current = {
            token: sendToken,
            abortController: new AbortController(),
            stoppedByUser: false,
        };
        updateButton();
        return current;
    }

    function isSending() {
        return current !== null;
    }

    /**
     * User Stop (idempotent). Marks the send stopped BEFORE the teardown
     * and abort so the send's own catch classifies the AbortError as an
     * expected user stop (partial text preserved, no error path). Runs the
     * app teardown (deps.onStop) before the abort fires (Step 2D order),
     * then returns the app to the idle state. A second call — including a
     * call when no turn is active — is a no-op returning null.
     */
    function stopUser() {
        const send = current;
        if (!send || send.stoppedByUser) return null;
        send.stoppedByUser = true;
        if (deps.onStop) deps.onStop(send);
        send.abortController.abort();
        current = null;
        updateButton();
        return send;
    }

    /**
     * External abort (conversation delete): aborts the active send
     * WITHOUT marking it as a user stop — its catch keeps the existing
     * external-abort behavior — and clears the identity.
     */
    function abortExternal() {
        const send = current;
        if (!send) return null;
        current = null;
        updateButton();
        send.abortController.abort();
        return send;
    }

    /**
     * Identity-safe settle for a send's finally: clears the identity only
     * if this send is still the current one. Returns true when this send
     * settled the state; false when it had been superseded.
     */
    function settle(send) {
        if (!send || send !== current) return false;
        current = null;
        updateButton();
        return true;
    }

    return {
        begin,
        stopUser,
        abortExternal,
        settle,
        isSending,
        get active() { return current; },
    };
}

/**
 * VOICE-002 Step 2E: classification of a send's stream completion error,
 * extracted from the browser bootstrap so the stale-send isolation contract
 * is deterministically testable.
 *
 * The decision is made from the CAPTURED send identity plus the error:
 * - AbortError + send.stoppedByUser → expected user Stop. The stop path
 *   already tore down TTS, cancelled progress, settled Hands-Free, and
 *   released the identity; the live bubble keeps the partial assistant
 *   text. Nothing else may run: no error state, no double-complete, and
 *   no stream-error call on a turn that may already belong to a newer
 *   send.
 * - AbortError without a user stop → external abort (conversation
 *   delete). The delete path owns the teardown and already superseded
 *   this identity; the stale send returns quietly.
 * - Anything else → real failure. The stream ended abnormally, so the
 *   captured turn is settled as an error (a streaming session with open
 *   input would otherwise hang — Step 2C), and ONLY the still-current
 *   send may turn the failure into an error state: a superseded send
 *   must not overwrite its preserved partial text or a newer turn's UI.
 *
 * The abort branches never touch the streaming turn at all: by the time
 * an aborted send's rejection lands, a newer send may have already begun
 * and re-assigned the turn, and a stale error call would corrupt it.
 *
 * @param {{
 *   settle: (send: object) => boolean,
 *   onStreamException: () => void,
 *   onUserStop: (send: object) => void,
 *   onError: (send: object) => void,
 * }} deps
 */
export function createSendCompletionHandler(deps) {
    function handleCatch(send, error) {
        const aborted = Boolean(error && error.name === 'AbortError');
        if (aborted) {
            if (send.stoppedByUser) deps.onUserStop(send);
            // External abort (conversation delete): the delete path owns
            // the teardown and already superseded this identity.
            return;
        }
        // A thrown read error ends the stream abnormally; settle the
        // CAPTURED turn (Step 2C). Only reachable for a send that was
        // never superseded, so the captured turn is still this send's.
        deps.onStreamException();
        if (deps.settle(send)) {
            deps.onError(send);
        }
    }

    function handleFinally(send) {
        // Identity-safe settle: only the still-current send may clear the
        // sending state and return the button to "Send".
        deps.settle(send);
    }

    return { handleCatch, handleFinally };
}

import { createNdjsonParser, createStreamMessageCollector, normalizeConversation, resolveMessageCharacterId } from './conversations.js';
import { createStreamingTtsSession } from './streaming-tts.js';
import { buildCardExportFilename, normalizeCharacter, sanitizeCharacterInput, validateCharacterForm } from './characters.js';
import { normalizeMemory, normalizeMemorySource, validateMemoryForm } from './memory.js';
import { createFirstTokenEstimator, estimateResponseStartProgress, formatResponseStartProgress } from './progress.js';
import { fetchDeferredPrerequisite, normalizeHealthStatus, normalizeModelStatus } from './settings.js';
import {
    autoSpeakToggleDescription,
    createGroupPlaybackQueue,
    createPlaybackController,
    createRecorderController,
    createTranscriptionController,
    createVoiceTurnTimer,
    normalizeAutoSpeakState,
    normalizeTtsVoices,
    normalizeVoiceModeState,
    shouldAutoSendTranscription,
    shouldAutoSpeak,
    voiceModeToggleDescription,
} from './audio.js';
import {
    HANDSFREE_STATES,
    HANDSFREE_WORKLET_SOURCE,
    createHandsFreeController,
    handsFreeStatusText,
    normalizeHandsFreePreference,
} from './handsfree.js';
// ─── Browser application ─────────────────────────────────────────────────────

if (typeof document !== 'undefined') {
    const conversationList = document.getElementById('conversationList');
    const characterList = document.getElementById('characterList');
    const characterSelect = document.getElementById('characterSelect');
    const newChatButton = document.getElementById('newChatButton');
    const messagesEl = document.getElementById('messages');
    const chatTitle = document.getElementById('chatTitle');
    const chatSubtitle = document.getElementById('chatSubtitle');
    const messageInput = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');
    const characterForm = document.getElementById('characterForm');
    const charNameInput = document.getElementById('charNameInput');
    const charAvatarInput = document.getElementById('charAvatarInput');
    const charAvatarFileInput = document.getElementById('charAvatarFileInput');
    const charFormError = document.getElementById('charFormError');
    const charFormSave = document.getElementById('charFormSave');
    const charFormCancel = document.getElementById('charFormCancel');
    const charVoiceSelect = document.getElementById('charVoiceSelect');
    const newCharacterButton = document.getElementById('newCharacterButton');
    const importCharacterButton = document.getElementById('importCharacterButton');
    const importCharacterFileInput = document.getElementById('importCharacterFileInput');
    const charExportButton = document.getElementById('charExportButton');
    const modelStatusDot = document.getElementById('modelStatusDot');
    const modelStatusBody = document.getElementById('modelStatusBody');
    const autoSpeakButton = document.getElementById('autoSpeakButton');
    const voiceModeButton = document.getElementById('voiceModeButton');
    const handsFreeButton = document.getElementById('handsFreeButton');
    const handsFreeStatus = document.getElementById('handsFreeStatus');

    // ── Sidebar collapse/restore ──────────────────────────────────────────

    const appEl = document.querySelector('.app');
    const sidebarLeft = document.getElementById('sidebarLeft');
    const sidebarRight = document.getElementById('sidebarRight');
    const collapseLeftBtn = document.getElementById('collapseLeftBtn');
    const collapseRightBtn = document.getElementById('collapseRightBtn');
    const restoreLeftBtn = document.getElementById('restoreLeftBtn');
    const restoreRightBtn = document.getElementById('restoreRightBtn');

    const sidebarState = createSidebarState(localStorage, {
        left: 'openparlor-sidebar-left-collapsed',
        right: 'openparlor-sidebar-right-collapsed',
    });

    function applySidebarState(side, collapsed) {
        const sidebar = side === 'left' ? sidebarLeft : sidebarRight;
        const appClass = side === 'left' ? 'left-collapsed' : 'right-collapsed';
        const collapseBtn = side === 'left' ? collapseLeftBtn : collapseRightBtn;
        const restoreBtn = side === 'left' ? restoreLeftBtn : restoreRightBtn;
        if (sidebar) sidebar.classList.toggle('collapsed', collapsed);
        if (appEl) appEl.classList.toggle(appClass, collapsed);
        if (collapseBtn) collapseBtn.setAttribute('aria-expanded', String(!collapsed));
        if (restoreBtn) restoreBtn.setAttribute('aria-expanded', String(collapsed));
    }

    function toggleSidebar(side) {
        const appClass = side === 'left' ? 'left-collapsed' : 'right-collapsed';
        const collapsed = !(appEl && appEl.classList.contains(appClass));
        sidebarState.set(side, collapsed);
        applySidebarState(side, collapsed);
    }

    // Restore persisted state
    applySidebarState('left', sidebarState.get('left'));
    applySidebarState('right', sidebarState.get('right'));

    if (collapseLeftBtn) collapseLeftBtn.addEventListener('click', () => toggleSidebar('left'));
    if (collapseRightBtn) collapseRightBtn.addEventListener('click', () => toggleSidebar('right'));
    if (restoreLeftBtn) restoreLeftBtn.addEventListener('click', () => toggleSidebar('left'));
    if (restoreRightBtn) restoreRightBtn.addEventListener('click', () => toggleSidebar('right'));

    let characters = [];
    let allCharacters = [];
    let conversations = [];
    let currentConversation = null;
    let currentMessages = [];
    let editingCharacterId = null;
    let ttsVoices = { voices: [], available: false };
    const playback = createPlaybackController({ getCsrfToken });
    let ttsMarkedForTurn = false;
    const groupQueue = createGroupPlaybackQueue({
        playItem: (text, voice) => {
            return new Promise((resolve, reject) => {
                let settled = false;
                const onEnd = () => {
                    if (!settled) { settled = true; resolve(); }
                };
                // The completion callback is armed inside play() only after
                // any previous playback has been torn down, so it cannot be
                // consumed by the internal teardown and the item resolves
                // only when this item's audio actually ends (or is
                // explicitly stopped). A superseded start resolves null
                // instead; the item settles then so the queue can drain.
                playback.play(text, voice, onEnd).then((url) => {
                    if (!ttsMarkedForTurn) {
                        ttsMarkedForTurn = true;
                        voiceTurnTimer.markTtsReady();
                    }
                    if (url === null) onEnd();
                }).catch((e) => {
                    if (!settled) { settled = true; reject(e); }
                });
            });
        },
        onAllDone: () => {
            if (isDev) voiceTurnTimer.log();
            voiceTurnTimer.cancel();
            if (handsfree) handsfree.markSpeakingEnd();
        },
    });
    // Synthesize a single streamed sentence directly (VOICE-002 Step 2C).
    // Unlike the group-queue path, each sentence is an independent request:
    // the streaming session owns sequencing, so there is no shared queue
    // state to coordinate here.
    function synthesizeStreamingSentence({ text, voice, signal }) {
        return getCsrfToken().then((token) => {
            return fetch('/api/openparlor/tts/synthesize', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                },
                body: JSON.stringify({ text: text, voice: voice }),
                signal: signal,
            });
        }).then((response) => {
            if (!response.ok) {
                throw normalizeServiceError('Error synthesizing speech', response);
            }
            return response.blob();
        }).then((blob) => {
            if (!blob || blob.size === 0) {
                throw new Error('Empty TTS response');
            }
            return blob;
        });
    }
    let selectionEpoch = 0;
    // Hands-free controller: declared before the group queue so playback
    // completion can resume listening; instantiated near the recorder
    // controls once all pipeline pieces exist.
    let handsfree = null;
    let recordingInterruptionPending = false;
    // Active per-turn streaming TTS state (VOICE-002 Step 2C). Re-created on
    // every send; at most one instance exists at a time because sending is
    // disabled while a turn is in flight.
    let streamingTurn = null;
    const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const voiceTurnTimer = createVoiceTurnTimer();

    // Single TTS ownership teardown path (VOICE-002 Step 2D). Every handler
    // that takes audio ownership routes through stopActiveTts() so the
    // teardown ordering is identical everywhere (see its doc comment).
    const ttsOwnership = createTtsOwnershipController({
        cancelStreamingTurn: (reason) => {
            if (streamingTurn) streamingTurn.cancel(reason);
        },
        groupQueue: groupQueue,
        playback: playback,
        timer: voiceTurnTimer,
        markSpeakingEnd: () => {
            if (handsfree) handsfree.markSpeakingEnd();
        },
        refreshButtons: updatePlaybackButtons,
    });

    // Estimated response-start progress (DOGFOOD-007). responseProgress
    // tracks the speaker currently awaiting its first visible token; the
    // window is per-speaker so sequential group replies never share or
    // morph state. Timing is injected so the Stop/abort cancellation
    // contract is deterministically testable (VOICE-002 Step 2E).
    const firstTokenEstimator = createFirstTokenEstimator();
    const responseProgress = createResponseStartProgress({
        estimator: firstTokenEstimator,
        now: () => performance.now(),
        setIntervalFn: (fn, ms) => setInterval(fn, ms),
        clearIntervalFn: (id) => clearInterval(id),
        onTick: (label) => {
            const speaker = messagesEl.querySelector('.speaker-progress');
            if (speaker) speaker.textContent = label;
        },
        onCompleted: (name, bubble) => {
            const content = bubble.closest('.message-content');
            const speaker = content ? content.querySelector('.speaker-progress') : null;
            if (speaker) speaker.textContent = name;
        },
    });

    // VOICE-002 Step 2E: active-send identity + the Send/Stop button. The
    // Send button doubles as the Stop control while a turn is in flight
    // (it stays enabled); every catch/finally effect is identity-guarded
    // through the captured send object, so a stopped or deleted turn can
    // never mutate a newer send's UI.
    const activeSendController = createActiveSendController({
        button: sendButton,
        onStop: createStopTurnEffects({
            stopActiveTts: (reason, options) => ttsOwnership.stopActiveTts(reason, options),
            getHandsfree: () => handsfree,
            stopProgress: () => responseProgress.stop(),
        }),
    });

    // The user-visible Stop (VOICE-002 Step 2E). Idempotent and safe to
    // call when no turn is active: it stops exactly the active send — its
    // stream, its TTS (streaming session, legacy queue, or manual
    // playback), its response-start progress — and settles Hands-Free
    // back to listening, preserving any partial assistant text.
    function stopActiveTurn() {
        activeSendController.stopUser();
    }

    // VOICE-003: a confirmed Hands-Free barge-in reuses that EXACT Stop path.
    // There is deliberately no second cancellation system: the interrupt is a
    // user pressing Stop while the AI talks, so it must abort the model
    // stream, make the streaming turn terminal, stop the active audio, cancel
    // the response-start window, and preserve the partial assistant text —
    // all the things a second implementation could get subtly wrong.
    function onHandsFreeBargeIn() {
        if (!activeSendController.stopUser()) {
            // No model turn is in flight (e.g. manual Play/Replay speech, or
            // TTS that outlived its stream). Release the audio owner and the
            // response-start window through the same helpers Stop uses.
            ttsOwnership.stopActiveTts('barge-in', { markSpeakingEnd: true });
            responseProgress.stop();
        }
        // The controller has already moved to HEARING, which started the voice
        // turn timer for the interrupting utterance — but the Stop teardown
        // above just cancelled it with the interrupted turn. The interrupt is
        // a turn in its own right, so reopen its window after the teardown
        // instead of leaving the diagnostics silently dead.
        voiceTurnTimer.start();
    }

    // ── Auto-speak state ───────────────────────────────────────────────────

    function getAutoSpeakState(conversationId) {
        if (!conversationId) return false;
        try {
            return normalizeAutoSpeakState(localStorage.getItem('openparlor-auto-speak-' + conversationId));
        } catch {
            return false;
        }
    }

    function setAutoSpeakState(conversationId, enabled) {
        if (!conversationId) return;
        try {
            localStorage.setItem('openparlor-auto-speak-' + conversationId, enabled ? 'true' : 'false');
        } catch {
            // storage unavailable
        }
    }

    // ── Toggle explanations ─────────────────────────────────────────────────
    // "Auto-speak" and "Voice" read as two speech switches, but they control
    // different things, and users reasonably read "Voice: Off" as "stop
    // talking". The wording lives in audio.js so it is unit-testable; this
    // only applies it. No behavior change — the wiring is unchanged.
    function applyToggleDescription(button, description) {
        button.title = description;
        button.setAttribute('aria-label', description);
    }

    function updateAutoSpeakButton() {
        if (!autoSpeakButton) return;
        if (!currentConversation) {
            autoSpeakButton.hidden = true;
            return;
        }
        autoSpeakButton.hidden = false;
        const enabled = getAutoSpeakState(currentConversation.id);
        autoSpeakButton.setAttribute('aria-pressed', String(enabled));
        autoSpeakButton.textContent = enabled ? 'Auto-speak: On' : 'Auto-speak: Off';
        applyToggleDescription(autoSpeakButton, autoSpeakToggleDescription(enabled));
    }

    // ── Voice mode state ───────────────────────────────────────────────────

    function getVoiceModeState(conversationId) {
        if (!conversationId) return false;
        try {
            return normalizeVoiceModeState(localStorage.getItem('openparlor-voice-mode-' + conversationId));
        } catch {
            return false;
        }
    }

    function setVoiceModeState(conversationId, enabled) {
        if (!conversationId) return;
        try {
            localStorage.setItem('openparlor-voice-mode-' + conversationId, enabled ? 'true' : 'false');
        } catch {
            // storage unavailable
        }
    }

    function updateVoiceModeButton() {
        if (!voiceModeButton) return;
        if (!currentConversation) {
            voiceModeButton.hidden = true;
            return;
        }
        voiceModeButton.hidden = false;
        const enabled = getVoiceModeState(currentConversation.id);
        voiceModeButton.setAttribute('aria-pressed', String(enabled));
        voiceModeButton.textContent = enabled ? 'Voice: On' : 'Voice: Off';
        applyToggleDescription(voiceModeButton, voiceModeToggleDescription(enabled));
    }

    // ── Rendering helpers ──────────────────────────────────────────────────

    function renderState(container, type, text) {
        container.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'state-' + type;
        el.textContent = text;
        container.appendChild(el);
    }

    function renderConversations() {
        conversationList.innerHTML = '';

        if (conversations.length === 0) {
            renderState(conversationList, 'empty', 'No conversations yet.');
            return;
        }

        for (const conv of conversations) {
            const char = findCharacter(conv.characterId);
            const item = document.createElement('div');
            item.className = 'conversation' + (currentConversation && currentConversation.id === conv.id ? ' active' : '');
            item.dataset.id = conv.id;

            const titleEl = document.createElement('div');
            titleEl.className = 'conversation-title';
            titleEl.textContent = conv.title;

            const metaEl = document.createElement('div');
            metaEl.className = 'conversation-preview';
            const parts = [];
            if (char) parts.push(char.name);
            const time = formatRelativeTime(conv.updatedAt);
            if (time) parts.push(time);
            metaEl.textContent = parts.join(' · ');

            const actionsEl = document.createElement('div');
            actionsEl.className = 'conversation-actions';

            const renameBtn = document.createElement('button');
            renameBtn.className = 'conversation-rename-btn';
            renameBtn.type = 'button';
            renameBtn.title = 'Rename conversation';
            renameBtn.setAttribute('aria-label', 'Rename ' + conv.title);
            renameBtn.textContent = '✎';
            renameBtn.addEventListener('click', e => {
                e.stopPropagation();
                handleRenameConversation(conv, item);
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'conversation-delete-btn';
            deleteBtn.type = 'button';
            deleteBtn.title = 'Delete conversation';
            deleteBtn.setAttribute('aria-label', 'Delete ' + conv.title);
            deleteBtn.textContent = '✕';
            deleteBtn.addEventListener('click', e => {
                e.stopPropagation();
                handleDeleteConversation(conv);
            });

            actionsEl.append(renameBtn, deleteBtn);
            item.append(titleEl, metaEl, actionsEl);
            item.addEventListener('click', () => selectConversation(conv.id));
            conversationList.appendChild(item);
        }
    }

    function renderCharacters() {
        const selectedCharacterId = characterSelect.value;
        characterList.innerHTML = '';
        characterSelect.innerHTML = '<option value="">Select a character…</option>';

        if (allCharacters.length === 0) {
            renderState(characterList, 'empty', 'No characters found.');
            newChatButton.disabled = true;
            characterSelect.disabled = true;
            return;
        }

        for (const char of allCharacters) {
            // Sidebar card (archived characters remain visible to their owner
            // but are dimmed and badged)
            const card = document.createElement('div');
            card.className = 'character-card' + (char.archived ? ' archived' : '');
            card.dataset.id = char.id;

            const avatar = document.createElement('div');
            avatar.className = 'avatar';
            if (char.avatarUrl) {
                const img = document.createElement('img');
                img.src = char.avatarUrl;
                img.alt = char.name;
                img.className = 'avatar-img';
                avatar.appendChild(img);
            } else {
                avatar.textContent = char.name.charAt(0).toUpperCase();
            }

            const info = document.createElement('div');
            info.className = 'character-info';
            const nameEl = document.createElement('div');
            nameEl.className = 'character-name';
            nameEl.textContent = char.name;
            info.appendChild(nameEl);

            if (char.archived) {
                const badge = document.createElement('span');
                badge.className = 'character-archived-badge';
                badge.textContent = 'Archived';
                info.appendChild(badge);
            }

            card.append(avatar, info);
            card.addEventListener('click', () => showCharacterForm(char));

            const deleteButton = document.createElement('button');
            deleteButton.className = 'character-delete-btn';
            deleteButton.type = 'button';
            deleteButton.title = char.archived ? 'Delete archived character' : 'Delete character';
            deleteButton.setAttribute('aria-label', `${char.archived ? 'Delete archived character ' : 'Delete '}${char.name}`);
            deleteButton.textContent = '✕';
            deleteButton.addEventListener('click', event => {
                event.stopPropagation();
                handleDeleteCharacter(char);
            });
            card.appendChild(deleteButton);
            characterList.appendChild(card);

            // Select option — active characters only (normal new-chat selection)
            if (!char.archived) {
                const opt = document.createElement('option');
                opt.value = char.id;
                opt.textContent = char.name;
                characterSelect.appendChild(opt);
            }
        }

        // Make the primary action usable immediately when characters exist.
        // Preserve an explicit selection when re-rendering after edits.
        if (characters.length === 0) {
            // Only archived characters exist: nothing is selectable for a new chat.
            characterSelect.value = '';
            characterSelect.disabled = true;
            newChatButton.disabled = true;
            return;
        }
        characterSelect.value = characters.some(char => char.id === selectedCharacterId)
            ? selectedCharacterId
            : characters[0].id;
        characterSelect.disabled = false;
        newChatButton.disabled = false;
    }

    function showCharacterForm(character) {
        editingCharacterId = character ? character.id : null;
        charNameInput.value = character ? character.name : '';
        charAvatarInput.value = character ? character.avatarUrl : '';
        charAvatarFileInput.value = '';
        populateVoiceSelect(character ? character.ttsVoice : '');
        charFormError.hidden = true;
        charFormError.textContent = '';
        charExportButton.hidden = !character;
        characterForm.hidden = false;
        charNameInput.focus();
    }

    function populateVoiceSelect(selectedVoice) {
        charVoiceSelect.innerHTML = '<option value="">No voice</option>';
        for (const voice of ttsVoices.voices) {
            const opt = document.createElement('option');
            opt.value = voice;
            opt.textContent = voice;
            charVoiceSelect.appendChild(opt);
        }
        charVoiceSelect.value = selectedVoice || '';
    }

    function hideCharacterForm() {
        editingCharacterId = null;
        characterForm.hidden = true;
        charNameInput.value = '';
        charAvatarInput.value = '';
        charAvatarFileInput.value = '';
        charVoiceSelect.value = '';
        charFormError.hidden = true;
        charFormError.textContent = '';
        charExportButton.hidden = true;
    }

    function showFormError(message) {
        charFormError.textContent = message;
        charFormError.hidden = false;
    }

    function renderMessages() {
        messagesEl.innerHTML = '';

        if (!currentConversation) {
            renderState(messagesEl, 'empty', 'No conversation selected.');
            return;
        }

        if (currentMessages.length === 0) {
            renderState(messagesEl, 'empty', 'No messages yet. Say hello!');
            return;
        }

        for (const msg of currentMessages) {
            const isUser = msg.role === 'user';
            const messageEl = document.createElement('div');
            messageEl.className = 'message' + (isUser ? ' user-message' : '');

            // Neutral pending response: before speaker_start the stream
            // placeholder has no identity; do not attribute it to the
            // primary character.
            const hasIdentity = !isUser && (
                (typeof msg.character_id === 'string' && msg.character_id) ||
                (typeof msg.participant_id === 'string' && msg.participant_id)
            );
            if (!isUser && !hasIdentity) {
                const pendingContent = document.createElement('div');
                pendingContent.className = 'message-content';
                const pendingSpeaker = document.createElement('div');
                pendingSpeaker.className = 'speaker';
                pendingSpeaker.textContent = 'Preparing response…';
                const pendingBubble = document.createElement('div');
                pendingBubble.className = 'bubble';
                pendingBubble.textContent = msg.content || 'Preparing response…';
                pendingContent.append(pendingSpeaker, pendingBubble);
                messageEl.appendChild(pendingContent);
                messagesEl.appendChild(messageEl);
                continue;
            }

            const msgCharId = !isUser ? resolveMessageCharacterId(msg, currentConversation) : currentConversation.characterId;
            const char = findCharacter(msgCharId);
            const charName = char ? char.name : 'Assistant';

            if (!isUser) {
                const avatar = document.createElement('div');
                avatar.className = 'avatar';
                if (char && char.avatarUrl) {
                    const img = document.createElement('img');
                    img.src = char.avatarUrl;
                    img.alt = charName;
                    img.className = 'avatar-img';
                    avatar.appendChild(img);
                } else {
                    avatar.textContent = charName.charAt(0).toUpperCase();
                }
                messageEl.appendChild(avatar);
            }

            const content = document.createElement('div');
            content.className = 'message-content';

            const speakerEl = document.createElement('div');
            speakerEl.className = 'speaker';
            // Estimated time-to-first-token for the speaker currently
            // awaiting its first visible token (DOGFOOD-007).
            if (!isUser && !msg.content && responseProgress.isPending(msg)) {
                speakerEl.className = 'speaker speaker-progress';
                const startedAt = responseProgress.pending.startedAt;
                speakerEl.textContent = formatResponseStartProgress(
                    charName,
                    estimateResponseStartProgress({
                        elapsedMs: performance.now() - startedAt,
                        expectedMs: firstTokenEstimator.expectedMs(),
                    }),
                );
            } else {
                speakerEl.textContent = isUser ? 'You' : charName;
            }

            const bubble = document.createElement('div');
            bubble.className = 'bubble';
            bubble.textContent = msg.content;

            content.append(speakerEl, bubble);

            if (!isUser && msg.content) {
                const actions = document.createElement('div');
                actions.className = 'message-actions';

                const voice = char ? char.ttsVoice : '';

                const playBtn = document.createElement('button');
                playBtn.className = 'play-btn';
                playBtn.setAttribute('aria-label', 'Play message');
                playBtn.textContent = '▶';
                playBtn.addEventListener('click', async () => {
                    const hf = handsfree;
                    const willSpeak = !!(hf && hf.state !== HANDSFREE_STATES.OFF);
                    // The completion callback is armed inside play() only
                    // after any previous playback has been stopped, and
                    // fires exactly once — on natural end or an explicit
                    // stop. A failed start rejects without firing it; the
                    // catch below ends the speaking phase instead.
                    const endSpeaking = () => {
                        if (willSpeak && hf) hf.markSpeakingEnd();
                    };
                    try {
                        // Ownership teardown (Step 2D): the previous owner
                        // (streaming session, legacy queue, or manual
                        // playback) is fully terminal before the manual
                        // playback arms its own completion callback.
                        ttsOwnership.stopActiveTts('manual-playback');
                        if (willSpeak) hf.markSpeakingStart();
                        await playback.play(msg.content, voice, endSpeaking);
                        updatePlaybackButtons();
                    } catch {
                        endSpeaking();
                        updatePlaybackButtons();
                    }
                });

                const stopBtn = document.createElement('button');
                stopBtn.className = 'stop-btn';
                stopBtn.setAttribute('aria-label', 'Stop playback');
                stopBtn.textContent = '■';
                stopBtn.addEventListener('click', () => {
                    // AUDIO ownership Stop only (Step 2D): terminates
                    // whichever TTS owner is active (streaming session,
                    // legacy queue, or manual playback). The visible
                    // LLM-generation Stop remains Step 2E.
                    ttsOwnership.stopActiveTts('playback-stop', { markSpeakingEnd: true });
                });

                const replayBtn = document.createElement('button');
                replayBtn.className = 'replay-btn';
                replayBtn.setAttribute('aria-label', 'Replay message');
                replayBtn.textContent = '↺';
                replayBtn.addEventListener('click', async () => {
                    const hf = handsfree;
                    const willSpeak = !!(hf && hf.state !== HANDSFREE_STATES.OFF);
                    // Same completion-callback contract as Play: armed only
                    // after the previous playback is stopped, fires exactly
                    // once, and a failed start is handled by the catch.
                    const endSpeaking = () => {
                        if (willSpeak && hf) hf.markSpeakingEnd();
                    };
                    try {
                        // Same ownership teardown as Play (Step 2D): the
                        // previous owner is fully terminal before the
                        // replay arms its own completion callback.
                        ttsOwnership.stopActiveTts('manual-playback');
                        if (willSpeak) hf.markSpeakingStart();
                        await playback.replay(msg.content, voice, endSpeaking);
                        updatePlaybackButtons();
                    } catch {
                        endSpeaking();
                        updatePlaybackButtons();
                    }
                });

                actions.append(playBtn, stopBtn, replayBtn);
                content.appendChild(actions);
            }

            messageEl.appendChild(content);
            messagesEl.appendChild(messageEl);
        }

        scrollMessages();
    }

    function updatePlaybackButtons() {
        const buttons = messagesEl.querySelectorAll('.message-actions');
        for (const actions of buttons) {
            const playBtn = actions.querySelector('.play-btn');
            const stopBtn = actions.querySelector('.stop-btn');
            const replayBtn = actions.querySelector('.replay-btn');
            if (playBtn) playBtn.disabled = playback.isPlaying;
            if (stopBtn) stopBtn.disabled = !playback.isPlaying;
            if (replayBtn) replayBtn.disabled = playback.isPlaying;
        }
    }

    function updateChatHeader() {
        if (!currentConversation) {
            chatTitle.textContent = 'OpenParlor';
            chatSubtitle.textContent = 'Select a conversation to begin';
            messageInput.disabled = true;
            sendButton.disabled = true;
            updateAutoSpeakButton();
            updateVoiceModeButton();
            updateHandsFreeUI();
            renderParticipants();
            return;
        }
        const char = findCharacter(currentConversation.characterId);
        chatTitle.textContent = currentConversation.title;
        chatSubtitle.textContent = char ? char.name : '';
        messageInput.disabled = false;
        sendButton.disabled = false;
        updateAutoSpeakButton();
        updateVoiceModeButton();
        updateHandsFreeUI();
        renderParticipants();
    }

    const scrollScheduler = createScrollScheduler((fn) => requestAnimationFrame(fn));

    function scrollMessages() {
        scrollScheduler.schedule(() => {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        });
    }

    // ── Participants ───────────────────────────────────────────────────────

    const participantsBar = document.getElementById('participantsBar');
    const participantsList = document.getElementById('participantsList');
    const addParticipantButton = document.getElementById('addParticipantButton');
    const addParticipantSelect = document.getElementById('addParticipantSelect');

    function renderParticipants() {
        if (!participantsBar) return;
        if (!currentConversation) {
            participantsBar.hidden = true;
            return;
        }
        participantsBar.hidden = false;
        participantsList.innerHTML = '';

        const participants = currentConversation.participants || [];
        for (const p of participants) {
            const char = findCharacter(p.characterId);
            const chip = document.createElement('span');
            chip.className = 'participant-chip';
            chip.textContent = char ? char.name : p.characterId;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'participant-remove';
            removeBtn.setAttribute('aria-label', 'Remove ' + (char ? char.name : p.characterId));
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', async () => {
                const remaining = participants.filter(x => x.characterId !== p.characterId);
                if (remaining.length === 0) return;
                await updateParticipants(remaining.map(x => x.characterId));
            });

            chip.appendChild(removeBtn);
            participantsList.appendChild(chip);
        }

        // Populate add-select with characters not already participants
        if (addParticipantSelect) {
            addParticipantSelect.innerHTML = '<option value="">Add character…</option>';
            const participantIds = new Set(participants.map(p => p.characterId));
            for (const char of characters) {
                if (participantIds.has(char.id)) continue;
                const opt = document.createElement('option');
                opt.value = char.id;
                opt.textContent = char.name;
                addParticipantSelect.appendChild(opt);
            }
            addParticipantSelect.disabled = participants.length >= 10;
        }
    }

    async function updateParticipants(characterIds) {
        try {
            const token = await getCsrfToken();
            const res = await fetch('/api/openparlor/conversations/' + encodeURIComponent(currentConversation.id) + '/participants', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                },
                body: JSON.stringify({ character_ids: characterIds }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(normalizeServiceError(err, 'Failed to update participants'));
            }
            const updated = normalizeConversation(await res.json());
            currentConversation = updated;
            renderParticipants();
            renderConversations();
        } catch (e) {
            renderState(messagesEl, 'error', e.message || 'Failed to update participants.');
        }
    }

    if (addParticipantButton) {
        addParticipantButton.addEventListener('click', () => {
            if (!addParticipantSelect || !addParticipantSelect.value) return;
            const currentIds = (currentConversation.participants || []).map(p => p.characterId);
            const newIds = [...currentIds, addParticipantSelect.value];
            updateParticipants(newIds);
        });
    }

    // ── API helpers ────────────────────────────────────────────────────────

    async function fetchModelStatus() {
        try {
            const res = await fetch('/api/openparlor/model-status');
            if (!res.ok) throw new Error('Failed to load model status');
            const data = await res.json();
            return normalizeModelStatus(data);
        } catch {
            return normalizeModelStatus(null);
        }
    }

    function renderModelStatus(status) {
        if (!modelStatusDot || !modelStatusBody) return;

        modelStatusDot.className = 'model-status-dot' + (status.connected ? ' connected' : ' unavailable');

        modelStatusBody.innerHTML = '';

        if (!status.provider && !status.model) {
            const el = document.createElement('div');
            el.className = 'model-status-unavailable';
            el.textContent = 'No model configured';
            modelStatusBody.appendChild(el);
            return;
        }

        if (status.model) {
            const modelEl = document.createElement('div');
            modelEl.className = 'model-status-model';
            modelEl.textContent = status.model;
            modelStatusBody.appendChild(modelEl);
        }

        if (status.endpointLabel) {
            const endpointEl = document.createElement('div');
            endpointEl.className = 'model-status-endpoint';
            endpointEl.textContent = status.endpointLabel;
            modelStatusBody.appendChild(endpointEl);
        }

        if (status.connected && status.models.length > 0) {
            const modelsEl = document.createElement('div');
            modelsEl.className = 'model-status-models';
            modelsEl.textContent = status.models.slice(0, 5).join(', ');
            if (status.models.length > 5) {
                modelsEl.textContent += ` +${status.models.length - 5} more`;
            }
            modelStatusBody.appendChild(modelsEl);
        } else if (!status.connected) {
            const unavailableEl = document.createElement('div');
            unavailableEl.className = 'model-status-unavailable';
            unavailableEl.textContent = 'Unavailable';
            modelStatusBody.appendChild(unavailableEl);
        }
    }

    // ── Health status ──────────────────────────────────────────────────────

    const healthStatusList = document.getElementById('healthStatusList');
    const prerequisiteStatus = document.getElementById('prerequisiteStatus');

    async function fetchHealthStatus() {
        try {
            const res = await fetch('/api/openparlor/health');
            if (!res.ok) throw new Error('Failed to load health status');
            const data = await res.json();
            return normalizeHealthStatus(data);
        } catch {
            return normalizeHealthStatus(null);
        }
    }

    function renderHealthStatus(status) {
        if (!healthStatusList) return;
        healthStatusList.innerHTML = '';

        const services = [
            { key: 'model', name: 'Model' },
            { key: 'tts', name: 'TTS' },
            { key: 'stt', name: 'STT' },
        ];

        for (const svc of services) {
            const item = document.createElement('div');
            item.className = 'health-item';

            const service = status[svc.key];
            const available = service ? service.available : false;

            item.setAttribute('role', 'status');
            item.setAttribute('aria-label', svc.name + (available ? ' available' : ' unavailable'));

            const dot = document.createElement('span');
            dot.className = 'health-dot' + (available ? ' available' : ' unavailable');
            dot.setAttribute('aria-hidden', 'true');

            const label = document.createElement('span');
            label.className = 'health-label';
            label.textContent = svc.name + (available ? '' : ' — unavailable');

            item.append(dot, label);
            healthStatusList.appendChild(item);
        }
    }

    function renderPrerequisiteStatus(status) {
        if (!prerequisiteStatus) return;
        prerequisiteStatus.innerHTML = '';
        if (status.deferred) {
            const el = document.createElement('div');
            el.className = 'prerequisite-deferred';
            el.textContent = status.label;
            prerequisiteStatus.appendChild(el);
        }
    }

    async function getCsrfToken() {
        const res = await fetch('/csrf-token');
        if (!res.ok) throw new Error('Unable to get CSRF token');
        const data = await res.json();
        if (typeof data.token !== 'string' || !data.token) {
            throw new Error('Invalid CSRF token');
        }
        return data.token;
    }

    async function fetchCharacters() {
        const res = await fetch('/api/openparlor/characters?include_archived=true');
        if (!res.ok) throw new Error('Failed to load characters');
        const data = await res.json();
        allCharacters = (Array.isArray(data) ? data : []).map(normalizeCharacter).filter(Boolean);
        // Archived characters stay resolvable for history but are hidden from
        // normal new-chat selection.
        characters = allCharacters.filter(c => !c.archived);
    }

    // Resolves a character by id across active and archived characters, so
    // historical conversations and memories of archived characters keep
    // rendering names and avatars.
    function findCharacter(id) {
        return allCharacters.find(c => c.id === id);
    }

    async function fetchConversations() {
        const res = await fetch('/api/openparlor/conversations');
        if (!res.ok) throw new Error('Failed to load conversations');
        const data = await res.json();
        conversations = (Array.isArray(data) ? data : []).map(normalizeConversation).filter(Boolean);
        conversations.sort((a, b) => {
            const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return tb - ta;
        });
    }

    async function fetchConversation(id) {
        const res = await fetch('/api/openparlor/conversations/' + encodeURIComponent(id));
        if (!res.ok) throw new Error('Failed to load conversation');
        const data = await res.json();
        currentConversation = normalizeConversation(data);
        currentMessages = Array.isArray(data.messages) ? data.messages : [];
    }

    async function createConversation(characterId, title) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/conversations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
            },
            body: JSON.stringify({ character_id: characterId, title: title }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to create conversation'));
        }
        return normalizeConversation(await res.json());
    }

    async function createCharacter(name, avatarUrl, ttsVoice) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/characters', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
            },
            body: JSON.stringify({ name, avatar_url: avatarUrl, tts_voice: ttsVoice }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to create character'));
        }
        return normalizeCharacter(await res.json());
    }

    async function updateCharacter(id, name, avatarUrl, ttsVoice) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/characters/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
            },
            body: JSON.stringify({ name, avatar_url: avatarUrl, tts_voice: ttsVoice }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to update character'));
        }
        return normalizeCharacter(await res.json());
    }

    async function uploadCharacterAvatar(file) {
        if (!file) return '';
        const allowedTypes = new Map([
            ['image/bmp', 'bmp'],
            ['image/png', 'png'],
            ['image/jpeg', 'jpg'],
            ['image/webp', 'webp'],
            ['image/gif', 'gif'],
            ['image/jfif', 'jfif'],
        ]);
        const format = allowedTypes.get(file.type);
        if (!format) throw new Error('Choose a PNG, JPEG, GIF, WebP, BMP, or JFIF image.');
        if (file.size > 5 * 1024 * 1024) throw new Error('Avatar images must be 5 MB or smaller.');

        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Unable to read the avatar image.'));
            reader.readAsDataURL(file);
        });
        const comma = dataUrl.indexOf(',');
        if (comma < 0) throw new Error('Invalid avatar image data.');

        const token = await getCsrfToken();
        const res = await fetch('/api/images/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({
                image: dataUrl.slice(comma + 1),
                format,
                filename: `openparlor-avatar-${Date.now()}.${format}`,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to upload avatar'));
        }
        const data = await res.json();
        if (typeof data.path !== 'string' || !data.path.startsWith('/')) throw new Error('Avatar upload returned an invalid path.');
        return data.path;
    }

    async function deleteCharacter(id) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/characters/' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': token },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to delete character'));
        }
        // 204 → hard delete. 200 + JSON → character was archived (still referenced).
        if (res.status === 204) return { deleted: true, archived: false, character: null };
        const data = await res.json().catch(() => ({}));
        return {
            deleted: false,
            archived: data.archived === true,
            character: data.character ? normalizeCharacter(data.character) : null,
        };
    }

    async function renameConversation(id, title) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/conversations/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token,
            },
            body: JSON.stringify({ title }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to rename conversation'));
        }
        return normalizeConversation(await res.json());
    }

    async function deleteConversation(id) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/conversations/' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': token },
        });
        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to delete conversation'));
        }
    }

    let characterNoticeTimer = null;
    function showCharacterNotice(text) {
        const existing = characterList.querySelector('.character-notice');
        if (existing) existing.remove();
        if (characterNoticeTimer) {
            clearTimeout(characterNoticeTimer);
            characterNoticeTimer = null;
        }
        const notice = document.createElement('div');
        notice.className = 'character-notice';
        notice.textContent = text;
        characterList.prepend(notice);
        characterNoticeTimer = setTimeout(() => {
            notice.remove();
            characterNoticeTimer = null;
        }, 6000);
    }

    // ── Character card import/export ───────────────────────────────────────

    const MAX_CARD_IMPORT_BYTES = 16 * 1024 * 1024;

    function isImportableCardFile(file) {
        if (!file || typeof file.size !== 'number' || file.size === 0) return false;
        if (file.size > MAX_CARD_IMPORT_BYTES) return false;
        const name = (file.name || '').toLowerCase();
        if (name.endsWith('.json') || name.endsWith('.png')) return true;
        return file.type === 'application/json' || file.type === 'image/png';
    }

    async function importCharacterCard(file) {
        if (!isImportableCardFile(file)) {
            showCharacterNotice('Import failed: choose a character card file (.json or .png) of 16 MB or less.');
            return;
        }
        importCharacterButton.disabled = true;
        try {
            const token = await getCsrfToken();
            const form = new FormData();
            form.append('file', file);
            const res = await fetch('/api/openparlor/characters/import', {
                method: 'POST',
                headers: { 'X-CSRF-Token': token },
                body: form,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(normalizeServiceError(data, 'Failed to import character card'));
            }
            const imported = normalizeCharacter(data);
            if (!imported || !imported.id) throw new Error('Import returned an invalid character');
            allCharacters.push(imported);
            characters.push(imported); // imported characters are active
            renderCharacters();
            showCharacterNotice(`Imported ${imported.name}.`);
        } catch (e) {
            showCharacterNotice('Import failed: ' + (e.message || 'unknown error'));
        } finally {
            importCharacterButton.disabled = false;
        }
    }

    async function exportCharacterCard() {
        if (!editingCharacterId) return;
        const character = findCharacter(editingCharacterId);
        charExportButton.disabled = true;
        try {
            const res = await fetch('/api/openparlor/characters/' + encodeURIComponent(editingCharacterId) + '/export');
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(normalizeServiceError(err, 'Failed to export character card'));
            }
            const blob = await res.blob();
            const filename = buildCardExportFilename(res.headers.get('Content-Disposition'), character ? character.name : '');
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            anchor.rel = 'noopener';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            showFormError(e.message || 'Failed to export character card');
        } finally {
            charExportButton.disabled = false;
        }
    }

    async function fetchTtsVoices() {
        try {
            const res = await fetch('/api/openparlor/tts/voices');
            if (!res.ok) throw new Error('Failed to load TTS voices');
            ttsVoices = normalizeTtsVoices(await res.json());
        } catch {
            ttsVoices = { voices: [], available: false };
        }
    }

    // ── Memory panel ───────────────────────────────────────────────────────

    const memoryPanel = document.getElementById('memoryPanel');
    const memorySection = document.getElementById('memorySection');
    const memoryRefreshGuard = createMemoryRefreshGuard();
    let memories = [];
    let editingMemoryId = null;

    function invalidateMemoryState() {
        memoryRefreshGuard.begin();
        memories = [];
        renderMemoryPanel();
    }


    async function updateMemoryApi(id, body) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/memories/' + encodeURIComponent(id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to update memory'));
        }
        return normalizeMemory(await res.json());
    }

    async function deleteMemoryApi(id) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/memories/' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': token },
        });
        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to delete memory'));
        }
    }

    async function pinMemoryApi(id, pinned) {
        const token = await getCsrfToken();
        const res = await fetch('/api/openparlor/memories/' + encodeURIComponent(id) + '/pin', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({ pinned }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(normalizeServiceError(err, 'Failed to pin memory'));
        }
        return normalizeMemory(await res.json());
    }

    function renderMemoryPanel() {
        if (!memoryPanel) return;

        const visible = shouldShowMemorySection({
            hasConversation: !!currentConversation,
            hasCharacter: !!(currentConversation && currentConversation.characterId),
            memoryCount: memories.length,
        });

        if (memorySection) memorySection.hidden = !visible;
        if (!visible) return;

        memoryPanel.innerHTML = '';

        for (const mem of memories) {
            const row = document.createElement('div');
            row.className = 'memory-row' + (mem.pinned ? ' pinned' : '');
            row.dataset.id = mem.id;

            if (editingMemoryId === mem.id) {
                renderMemoryEditForm(row, mem);
            } else {
                renderMemoryDisplay(row, mem);
            }

            memoryPanel.appendChild(row);
        }
    }

    function renderMemoryDisplay(row, mem) {
        const source = normalizeMemorySource(mem, conversations);

        const contentEl = document.createElement('div');
        contentEl.className = 'memory-content';
        contentEl.textContent = mem.content.length > 120 ? mem.content.slice(0, 120) + '…' : mem.content;

        const metaEl = document.createElement('div');
        metaEl.className = 'memory-meta';

        const typeBadge = document.createElement('span');
        typeBadge.className = 'memory-type memory-type-' + mem.type;
        typeBadge.textContent = mem.type;

        const importanceEl = document.createElement('span');
        importanceEl.className = 'memory-importance';
        importanceEl.textContent = '★'.repeat(Math.round(mem.importance * 4) + 1);

        metaEl.append(typeBadge, importanceEl);

        const sourceEl = document.createElement('div');
        sourceEl.className = 'memory-source';
        sourceEl.textContent = source.label;
        if (!source.available) {
            sourceEl.classList.add('memory-source-unavailable');
        }

        const actionsEl = document.createElement('div');
        actionsEl.className = 'memory-actions';

        const pinBtn = document.createElement('button');
        pinBtn.className = 'memory-action-btn pin-btn' + (mem.pinned ? ' active' : '');
        pinBtn.title = mem.pinned ? 'Unpin' : 'Pin';
        pinBtn.textContent = mem.pinned ? '📌' : '📍';
        pinBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const updated = await pinMemoryApi(mem.id, !mem.pinned);
                const idx = memories.findIndex(m => m.id === mem.id);
                if (idx !== -1) memories[idx] = updated;
                memories.sort((a, b) => {
                    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
                    return b.importance - a.importance;
                });
                renderMemoryPanel();
            } catch { /* silent */ }
        });

        const editBtn = document.createElement('button');
        editBtn.className = 'memory-action-btn edit-btn';
        editBtn.title = 'Edit';
        editBtn.textContent = '✎';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingMemoryId = mem.id;
            renderMemoryPanel();
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'memory-action-btn delete-btn';
        delBtn.title = 'Delete';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                await deleteMemoryApi(mem.id);
                memories = memories.filter(m => m.id !== mem.id);
                renderMemoryPanel();
            } catch { /* silent */ }
        });

        actionsEl.append(pinBtn, editBtn, delBtn);
        row.append(contentEl, metaEl, sourceEl, actionsEl);
    }

    function renderMemoryEditForm(row, mem) {
        const form = document.createElement('div');
        form.className = 'memory-edit-form';

        const textarea = document.createElement('textarea');
        textarea.className = 'memory-edit-content';
        textarea.rows = 3;
        textarea.maxLength = 2000;
        textarea.value = mem.content;
        textarea.placeholder = 'Memory content…';

        const typeSelect = document.createElement('select');
        typeSelect.className = 'memory-edit-type';
        for (const t of ['fact', 'preference', 'event', 'relationship', 'other']) {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            typeSelect.appendChild(opt);
        }
        typeSelect.value = mem.type;

        const importanceInput = document.createElement('input');
        importanceInput.type = 'range';
        importanceInput.className = 'memory-edit-importance';
        importanceInput.min = '0';
        importanceInput.max = '1';
        importanceInput.step = '0.05';
        importanceInput.value = String(mem.importance);

        const importanceLabel = document.createElement('span');
        importanceLabel.className = 'memory-importance-value';
        importanceLabel.textContent = String(mem.importance);
        importanceInput.addEventListener('input', () => {
            importanceLabel.textContent = importanceInput.value;
        });

        const errorEl = document.createElement('div');
        errorEl.className = 'memory-edit-error';
        errorEl.hidden = true;

        const actions = document.createElement('div');
        actions.className = 'memory-edit-actions';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'memory-edit-save';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', async () => {
            const validation = validateMemoryForm({
                content: textarea.value,
                type: typeSelect.value,
                importance: Number(importanceInput.value),
            });
            if (!validation.valid) {
                errorEl.textContent = validation.errors.join(' ');
                errorEl.hidden = false;
                return;
            }
            try {
                saveBtn.disabled = true;
                const updated = await updateMemoryApi(mem.id, {
                    content: validation.content,
                    type: validation.type,
                    importance: validation.importance,
                });
                const idx = memories.findIndex(m => m.id === mem.id);
                if (idx !== -1) memories[idx] = updated;
                editingMemoryId = null;
                renderMemoryPanel();
            } catch (e) {
                errorEl.textContent = e.message || 'Failed to save';
                errorEl.hidden = false;
            } finally {
                saveBtn.disabled = false;
            }
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'memory-edit-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            editingMemoryId = null;
            renderMemoryPanel();
        });

        actions.append(saveBtn, cancelBtn);
        form.append(textarea, typeSelect, importanceInput, importanceLabel, errorEl, actions);
        row.appendChild(form);
    }

    async function refreshMemoryPanel() {
        // Immediately clear visible state so prior-conversation memories
        // cannot linger while the new fetch is in flight.
        memories = [];
        renderMemoryPanel();

        if (!currentConversation || !currentConversation.characterId) return;

        const gen = memoryRefreshGuard.begin();
        const charId = currentConversation.characterId;

        try {
            const res = await fetch('/api/openparlor/memories?character_id=' + encodeURIComponent(charId));
            if (!res.ok) throw new Error('Failed to load memories');
            const data = await res.json();
            // Stale guard: discard if a newer refresh started or conversation changed.
            if (!memoryRefreshGuard.isCurrent(gen)) return;
            if (!currentConversation || currentConversation.characterId !== charId) return;
            memories = (Array.isArray(data) ? data : []).map(normalizeMemory).filter(Boolean);
            memories.sort((a, b) => {
                if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
                return b.importance - a.importance;
            });
        } catch {
            if (!memoryRefreshGuard.isCurrent(gen)) return;
            memories = [];
        }
        renderMemoryPanel();
    }

    // ── Actions ────────────────────────────────────────────────────────────

    async function handleCharacterFormSubmit() {
        const rawName = charNameInput.value;
        const rawAvatar = charAvatarInput.value;

        const validation = validateCharacterForm({ name: rawName });
        if (!validation.valid) {
            showFormError(validation.errors.join(' '));
            return;
        }

        const rawVoice = charVoiceSelect.value;
        const sanitized = sanitizeCharacterInput({ name: rawName, avatar_url: rawAvatar, tts_voice: rawVoice });

        try {
            charFormSave.disabled = true;
            const uploadedAvatarUrl = await uploadCharacterAvatar(charAvatarFileInput.files[0]);
            const avatarUrl = uploadedAvatarUrl || sanitized.avatarUrl;
            let saved;
            if (editingCharacterId) {
                saved = await updateCharacter(editingCharacterId, sanitized.name, avatarUrl, sanitized.ttsVoice);
                // Keep both arrays in sync: cards render from allCharacters,
                // new-chat selection from characters (active only).
                const allIdx = allCharacters.findIndex(c => c.id === saved.id);
                if (allIdx !== -1) allCharacters[allIdx] = saved;
                const idx = characters.findIndex(c => c.id === saved.id);
                if (idx !== -1) characters[idx] = saved;
            } else {
                saved = await createCharacter(sanitized.name, avatarUrl, sanitized.ttsVoice);
                allCharacters.push(saved);
                characters.push(saved); // new characters are active
            }
            hideCharacterForm();
            renderCharacters();
        } catch (e) {
            showFormError(e.message || 'Something went wrong');
        } finally {
            charFormSave.disabled = false;
        }
    }

    function characterHasLocalHistory(characterId) {
        return conversations.some(conv => conv.characterId === characterId
            || (conv.participants || []).some(p => p.characterId === characterId));
    }

    async function handleDeleteCharacter(character) {
        // The server is authoritative: referenced characters are archived
        // (200 + JSON), unreferenced ones are hard-deleted (204). The local
        // history check only tunes the confirmation wording.
        const hasHistory = characterHasLocalHistory(character.id);
        const message = hasHistory
            ? `${character.name} has conversations. Deleting it will archive the character: it will be hidden from new chats, but existing conversations and memories stay intact. Continue?`
            : `Delete ${character.name}? This cannot be undone.`;
        if (!window.confirm(message)) return;
        try {
            const result = await deleteCharacter(character.id);
            if (editingCharacterId === character.id) hideCharacterForm();
            if (result.archived && result.character) {
                // Character was archived: keep it resolvable for history.
                const idx = allCharacters.findIndex(item => item.id === character.id);
                if (idx !== -1) allCharacters[idx] = result.character;
                characters = allCharacters.filter(item => !item.archived);
                renderCharacters();
                renderConversations();
                showCharacterNotice(`${result.character.name} was archived — its conversations and memories are preserved.`);
                return;
            }
            if (result.deleted) {
                allCharacters = allCharacters.filter(item => item.id !== character.id);
                characters = characters.filter(item => item.id !== character.id);
                // A hard delete only happens for unreferenced characters, so no
                // open conversation can reference this id anymore.
                renderCharacters();
                renderConversations();
            }
        } catch (e) {
            showFormError(e.message || 'Failed to delete character');
            characterForm.hidden = false;
        }
    }

    function handleRenameConversation(conv, item) {
        const titleEl = item.querySelector('.conversation-title');
        if (!titleEl) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'conversation-rename-input';
        input.value = conv.title;
        input.maxLength = 200;
        input.setAttribute('aria-label', 'Rename conversation');

        titleEl.replaceWith(input);
        input.focus();
        input.select();

        let settled = false;

        const errorEl = document.createElement('div');
        errorEl.className = 'conversation-rename-error';
        errorEl.hidden = true;
        item.appendChild(errorEl);

        function commit() {
            if (settled) return;
            const validation = validateConversationTitle(input.value);
            if (!validation.valid) {
                errorEl.textContent = validation.error;
                errorEl.hidden = false;
                input.focus();
                return;
            }
            settled = true;
            renameConversation(conv.id, validation.title).then(updated => {
                const idx = conversations.findIndex(c => c.id === conv.id);
                if (idx !== -1) conversations[idx] = updated;
                if (currentConversation && currentConversation.id === conv.id) {
                    currentConversation = updated;
                    updateChatHeader();
                }
                renderConversations();
            }).catch(() => {
                renderConversations();
            });
        }

        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commit();
            } else if (e.key === 'Escape') {
                settled = true;
                renderConversations();
            }
        });
        input.addEventListener('blur', commit);
        input.addEventListener('click', e => e.stopPropagation());
    }

    async function handleDeleteConversation(conv) {
        if (!window.confirm('Delete "' + conv.title + '"? This cannot be undone.')) return;
        const isCurrent = currentConversation && currentConversation.id === conv.id;

        // Neutralize active response UI before awaiting the DELETE fetch so
        // server latency cannot allow an old stream to update the UI.
        if (isCurrent) {
            // VOICE-002 Step 2E: the active send is aborted as an EXTERNAL
            // abort (not a user stop), so its catch keeps the existing
            // external-abort behavior and its identity is superseded — a
            // stale completion can never re-enable the button or touch the
            // new conversation's state.
            activeSendController.abortExternal();
            ttsOwnership.stopActiveTts('conversation-deleted');
            recorder.cancel();
            if (handsfree) handsfree.invalidate();
            sendButton.disabled = true;
            messageInput.disabled = true;
            updatePlaybackButtons();
            updateRecorderUI();
            updateTranscriptionStatus();
            invalidateMemoryState();
            responseProgress.stop();
        }

        try {
            await deleteConversation(conv.id);
            conversations = conversations.filter(c => c.id !== conv.id);

            if (isCurrent) {
                // Clear per-conversation localStorage
                try {
                    localStorage.removeItem('openparlor-auto-speak-' + conv.id);
                    localStorage.removeItem('openparlor-voice-mode-' + conv.id);
                } catch { /* storage unavailable */ }
                // Clear current state
                currentConversation = null;
                currentMessages = [];
                memories = [];

                // Select another conversation or show empty state
                if (conversations.length > 0) {
                    await selectConversation(conversations[0].id);
                } else {
                    renderConversations();
                    renderMessages();
                    updateChatHeader();
                    renderParticipants();
                    renderMemoryPanel();
                }
            } else {
                renderConversations();
            }
        } catch (e) {
            if (isCurrent && currentConversation && currentConversation.id === conv.id) {
                // The delete failed: the conversation still exists and its
                // send identity is already released (VOICE-002 Step 2E), so
                // restore the input UI — the button label is already
                // "Send".
                sendButton.disabled = false;
                messageInput.disabled = false;
                renderMessages();
                updateChatHeader();
            }
        }
    }

    async function selectConversation(id) {
        selectionEpoch++;
        // Full ownership teardown (Step 2C/2D) before the epoch change
        // makes the old turn unresolvable: streaming session, legacy queue,
        // and current audio all terminate against the old identity.
        ttsOwnership.stopActiveTts('conversation-switch');
        responseProgress.stop();
        invalidateMemoryState();
        if (handsfree) handsfree.invalidate();
        try {
            renderState(messagesEl, 'loading', 'Loading…');
            await fetchConversation(id);
            renderConversations();
            renderMessages();
            updateChatHeader();
            refreshMemoryPanel();
        } catch (e) {
            renderState(messagesEl, 'error', 'Failed to load conversation.');
        }
    }

    async function handleNewConversation() {
        const charId = characterSelect.value;
        if (!charId) {
            renderState(messagesEl, 'error', 'Select a character before starting a conversation.');
            return;
        }

        const char = characters.find(c => c.id === charId);
        const title = char ? 'Chat with ' + char.name : 'New conversation';

        try {
            newChatButton.disabled = true;
            invalidateMemoryState();
            responseProgress.stop();
            const conv = await createConversation(charId, title);
            conversations.unshift(conv);
            // Full ownership teardown BEFORE the identity change so the old
            // turn's effects still resolve against the old (current)
            // conversation (Step 2C/2D): streaming session, legacy queue,
            // and current audio must all be terminal before the user enters
            // the new conversation.
            ttsOwnership.stopActiveTts('new-conversation');
            currentConversation = conv;
            if (handsfree) handsfree.invalidate();
            currentMessages = [];
            renderConversations();
            renderMessages();
            updateChatHeader();
            refreshMemoryPanel();
        } catch (e) {
            renderState(messagesEl, 'error', 'Failed to create conversation.');
        } finally {
            newChatButton.disabled = false;
        }
    }

    async function sendMessage() {
        const text = messageInput.value.trim();
        // Returns whether the message was actually dispatched; the
        // hands-free controller treats a skipped send as a send error.
        // While a turn is in flight the Send button shows "Stop" and stays
        // enabled (VOICE-002 Step 2E); a duplicate send is skipped, not
        // queued.
        if (!text || activeSendController.isSending() || !currentConversation) return false;

        const sendConversationId = currentConversation.id;
        const sendEpoch = selectionEpoch;

        // VOICE-002 Step 2E: capture this send's identity BEFORE any async
        // work. Its AbortController is the only one that may abort this
        // send; the catch/finally below check the captured identity against
        // activeSendController, so a superseded (stopped/deleted) send can
        // never mutate a newer send's state. The button now shows "Stop"
        // and stays enabled for the whole turn.
        const send = activeSendController.begin();
        messageInput.value = '';
        voiceTurnTimer.markSendStart();

        // Append user message locally
        currentMessages.push({ role: 'user', content: text });
        renderMessages();

        // Create assistant bubble placeholder; the server's first
        // speaker_start determines the actual character identity before any
        // text is shown.
        const assistantMsgStartIndex = currentMessages.length;
        const streamCollector = createStreamMessageCollector();
        let currentAssistantMsg = streamCollector.getPendingMessage();
        currentMessages.push(currentAssistantMsg);
        renderMessages();
        // The first speaker's pending window starts at send time: that is
        // when waiting for visible text begins (identity may be unknown).
        responseProgress.start(currentAssistantMsg, '');

        let lastBubble = messagesEl.querySelector('.message:last-child .bubble');
        const { abortController } = send;

        // VOICE-002 Step 2C: per-turn streaming TTS state machine. The
        // streaming-vs-legacy decision happens exactly once, at the first
        // speaker_start, and identity guards (conversation id + selection
        // epoch) keep stale turns from affecting the current one. If the
        // previous turn's streaming session is still playing (the stream's
        // done can arrive before its audio finishes), this send takes over
        // audio ownership: cancel the old session so its sentences and
        // callbacks cannot leak into this turn.
        // Per-turn TTS-ready marker: fresh for every turn so that both the
        // streaming first-audio path and the legacy first-item path each get
        // exactly one markTtsReady(), even when the previous turn streamed.
        ttsMarkedForTurn = false;
        let hadStreamError = false;
        // Ownership takeover (Step 2D): the previous turn's audio — streamed,
        // legacy-queued, or manual — is fully terminal before this turn
        // initializes, so no old sentence, queue item, or callback can leak
        // into the new turn. markSpeakingEnd ends an old non-streaming
        // owner's speaking phase (no-op when the streaming owner already
        // settled it or Hands-Free is not SPEAKING).
        ttsOwnership.stopActiveTts('superseded-send', { markSpeakingEnd: true });
        streamingTurn = createStreamingTurnState({
            isCurrent: () => currentConversation
                && currentConversation.id === sendConversationId
                && selectionEpoch === sendEpoch,
            isEligible: () => (getAutoSpeakState(sendConversationId) || getVoiceModeState(sendConversationId))
                && recorder.state !== 'recording'
                && !recordingInterruptionPending
                && !hadStreamError,
            resolveVoice: (characterId) => {
                const char = findCharacter(characterId);
                return char ? char.ttsVoice : '';
            },
            createSession: (hooks) => createStreamingTtsSession({
                playback: playback,
                synthesize: synthesizeStreamingSentence,
                onFirstAudioStart: hooks.onFirstAudioStart,
                onTurnEnd: hooks.onTurnEnd,
            }),
            onFirstAudio: () => {
                if (!ttsMarkedForTurn) {
                    ttsMarkedForTurn = true;
                    voiceTurnTimer.markTtsReady();
                }
                // Hands-Free: the speaking phase starts on the first real
                // audio, never on the NDJSON done record.
                if (handsfree) handsfree.markSpeakingStart();
            },
            onTurnSettled: (state) => {
                if (isDev) voiceTurnTimer.log();
                voiceTurnTimer.cancel();
                if (handsfree) {
                    if (state.firstAudioStarted) handsfree.markSpeakingEnd();
                    else handsfree.markResponseComplete();
                }
            },
        });

        // VOICE-002 Step 2E: this send's completion handler. It captures
        // this send's turn identity so a stale completion (superseded by
        // Stop or delete) is classified from the captured state and can
        // never touch a newer send's turn or UI.
        const sendTurn = streamingTurn;
        const sendCompletion = createSendCompletionHandler({
            settle: (s) => activeSendController.settle(s),
            onStreamException: () => {
                if (sendTurn) sendTurn.onStreamError('stream-exception');
            },
            onUserStop: () => {
                // The stop path already did everything (VOICE-002 Step 2E):
                // TTS teardown, progress cancellation, Hands-Free settle,
                // identity release. The live bubble already shows the
                // partial assistant text — preserve it.
            },
            onError: () => {
                currentAssistantMsg.content = 'Connection error';
                if (lastBubble) lastBubble.textContent = currentAssistantMsg.content;
                renderMessages();
                scrollMessages();
                responseProgress.stop();
                if (isDev) voiceTurnTimer.log();
                voiceTurnTimer.cancel();
                if (handsfree) handsfree.markResponseComplete();
            },
        });

        try {
            const token = await getCsrfToken();
            const response = await fetch('/api/openparlor/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                },
                body: JSON.stringify({
                    // The server owns persisted history; send only the new
                    // user turn so history is never duplicated.
                    messages: [{ role: 'user', content: text }],
                    stream: true,
                    conversation_id: currentConversation.id,
                }),
                signal: abortController.signal,
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                // VOICE-002 Step 2E: only the CURRENT send may turn a
                // non-OK response into an error state — a send superseded
                // by Stop or delete must not overwrite its preserved
                // partial text (or a newer conversation's UI) with an
                // error.
                if (activeSendController.settle(send)) {
                    currentAssistantMsg.content = normalizeServiceError(err, 'Request failed');
                    if (lastBubble) lastBubble.textContent = currentAssistantMsg.content;
                    renderMessages();
                    scrollMessages();
                    responseProgress.stop();
                    if (isDev) voiceTurnTimer.log();
                    voiceTurnTimer.cancel();
                    if (handsfree) handsfree.markResponseComplete();
                }
                return true;
            }

            const parser = createNdjsonParser();
            const reader = response.body.getReader();
            let processedCount = 0;
            let streamDone = false;

            function processNewRecords() {
                for (let i = processedCount; i < parser.records.length; i++) {
                    const record = parser.records[i];
                    if (record.type === 'done') {
                        streamDone = true;
                        break;
                    }
                    const outcome = streamCollector.handleRecord(record);
                    if (outcome === null) continue;
                    if (outcome.type === 'speaker_start') {
                        currentAssistantMsg = outcome.message;
                        // VOICE-002 Step 2C: exactly one decision per turn,
                        // made on the first speaker_start; later speakers
                        // only route their voice to the same session.
                        if (streamingTurn) streamingTurn.onSpeakerStart(outcome.message.character_id || currentConversation.characterId);
                        if (outcome.isNewMessage) {
                            currentMessages.push(currentAssistantMsg);
                            // Each speaker in a sequential reply waits for
                            // its own first token: fresh pending state so
                            // progress never carries across speakers.
                            const speakerChar = findCharacter(resolveMessageCharacterId(currentAssistantMsg, currentConversation));
                            responseProgress.start(currentAssistantMsg, speakerChar ? speakerChar.name : '');
                        } else if (responseProgress.isPending(currentAssistantMsg)) {
                            // First speaker: identity was assigned to the
                            // existing pending message. Keep the window
                            // running from send time; only attach the name.
                            const speakerChar = findCharacter(resolveMessageCharacterId(currentAssistantMsg, currentConversation));
                            responseProgress.setName(speakerChar ? speakerChar.name : '');
                        }
                        // Re-render on every speaker_start so the
                        // server-identified speaker is displayed before the
                        // first text delta of that bubble.
                        renderMessages();
                        lastBubble = messagesEl.querySelector('.message:last-child .bubble');
                    } else if (outcome.type === 'delta') {
                        // Raw incremental delta only — never the accumulated
                        // message content, which would re-split everything.
                        if (streamingTurn) streamingTurn.onDelta(record.text);
                        if (responseProgress.isPending(currentAssistantMsg)) {
                            responseProgress.complete(currentAssistantMsg, lastBubble);
                        }
                        voiceTurnTimer.markFirstToken();
                        if (lastBubble) lastBubble.textContent = currentAssistantMsg.content;
                        scrollMessages();
                    } else if (outcome.type === 'speaker_end') {
                        // Flush this speaker's unterminated tail now, with
                        // this speaker's voice (raw protocol event).
                        if (streamingTurn) streamingTurn.onSpeakerEnd();
                    } else if (outcome.type === 'error') {
                        hadStreamError = true;
                        // A streamed turn has no legacy fallback: cancel the
                        // session and settle the turn's audio effects.
                        if (streamingTurn) streamingTurn.onStreamError('stream-error');
                        responseProgress.stop();
                        if (lastBubble) lastBubble.textContent = currentAssistantMsg.content;
                        scrollMessages();
                    }
                }
                processedCount = parser.records.length;
            }

            while (!streamDone) {
                const { done, value } = await reader.read();
                if (done) break;
                parser.feed(value);
                processNewRecords();
            }

            parser.flush();
            processNewRecords();
            // A stream that ended without a done record is an abnormal
            // termination: a streaming session with open input would
            // otherwise never settle (VOICE-002 Step 2C).
            if (!streamDone && streamingTurn) streamingTurn.onStreamError('stream-ended');
            // Stale-turn guard: a stream that outlives its conversation
            // (switch/new conversation do not abort it) must not settle the
            // current conversation's voice state (VOICE-002 Step 2C).
            const turnIdentityCurrent = sendConversationId !== ''
                && sendConversationId === (currentConversation ? currentConversation.id : '')
                && sendEpoch === selectionEpoch;
            if (streamDone && turnIdentityCurrent) voiceTurnTimer.markStreamComplete();
            // Final full render: the delta path only updates the live bubble
            // text, so completed messages need a re-render to gain their TTS
            // controls and server-identified speaker.
            renderMessages();

            // Auto-speak: the streaming session (decided once at the first
            // speaker_start) owns the turn's audio once any sentence was
            // streamed; otherwise the legacy full-response queue runs
            // unchanged. onDone() makes that handoff decision exactly once
            // per turn (VOICE-002 Step 2C).
            const turnDecision = streamingTurn ? streamingTurn.onDone() : { runLegacy: true, ttsHandled: false };
            let ttsHandled = turnDecision.ttsHandled;
            if (
                turnDecision.runLegacy
                && shouldAutoSpeak({
                    sendConversationId,
                    currentConversationId: currentConversation ? currentConversation.id : '',
                    sendEpoch,
                    selectionEpoch,
                    streamDone,
                    hadStreamError,
                    autoSpeakEnabled: getAutoSpeakState(sendConversationId) || getVoiceModeState(sendConversationId),
                    hasContent: currentMessages.slice(assistantMsgStartIndex).some(m => m.content),
                    recordingActive: recorder.state === 'recording' || recordingInterruptionPending,
                })
            ) {
                ttsMarkedForTurn = false;
                const turnMessages = currentMessages.slice(assistantMsgStartIndex);
                for (const msg of turnMessages) {
                    if (!msg.content) continue;
                    const charId = msg.character_id || currentConversation.characterId;
                    const char = findCharacter(charId);
                    const voice = char ? char.ttsVoice : '';
                    if (voice) {
                        groupQueue.enqueue(msg.content, voice);
                    }
                }
                if (groupQueue.pending > 0) {
                    ttsHandled = true;
                    // Hands-free: one speaking phase covers the whole queued
                    // group reply (all items, including gaps); listening
                    // resumes only when the final item has actually ended
                    // (groupQueue.onAllDone → markSpeakingEnd).
                    if (handsfree) handsfree.markSpeakingStart();
                    groupQueue.playAll().catch(() => {
                        if (handsfree) handsfree.markSpeakingEnd();
                    });
                    updatePlaybackButtons();
                }
            }
            if (!ttsHandled && turnIdentityCurrent) {
                if (isDev) voiceTurnTimer.log();
                voiceTurnTimer.cancel();
                if (handsfree) handsfree.markResponseComplete();
            }
        } catch (e) {
            // VOICE-002 Step 2E: the CAPTURED send identity decides how
            // this completion is classified — user Stop, external abort,
            // or real failure — and a superseded send must never mutate a
            // newer turn's state (see createSendCompletionHandler).
            sendCompletion.handleCatch(send, e);
        } finally {
            // Identity-safe settle (VOICE-002 Step 2E): only the still-
            // current send may clear the sending state and return the
            // button to "Send"; a send superseded by Stop or delete is a
            // no-op here so it cannot disturb a newer send's button.
            if (responseProgress.isPending(currentAssistantMsg)) {
                responseProgress.stop();
            }
            sendCompletion.handleFinally(send);
        }
        return true;
    }

    // ── Event listeners ────────────────────────────────────────────────────

    newChatButton.addEventListener('click', handleNewConversation);

    // VOICE-002 Step 2E: the Send button doubles as the Stop control while
    // a turn is in flight — it stays enabled for the whole generation.
    sendButton.addEventListener('click', () => {
        if (activeSendController.isSending()) {
            stopActiveTurn();
        } else {
            sendMessage();
        }
    });

    // Enter mirrors the Send/Stop button: a second Enter while a turn is
    // active stops that turn (idempotently) and never starts a duplicate
    // send.
    messageInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (activeSendController.isSending()) {
                stopActiveTurn();
            } else {
                sendMessage();
            }
        }
    });

    newCharacterButton.addEventListener('click', () => showCharacterForm(null));

    importCharacterButton.addEventListener('click', () => {
        importCharacterFileInput.value = '';
        importCharacterFileInput.click();
    });
    importCharacterFileInput.addEventListener('change', () => {
        const file = importCharacterFileInput.files && importCharacterFileInput.files[0];
        if (file) importCharacterCard(file);
        importCharacterFileInput.value = '';
    });

    charExportButton.addEventListener('click', exportCharacterCard);

    charFormSave.addEventListener('click', handleCharacterFormSubmit);

    charFormCancel.addEventListener('click', hideCharacterForm);

    charNameInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleCharacterFormSubmit();
        }
    });

    if (autoSpeakButton) {
        autoSpeakButton.addEventListener('click', () => {
            if (!currentConversation) return;
            const newState = !getAutoSpeakState(currentConversation.id);
            setAutoSpeakState(currentConversation.id, newState);
            if (!newState) {
                ttsOwnership.stopActiveTts('auto-speak-disabled', { markSpeakingEnd: true });
            }
            updateAutoSpeakButton();
        });
    }

    if (voiceModeButton) {
        voiceModeButton.addEventListener('click', () => {
            if (!currentConversation) return;
            const newState = !getVoiceModeState(currentConversation.id);
            setVoiceModeState(currentConversation.id, newState);
            if (!newState) {
                ttsOwnership.stopActiveTts('voice-mode-disabled', { markSpeakingEnd: true });
            }
            updateVoiceModeButton();
        });
    }

    // ── Recorder controls ──────────────────────────────────────────────────

    const recordButton = document.getElementById('recordButton');
    const stopRecordButton = document.getElementById('stopRecordButton');
    const cancelRecordButton = document.getElementById('cancelRecordButton');
    const transcribeButton = document.getElementById('transcribeButton');
    const recordingIndicator = document.getElementById('recordingIndicator');
    const recorderError = document.getElementById('recorderError');
    const transcriptionStatus = document.getElementById('transcriptionStatus');

    function updateRecorderUI() {
        const s = recorder.state;
        if (recordButton) {
            recordButton.hidden = (s === 'recording');
            recordButton.disabled = (s === 'recording');
        }
        if (transcribeButton) {
            transcribeButton.hidden = (s !== 'stopped');
            transcribeButton.disabled = transcription.state === 'busy';
        }
        if (stopRecordButton) {
            stopRecordButton.hidden = (s !== 'recording');
        }
        if (cancelRecordButton) {
            cancelRecordButton.hidden = (s !== 'recording');
        }
        if (recordingIndicator) {
            recordingIndicator.hidden = (s !== 'recording');
        }
        if (recorderError) {
            if (s === 'error' && recorder.error) {
                recorderError.textContent = recorder.error;
                recorderError.hidden = false;
            } else {
                recorderError.hidden = true;
                recorderError.textContent = '';
            }
        }
    }

    const recorder = createRecorderController({
        onStateChange: (s) => {
            updateRecorderUI();
            if (s === 'stopped') {
                const voiceMode = getVoiceModeState(currentConversation ? currentConversation.id : '');
                if (voiceMode) {
                    voiceTurnTimer.start();
                    voiceTurnTimer.markRecordingEnd();
                }
            }
            if (s === 'idle' || s === 'error') {
                voiceTurnTimer.cancel();
            }
        },
    });
    const transcription = createTranscriptionController({
        getCsrfToken,
        onStateChange: () => {
            updateRecorderUI();
            updateTranscriptionStatus();
        },
    });

    function updateTranscriptionStatus() {
        if (!transcriptionStatus) return;
        if (transcription.state === 'busy') {
            transcriptionStatus.textContent = 'Transcribing…';
            transcriptionStatus.hidden = false;
        } else if (transcription.state === 'error') {
            transcriptionStatus.textContent = transcription.error;
            transcriptionStatus.hidden = false;
        } else {
            transcriptionStatus.textContent = '';
            transcriptionStatus.hidden = true;
        }
    }

    if (typeof MediaRecorder === 'undefined' && recordButton) {
        recordButton.disabled = true;
        recordButton.title = 'Recording not supported in this browser';
    }

    if (recordButton) {
        recordButton.addEventListener('click', async () => {
            // Hands-free owns the microphone while active.
            if (handsfree && handsfree.state !== HANDSFREE_STATES.OFF) return;
            recordingInterruptionPending = true;
            // All speech output (streaming session, legacy queue, manual
            // playback) must be fully stopped before the microphone starts
            // (Step 2D); a stale TTS callback cannot touch Hands-Free
            // during recording because Hands-Free is OFF here.
            ttsOwnership.stopActiveTts('recording-start');
            try {
                await recorder.start();
            } finally {
                recordingInterruptionPending = false;
                updateRecorderUI();
            }
        });
    }

    if (stopRecordButton) {
        stopRecordButton.addEventListener('click', () => {
            recorder.stop();
        });
    }

    if (cancelRecordButton) {
        cancelRecordButton.addEventListener('click', () => {
            recorder.cancel();
        });
    }

    if (transcribeButton) {
        transcribeButton.addEventListener('click', async () => {
            const blob = recorder.blob;
            updateTranscriptionStatus();
            const text = await transcription.transcribe(blob);
            if (text) {
                voiceTurnTimer.markSttComplete();
                const voiceMode = getVoiceModeState(currentConversation ? currentConversation.id : '');
                if (shouldAutoSendTranscription({ voiceModeEnabled: voiceMode, transcriptionSucceeded: true })) {
                    messageInput.value = text;
                    await sendMessage();
                } else {
                    messageInput.value = text;
                    messageInput.focus();
                    if (isDev) voiceTurnTimer.log();
                    voiceTurnTimer.cancel();
                }
            } else {
                if (isDev) voiceTurnTimer.log();
                voiceTurnTimer.cancel();
            }
            recorder.discard();
            updateRecorderUI();
            updateTranscriptionStatus();
        });
    }

    // ── Hands-free conversation mode (TASK-VOICE-HANDSFREE-001) ─────────────
    //
    // Browser-local half-duplex voice loop. The microphone never streams to
    // STT: an energy VAD fed by AudioWorklet PCM frames detects utterances, a
    // bounded PCM capture finalizes each utterance as a standalone WAV, and
    // the WAV goes through the EXISTING transcription controller → STT
    // endpoint → auto send. Enabling always requires an explicit user
    // gesture; the persisted preference only remembers that hands-free was
    // preferred.

    const HANDSFREE_PREF_KEY = 'openparlor-hands-free';

    function getHandsFreePreference() {
        try {
            return normalizeHandsFreePreference(localStorage.getItem(HANDSFREE_PREF_KEY));
        } catch {
            return false;
        }
    }

    function setHandsFreePreference(enabled) {
        try {
            localStorage.setItem(HANDSFREE_PREF_KEY, enabled ? 'true' : 'false');
        } catch { /* storage unavailable */ }
    }

    // One Hands-Free session owns exactly ONE browser microphone capture
    // (handsFreeStream), consumed by the Web Audio / VAD graph, which also
    // produces the PCM frames the utterance capture encodes into WAVs. The
    // tracks are stopped exactly once, by stopHandsFreeStream() inside
    // teardownHandsFreeAudio().
    let handsFreeAudio = null;
    let handsFreeStream = null;

    async function acquireHandsFreeStream() {
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                // VOICE-003: echoCancellation is the first line of defence
                // against the AI's own voice triggering a barge-in, but the
                // detector's stronger threshold and sustained confirmation are
                // what actually make interruption reliable. autoGainControl
                // keeps a quiet interjection above the threshold.
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1,
                },
            });
        } catch {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        handsFreeStream = stream;
        for (const track of stream.getTracks()) {
            track.addEventListener('ended', () => {
                if (handsfree) handsfree.onDeviceLost();
                teardownHandsFreeAudio();
            });
        }
        return stream;
    }

    function stopHandsFreeStream() {
        const stream = handsFreeStream;
        handsFreeStream = null;
        if (stream) {
            for (const track of stream.getTracks()) track.stop();
        }
    }

    function stopHandsFreeAudio() {
        if (!handsFreeAudio) return;
        const session = handsFreeAudio;
        handsFreeAudio = null;
        try {
            if (session.node) {
                session.node.port.onmessage = null;
                session.node.disconnect();
            }
        } catch { /* ignore */ }
        try {
            if (session.sink) session.sink.disconnect();
        } catch { /* ignore */ }
        try {
            if (session.source) session.source.disconnect();
        } catch { /* ignore */ }
        if (session.workletUrl) {
            try {
                URL.revokeObjectURL(session.workletUrl);
            } catch { /* ignore */ }
        }
        if (session.ctx && session.ctx.state !== 'closed') {
            session.ctx.close().catch(() => {});
        }
    }

    // Full teardown of one hands-free mic session. Idempotent, so it is safe
    // to call from stopListening, the track 'ended' handler, and startup
    // failure paths without double-stopping the shared stream's tracks.
    function teardownHandsFreeAudio() {
        stopHandsFreeAudio();
        stopHandsFreeStream();
    }

    async function startHandsFreeAudio() {
        const AudioCtx = (typeof window.AudioContext !== 'undefined')
            ? window.AudioContext
            : (typeof window.webkitAudioContext !== 'undefined' ? window.webkitAudioContext : null);
        if (!AudioCtx) throw new Error('Web Audio API is not supported');
        const stream = handsFreeStream;
        if (!stream) throw new Error('Microphone unavailable.');
        const ctx = new AudioCtx();
        if (ctx.state === 'suspended') await ctx.resume();
        const source = ctx.createMediaStreamSource(stream);
        // The zero-gain sink keeps the graph running without re-emitting the
        // mic through the speakers (which would feed back into the VAD).
        const sink = ctx.createGain();
        sink.gain.value = 0;
        sink.connect(ctx.destination);
        let node = null;
        let workletUrl = null;
        if (ctx.audioWorklet) {
            try {
                workletUrl = URL.createObjectURL(new Blob([HANDSFREE_WORKLET_SOURCE], { type: 'text/javascript' }));
                await ctx.audioWorklet.addModule(workletUrl);
                node = new AudioWorkletNode(ctx, 'op-handsfree-frames');
                node.port.onmessage = (event) => {
                    if (event.data && handsfree) handsfree.onAudioFrame(event.data);
                };
            } catch {
                if (workletUrl) {
                    try {
                        URL.revokeObjectURL(workletUrl);
                    } catch { /* ignore */ }
                    workletUrl = null;
                }
            }
        }
        if (!node) {
            // Legacy fallback: ScriptProcessor delivers larger (~85 ms)
            // frames; the VAD is frame-rate agnostic.
            node = ctx.createScriptProcessor(4096, 1, 1);
            node.onaudioprocess = (event) => {
                if (handsfree) handsfree.onAudioFrame({
                    samples: event.inputBuffer.getChannelData(0),
                    sampleRate: ctx.sampleRate,
                });
            };
        }
        source.connect(node);
        node.connect(sink);
        handsFreeAudio = { ctx, source, node, sink, workletUrl };
    }

    handsfree = createHandsFreeController({
        getConversationId: () => (currentConversation ? currentConversation.id : ''),
        getEpoch: () => selectionEpoch,
        startListening: async () => {
            // Acquire the single shared mic capture, then build the Web
            // Audio graph that feeds the VAD and the PCM utterance capture.
            await acquireHandsFreeStream();
            try {
                await startHandsFreeAudio();
            } catch (e) {
                teardownHandsFreeAudio();
                throw e;
            }
        },
        stopListening: () => {
            teardownHandsFreeAudio();
        },
        transcribe: async (blob) => {
            voiceTurnTimer.markRecordingEnd();
            return transcription.transcribe(blob);
        },
        onSendText: async (text) => {
            messageInput.value = text;
            const sent = await sendMessage();
            if (sent !== true) throw new Error('send skipped');
        },
        // VOICE-003: a confirmed interrupt cancels the active response through
        // the existing Stop path. The controller has already moved to HEARING
        // with the preserved pre-roll, so the markSpeakingEnd() calls inside
        // that teardown are guarded no-ops.
        onBargeInConfirm: () => {
            onHandsFreeBargeIn();
        },
        onStateChange: (state) => {
            updateHandsFreeUI();
            if (state === HANDSFREE_STATES.HEARING) voiceTurnTimer.start();
        },
    });

    function updateHandsFreeUI() {
        const hfState = handsfree ? handsfree.state : HANDSFREE_STATES.OFF;
        const hfInfo = handsfree ? handsfree.stateInfo : {};
        const active = hfState !== HANDSFREE_STATES.OFF;
        if (handsFreeButton) {
            if (!currentConversation) {
                handsFreeButton.hidden = true;
            } else {
                handsFreeButton.hidden = false;
                handsFreeButton.setAttribute('aria-pressed', String(active));
                handsFreeButton.textContent = active ? 'Hands-free: On' : 'Hands-free: Off';
            }
        }
        if (handsFreeStatus) {
            let text = '';
            if (currentConversation) {
                if (hfState === HANDSFREE_STATES.OFF) {
                    text = getHandsFreePreference() ? 'Hands-free preferred · click to start' : '';
                } else {
                    const char = findCharacter(currentConversation.characterId);
                    text = handsFreeStatusText(hfState, {
                        characterName: char ? char.name : '',
                        error: hfInfo.error || '',
                    });
                }
            }
            handsFreeStatus.textContent = text;
            handsFreeStatus.hidden = !text;
        }
        if (recordButton) {
            if (active) {
                recordButton.disabled = true;
            } else {
                updateRecorderUI();
            }
        }
    }

    if (handsFreeButton) {
        handsFreeButton.addEventListener('click', () => {
            const state = handsfree.state;
            if (state === HANDSFREE_STATES.OFF || state === HANDSFREE_STATES.ERROR) {
                if (!currentConversation) return;
                if (recorder.state === 'recording') return; // manual recording owns the mic
                setHandsFreePreference(true);
                // enable() drives the UI via onStateChange; failures land in
                // a controlled error state that this same button can retry.
                handsfree.enable().catch(() => {});
            } else {
                setHandsFreePreference(false);
                handsfree.disable();
            }
        });
    }

    // Release the microphone when the page is hidden/closed so the mic
    // indicator never lingers.
    window.addEventListener('pagehide', () => {
        if (handsfree && handsfree.state !== HANDSFREE_STATES.OFF) handsfree.disable();
    });

    // ── Initial load ───────────────────────────────────────────────────────

    async function init() {
        try {
            await Promise.all([fetchCharacters(), fetchConversations(), fetchTtsVoices()]);
            renderCharacters();
            renderConversations();
            updateChatHeader();
        } catch (e) {
            renderState(conversationList, 'error', 'Failed to load data.');
            renderState(characterList, 'error', 'Failed to load data.');
        }

        const status = await fetchModelStatus();
        renderModelStatus(status);

        const health = await fetchHealthStatus();
        renderHealthStatus(health);

        const prereq = await fetchDeferredPrerequisite();
        renderPrerequisiteStatus(prereq);
    }

    init();
}
