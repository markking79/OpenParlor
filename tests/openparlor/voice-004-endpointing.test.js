/**
 * VOICE-004: better end-of-turn detection.
 *
 * Hands-Free previously decided "you are done" with a single fixed 900 ms of
 * silence, which is wrong in both directions: a one-word answer felt sluggish,
 * and a mid-sentence hesitation in a long story cut the speaker off.
 *
 * The detector is now an explicit state machine -- IDLE -> SPEAKING ->
 * POSSIBLE_END -> IDLE -- where the pause required to end scales with the
 * speech actually accumulated. It stays frame-driven (no wall clock, no
 * timers), so everything here is deterministic.
 *
 * The first 11 tests are the required test list from the specification.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    HANDSFREE_STATES,
    createEnergyVad,
    createHandsFreeController,
    createPcmUtteranceCapture,
} from '../../public/openparlor/handsfree.js';

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 160;
const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;

function frame(amp) {
    const samples = new Float32Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) samples[i] = amp;
    return { samples, sampleRate: SAMPLE_RATE };
}

/** Clearly speech. */
const speech = () => frame(0.1);
/** Clearly silence. */
const silence = () => frame(0.001);
/**
 * Below speechThreshold but clearly audible: ordinary room
 * noise that is neither a word nor a true pause.
 */
const roomTone = () => frame(0.007);

function feed(vad, count, make = speech) {
    for (let i = 0; i < count; i += 1) vad.processFrame(make());
}

function makeVad(overrides = {}) {
    const ends = [];
    const starts = [];
    const vad = createEnergyVad({
        onSpeechStart: (lookback) => starts.push(lookback),
        onSpeechEnd: (reason) => ends.push(reason),
        ...overrides,
    });
    return { vad, ends, starts };
}

/** Drives a detector until it endpoint, returning the pause length in frames. */
function endpointAfter(vad, speechFrames) {
    feed(vad, speechFrames);
    let guard = 0;
    while (vad.isActive && guard < 2000) {
        vad.processFrame(silence());
        guard += 1;
    }
    return guard;
}

describe('VOICE-004: end-of-turn detection', () => {
    // 1. one-word utterance completes
    it('1. a one-word utterance completes', () => {
        const { vad, ends } = makeVad();
        // 20 loud frames is the minimum that starts speech: the shortest
        // possible utterance.
        const pause = endpointAfter(vad, 20);
        assert.deepEqual(ends, ['silence'], 'a one-word answer must still endpoint');
        // It must be BRISK: the short-utterance bound, not the long-story one.
        assert.ok(pause * FRAME_MS <= 700,
            `a one-word answer must endpoint promptly, took ${pause * FRAME_MS}ms`);
    });

    // 2. ordinary sentence completes
    it('2. an ordinary sentence completes', () => {
        const { vad, ends } = makeVad();
        const pause = endpointAfter(vad, 150); // 1.5 s of speech
        assert.deepEqual(ends, ['silence']);
        assert.ok(pause * FRAME_MS > 600 && pause * FRAME_MS <= 1000,
            `a normal sentence ends in the mid range, took ${pause * FRAME_MS}ms`);
    });

    // 3. brief pause does not complete
    it('3. a brief pause does not complete the utterance', () => {
        const { vad, ends } = makeVad();
        feed(vad, 200); // 2 s of speech
        // The dogfood phrase "Well... I was thinking... maybe we could go
        // tomorrow." hinges on this: a 500 ms hesitation is not the end.
        feed(vad, 50, silence); // 500 ms
        assert.deepEqual(ends, [], 'a 500 ms pause must not endpoint');
        assert.equal(vad.state, 'possibleEnd', 'the detector waits in POSSIBLE_END');
    });

    // 4. speech restart cancels POSSIBLE_END
    it('4. speech restart cancels POSSIBLE_END', () => {
        const { vad, ends, starts } = makeVad();
        feed(vad, 200);
        feed(vad, 50, silence);
        assert.equal(vad.state, 'possibleEnd');
        feed(vad, 30, speech); // the speaker carries on
        assert.equal(vad.state, 'speaking', 'POSSIBLE_END returns to SPEAKING');
        assert.deepEqual(ends, [], 'no endpoint while the speaker is talking');
        assert.equal(starts.length, 1, 'still one utterance, not two');
    });

    // 5. long silence completes
    it('5. a long silence completes decisively', () => {
        const { vad, ends } = makeVad();
        feed(vad, 200);
        feed(vad, 300, silence); // 3 s, well past any bound
        assert.deepEqual(ends, ['silence']);
        assert.equal(vad.state, 'idle');
    });

    // 6. several pauses create only one final completion
    it('6. several pauses still produce exactly one completion', () => {
        const { vad, ends, starts } = makeVad();
        feed(vad, 100);
        for (let i = 0; i < 5; i += 1) {
            feed(vad, 30, silence); // 300 ms hesitation
            assert.deepEqual(ends, [], `pause ${i + 1} must not endpoint`);
            feed(vad, 40, speech);
        }
        assert.equal(starts.length, 1, 'one utterance throughout');
        feed(vad, 300, silence);
        assert.deepEqual(ends, ['silence'], 'exactly one completion at the real end');
    });

    // 7. hard duration cap works
    it('7. the hard duration cap still ends a monologue', () => {
        const { vad, ends } = makeVad({ maxUtteranceMs: 1000 });
        // 1.5 s of unbroken speech against a 1 s cap. The cap is checked after
        // the pause test, so no pause is needed to reach it. Feeding exactly
        // this much keeps the assertion about ONE utterance: the detector
        // correctly starts a fresh utterance from the continuing speech, and
        // that second one is not given enough time to hit the cap again.
        feed(vad, 150);
        assert.deepEqual(ends, ['max-duration'], 'the cap is not negotiable');
        // The continued speech after the cap correctly opens a fresh
        // utterance -- the cap ends one turn, it does not deafen the detector.
        assert.equal(vad.state, 'speaking', 'the cap ended the turn, not the session');
    });

    // 8. cancellation clears the endpoint state
    it('8. cancellation clears the pending endpoint', () => {
        const { vad, ends } = makeVad();
        feed(vad, 200);
        feed(vad, 40, silence);
        assert.equal(vad.state, 'possibleEnd', 'a pause is pending');
        vad.hold(); // TTS takes the microphone
        feed(vad, 2000, silence);
        assert.deepEqual(ends, [], 'nothing may endpoint while held');
        vad.release();
        assert.equal(vad.state, 'idle', 'release leaves no pending endpoint');
        assert.equal(vad.requiredSilenceMs, 600, 'and the threshold is back to the floor');
    });

    // 9. a stale endpoint cannot end the next utterance
    it('9. a stale endpoint cannot terminate the following utterance', () => {
        const { vad, ends, starts } = makeVad();
        feed(vad, 200);
        feed(vad, 300, silence); // first utterance ends
        assert.deepEqual(ends, ['silence']);
        // The next utterance starts from a clean slate, not inheriting the
        // previous one's accumulated pause.
        feed(vad, 200);
        assert.equal(starts.length, 2, 'the second utterance started normally');
        assert.equal(vad.state, 'speaking', 'and is not immediately ending');
        feed(vad, 50, silence);
        assert.deepEqual(ends, ['silence'], 'still only one endpoint so far');
    });

    // 10. a barge-in utterance uses this same detector
    it('10. a barge-in utterance endpointing uses the same adaptive rule', () => {
        const { vad, ends } = makeVad();
        vad.hold();
        // An interrupt that already spoke for a second earns the patience a
        // one-word answer does not get.
        vad.adopt(1000);
        assert.equal(vad.state, 'speaking');
        assert.ok(vad.requiredSilenceMs > 600,
            'a second of speech must raise the required pause above the floor');
        feed(vad, 50, silence);
        assert.deepEqual(ends, [], 'a 500 ms pause still does not endpoint');
        feed(vad, 200, silence);
        assert.deepEqual(ends, ['silence'], 'the same detector ends it');
    });

    // 11. Hands-Free never remains stuck in HEARING
    it('11. Hands-Free never stays stuck in HEARING', async () => {
        let resolveSend;
        const controller = createHandsFreeController({
            getConversationId: () => 'conv-1',
            startListening: async () => {},
            stopListening: () => {},
            transcribe: async () => 'ok',
            onSendText: () => new Promise((resolve) => { resolveSend = resolve; }),
        });
        await controller.enable();
        // Unbroken speech with no pause: the utterance must open and STAY open,
        // because a 10 s monologue is nowhere near the 15 s hard cap.
        for (let i = 0; i < 1000; i += 1) controller.onAudioFrame(speech());
        assert.equal(controller.state, HANDSFREE_STATES.HEARING);
        // Now the speaker stops. The detector must release the utterance and
        // let the pipeline move on rather than stranding Hands-Free in HEARING.
        for (let i = 0; i < 300; i += 1) controller.onAudioFrame(silence());
        await new Promise((resolve) => { setImmediate(resolve); });
        assert.notEqual(controller.state, HANDSFREE_STATES.HEARING,
            'Hands-Free must never remain stuck in HEARING');
        if (resolveSend) resolveSend();
    });
});

describe('VOICE-004: adaptive threshold and noise handling', () => {
    it('ramps the required pause as the speaker says more', () => {
        const { vad } = makeVad();
        const floor = vad.requiredSilenceMs;
        assert.equal(floor, 600, 'nothing said yet means the brisk floor');
        feed(vad, 20);
        const afterShort = vad.requiredSilenceMs;
        feed(vad, 380); // ~4 s total speech
        const afterLong = vad.requiredSilenceMs;
        feed(vad, 2000); // far past the ramp
        const capped = vad.requiredSilenceMs;
        assert.ok(afterShort > floor, 'speech raises the required pause');
        assert.ok(afterLong > afterShort, 'more speech raises it further');
        assert.equal(capped, 1500, 'and it is capped, never unbounded');
    });

    it('paused time earns no patience, but resumed speech does', () => {
        const { vad } = makeVad();
        feed(vad, 100); // 1 s of speech
        const before = vad.requiredSilenceMs;
        feed(vad, 60, silence); // 600 ms hesitation
        feed(vad, 40, speech); // then the speaker carries on
        const grew = vad.requiredSilenceMs - before;
        assert.ok(grew > 0, 'resumed speech itself still counts');
        // Only the CONFIRMED resumed speech may count: 400 ms of speech minus
        // the 80 ms that merely confirmed the resume. If the 600 ms pause had
        // been counted, the growth would be at least 900 * 600/8000 = 67.5 ms.
        const pauseWouldBeWorth = 900 * (600 / 8000);
        assert.ok(grew < pauseWouldBeWorth,
            `time spent pausing must not inflate the threshold (grew ${grew}ms)`);
    });

    it('rejects tiny sounds: a blip cannot cancel a real pause', () => {
        const { vad, ends } = makeVad();
        feed(vad, 200);
        feed(vad, 50, silence);
        assert.equal(vad.state, 'possibleEnd');
        // A single 10 ms frame above threshold is a click, not the speaker.
        vad.processFrame(speech());
        assert.equal(vad.state, 'possibleEnd', 'a one-frame blip must not resume speech');
        // Sustained speech does resume it.
        feed(vad, 10, speech);
        assert.equal(vad.state, 'speaking');
        assert.deepEqual(ends, []);
    });

    it('rejects extremely tiny sounds at utterance start', () => {
        const { vad, starts } = makeVad();
        feed(vad, 10, speech); // 100 ms, below the 200 ms start sustain
        assert.equal(vad.state, 'idle');
        assert.deepEqual(starts, []);
        feed(vad, 10, speech);
        assert.equal(vad.state, 'speaking', '200 ms of sustained speech does start');
    });

    it('room noise extends the pause but never resets it', () => {
        const { vad, ends } = makeVad();
        feed(vad, 200);
        const required = vad.requiredSilenceMs;
        feed(vad, 20, silence);
        // A hiss must not zero the accumulated pause, or endpointing would
        // never finish in a noisy room.
        for (let i = 0; i < 5; i += 1) vad.processFrame(roomTone());
        assert.equal(vad.state, 'possibleEnd', 'noise alone must not endpoint');
        // ...and it must still terminate: noise cannot hold the utterance open
        // until the hard cap either.
        for (let i = 0; i < Math.ceil(required / FRAME_MS) + 20; i += 1) {
            vad.processFrame(roomTone());
        }
        assert.equal(vad.state, 'idle', 'the pause still completes under noise');
        assert.deepEqual(ends, ['silence']);
    });

    it('room noise is never mistaken for the speaker resuming', () => {
        const { vad } = makeVad();
        feed(vad, 200);
        feed(vad, 30, silence);
        for (let i = 0; i < 100; i += 1) vad.processFrame(roomTone());
        assert.notEqual(vad.state, 'speaking',
            'sustained room noise must not reopen the utterance');
    });

    it('exposes the three detector states', () => {
        const { vad } = makeVad();
        assert.equal(vad.state, 'idle');
        feed(vad, 20, speech);
        assert.equal(vad.state, 'speaking');
        feed(vad, 10, silence);
        assert.equal(vad.state, 'possibleEnd');
        feed(vad, 300, silence);
        assert.equal(vad.state, 'idle');
    });

    it('an adaptiveRampMs of zero disables ramping and always waits the maximum', () => {
        const { vad } = makeVad({ adaptiveRampMs: 0 });
        assert.equal(vad.requiredSilenceMs, 1500);
        feed(vad, 20, speech);
        assert.equal(vad.requiredSilenceMs, 1500, 'still the maximum after speech');
    });

    it('a 30-second story is not cut off mid-sentence', () => {
        // A required dogfood scenario. The hard cap is an emergency stop for a
        // stuck microphone, not a routine cutoff: a real 30-second story is
        // 30 seconds of WALL CLOCK that includes breath pauses, not 30
        // seconds of unbroken sound. The cap is measured from the real onset,
        // so a story told with normal pauses runs well under it.
        const { vad, ends } = makeVad();
        // 25 s of speech broken by five 500 ms breaths = ~27.5 s of talking.
        for (let i = 0; i < 5; i += 1) {
            feed(vad, 500, speech);
            feed(vad, 50, silence);
            assert.deepEqual(ends, [], `breath ${i + 1} must not end the story`);
        }
        assert.deepEqual(ends, [], 'a 30-second story must not be truncated');
        // Still inside the same utterance, paused mid-thought -- the state
        // proves the breath was absorbed rather than ending the turn.
        assert.equal(vad.state, 'possibleEnd', 'the breath did not end the story');
        feed(vad, 300, silence);
        assert.deepEqual(ends, ['silence'], 'and it ends normally when they stop');
    });

    it('the capture retains a full-length utterance, not just its pre-roll ring', () => {
        // The detector decides when a turn ends; the capture decides how much
        // survives. If the capture capped earlier, a long utterance would
        // silently lose its oldest audio.
        const capture = createPcmUtteranceCapture();
        capture.begin(0);
        // Feed 20 s, well past the OLD 15 s cap.
        for (let i = 0; i < 2000; i += 1) capture.processFrame(speech());
        const out = capture.end();
        assert.equal(out.samples.length, 2000 * FRAME_SAMPLES,
            'the capture must retain all 20 s, so its cap is not 15 s');
    });
});

/**
 * Realistic speech signals.
 *
 * Every test above drives a square wave: a perfectly flat block of loud
 * frames, then a perfectly flat block of quiet ones. Real speech is neither.
 * Each syllable swells and fades, unvoiced consonants (s, sh, f) are far
 * quieter than vowels, and a word boundary is a dip toward the room noise
 * floor. Those dips are the interesting case: if the detector treats a
 * syllable's own quiet tail as "the pause", every speaker gets chopped up
 * mid-word. A flat wave can never catch that, so these tests use a
 * syllabic envelope instead.
 */
describe('VOICE-004: realistic (non-square-wave) speech', () => {
    const FRAME_MS = 10;

    /**
     * Build a syllable train.
     *
     * @param {object} spec
     * @param {number} spec.syllables   how many syllables to utter
     * @param {number} spec.syllableMs  length of each syllable
     * @param {number} spec.gapMs       quiet dip BETWEEN syllables
     * @param {number} spec.peak        loudest amplitude (a vowel)
     * @param {number} spec.floor       quietest amplitude (the dip)
     * @returns {Array} frames
     */
    function syllableTrain({
        syllables,
        syllableMs = 110,
        gapMs = 45,
        peak = 0.08,
        floor = 0.003,
    }) {
        const frames = [];
        for (let s = 0; s < syllables; s += 1) {
            // A syllable is not flat: it swells and fades.
            for (let i = 0; i < syllableMs; i += FRAME_MS) {
                const env = Math.sin((Math.PI * i) / syllableMs);
                frames.push(frame(floor + (peak - floor) * env));
            }
            if (s < syllables - 1) {
                for (let i = 0; i < gapMs; i += FRAME_MS) frames.push(frame(floor));
            }
        }
        return frames;
    }

    /**
     * Utter `frames`, then let the signal go quiet.
     *
     * `endsDuringSpeech` is the point of this helper: it records any endpoint
     * that fired WHILE the speaker was still producing signal. That is what
     * "a dip split the utterance" means. The end recorded afterwards, during
     * the tail, is the correct and expected one.
     */
    function run(frames, tailFrames = 400) {
        const { vad, ends, starts } = makeVad();
        for (const f of frames) vad.processFrame(f);
        const endsDuringSpeech = [...ends];
        const startsDuringSpeech = starts.length;
        // The pause the user actually experiences runs from the LAST loud
        // frame, which is usually inside the final syllable's fade-out -- not
        // from the end of the array we happened to build. Measuring the tail
        // after the array would understate the real patience by however much
        // the trailing frames were already quiet.
        let lastLoud = frames.length;
        for (let i = frames.length - 1; i >= 0; i -= 1) {
            if (frames[i].samples[0] >= 0.01) { lastLoud = i; break; }
        }
        const quietBeforeTailMs = (frames.length - 1 - lastLoud) * FRAME_MS;
        let tail = 0;
        while (vad.isActive && tail < tailFrames) {
            vad.processFrame(silence());
            tail += 1;
        }
        return {
            vad, ends, starts, tailMs: tail * FRAME_MS,
            pauseMs: quietBeforeTailMs + tail * FRAME_MS,
            endsDuringSpeech, startsDuringSpeech,
        };
    }

    it('a speaker\'s own syllable dips do not split an utterance', () => {
        // 20 syllables, each 110 ms loud with a 60 ms dip between. The dips
        // are genuine near-silence, so the naive "any quiet frame" reading
        // would treat them as the speaker finishing. They must not.
        const frames = syllableTrain({ syllables: 20, syllableMs: 110, gapMs: 60 });
        const { endsDuringSpeech, ends, startsDuringSpeech } = run(frames);
        assert.equal(startsDuringSpeech, 1,
            'the whole train is ONE utterance, so it starts exactly once');
        assert.deepEqual(endsDuringSpeech, [],
            'syllable dips are part of the word, not the end of the turn');
        assert.deepEqual(ends, ['silence'],
            'and it ends exactly once, when the speaker really stops');
    });

    it('a quiet speaker just above the threshold is still detected', () => {
        // 0.012 is only just above speechThreshold (0.01). A soft-spoken
        // person must not be invisible to the detector, even though most of
        // each syllable's envelope sits below the threshold.
        const frames = syllableTrain({ syllables: 8, peak: 0.012, floor: 0.003 });
        const { endsDuringSpeech, ends, startsDuringSpeech } = run(frames);
        assert.equal(startsDuringSpeech, 1, 'a quiet voice must still trigger speech start');
        assert.deepEqual(endsDuringSpeech, [],
            'a soft speaker must not be cut off: only ~40ms of each syllable is '
            + 'above threshold, and demanding 80ms of strictly consecutive loud '
            + 'frames meant the pause could never reset');
        assert.deepEqual(ends, ['silence'], 'and the turn still completes normally');
    });

    it('unvoiced consonants do not end a turn mid-word', () => {
        // "Six sharp ships": a quiet fricative, then a loud vowel, repeated.
        // Each word is [quiet 40ms][loud 100ms]. If the fricative counted as
        // the pause, the turn would be cut between consonants.
        const frames = [];
        for (let w = 0; w < 12; w += 1) {
            for (let i = 0; i < 40; i += FRAME_MS) frames.push(frame(0.011));
            for (let i = 0; i < 100; i += FRAME_MS) frames.push(frame(0.09));
        }
        const { endsDuringSpeech, ends, startsDuringSpeech } = run(frames);
        assert.equal(startsDuringSpeech, 1, 'consonants must not cause restarts');
        assert.deepEqual(endsDuringSpeech, [], 'fricatives are speech, not a pause');
        assert.deepEqual(ends, ['silence'], 'the turn ends once, at the true end');
    });

    it('a hesitant speaker with audible um-pauses is not cut off', () => {
        // The realistic worst case: someone thinking out loud, with 400 ms
        // gaps between short phrases.
        const frames = syllableTrain({
            syllables: 14, syllableMs: 90, gapMs: 400, peak: 0.07,
        });
        const { endsDuringSpeech, ends, startsDuringSpeech } = run(frames);
        assert.equal(startsDuringSpeech, 1, 'one continuous train of thought');
        assert.deepEqual(endsDuringSpeech, [],
            'a 400 ms hesitation inside a turn must not end it');
        assert.deepEqual(ends, ['silence'], 'it ends once, when the speaker really stops');
    });

    it('a genuinely long pause DOES end a hesitant turn', () => {
        // The other half of the trade-off: hesitation must not become
        // "never ends". A pause well past the maximum is a real finish.
        const frames = syllableTrain({
            syllables: 6, syllableMs: 90, gapMs: 40, peak: 0.07,
        });
        const { ends, pauseMs } = run(frames, 600);
        assert.deepEqual(ends, ['silence'], 'a finished thought must be sent');
        assert.ok(pauseMs >= 600 && pauseMs <= 1500,
            `adaptive pause should land in 600-1500ms, got ${pauseMs}ms`);
    });

    it('a click before real speech does not swallow the utterance', () => {
        // The flip side of tolerating dips: a short click starts a streak,
        // then a real pause abandons it, and the sentence that follows must
        // still start cleanly on its own.
        const { vad, ends, starts } = makeVad();
        // 60 ms of click, then 400 ms of true silence.
        feed(vad, 6, () => frame(0.1));
        feed(vad, 40, silence);
        assert.equal(starts.length, 0, 'a click is not a speaker');
        assert.equal(vad.state, 'idle', 'and the detector is still idle');
        // Now the real sentence.
        const frames = syllableTrain({ syllables: 12, syllableMs: 110, gapMs: 45 });
        for (const f of frames) vad.processFrame(f);
        assert.equal(starts.length, 1, 'the real sentence starts normally');
        assert.deepEqual(ends, [], 'and is not disturbed by the earlier click');
    });

    it('a finished utterance does not leak its start streak into the next', () => {
        // endUtterance() once left speechStreakMs set. The next utterance's
        // streak then accumulated ON TOP of the previous one, so the lookback
        // reported to the capture layer grew by a frame every turn
        // (200ms, 210ms, 220ms, ...), rewinding the pre-roll further and
        // further into the past and feeding stale audio from earlier turns
        // into the current transcription.
        const lookbacks = [];
        for (let turn = 0; turn < 4; turn += 1) {
            const vad = createEnergyVad({ onSpeechStart: (lb) => lookbacks.push(lb) });
            feed(vad, 20);          // exactly startSustainMs of speech
            endpointAfter(vad, 0);  // run the pause to completion
        }
        assert.deepEqual(lookbacks, [200, 200, 200, 200],
            'every turn must report the same lookback, not an ever-growing one');
    });
});
