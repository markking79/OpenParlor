import { expect, test } from '@playwright/test';

const enabled = process.env.OPENPARLOR_BROWSER_ACCEPTANCE === '1';
const storageState = process.env.ST_AUTH_STORAGE_STATE;

// Run-scoped names so repeated local runs never collide with existing
// characters on the developer's server.
const runSuffix = String(Date.now()).slice(-6);
const MONICA = `Monica-${runSuffix}`;
const DOUG = `Doug-${runSuffix}`;
const MONICA_GROUP_REPLY = `Hello from ${MONICA}`;
const DOUG_GROUP_REPLY = `Hello from ${DOUG}`;
const MONICA_SOLO_REPLY = 'Only I will answer.';

/**
 * Minimal valid silent WAV (8-bit mono PCM). Long enough that the mocked
 * playback is still "playing" when the test asserts the button states, so
 * the explicit Stop click — not a natural audio end — ends the playback.
 */
function silentWavBuffer(seconds = 3, sampleRate = 8000) {
    const sampleCount = Math.floor(seconds * sampleRate);
    const buffer = Buffer.alloc(44 + sampleCount);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + sampleCount, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate, 28); // byte rate (8-bit mono)
    buffer.writeUInt16LE(1, 32); // block align
    buffer.writeUInt16LE(8, 34); // bits per sample
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(sampleCount, 40);
    // Sample bytes stay zero (silence).
    return buffer;
}

function ndjsonBody(records) {
    return records.map(record => JSON.stringify(record)).join('\n') + '\n';
}

test.describe('STAB-008 OpenParlor browser acceptance', () => {
    // Conditional (environment-gated) skip, not a permanently skipped test.
    // eslint-disable-next-line playwright/no-skipped-test
    test.skip(!enabled || !storageState,
        'requires OPENPARLOR_BROWSER_ACCEPTANCE=1 and ST_AUTH_STORAGE_STATE (see tests/openparlor/README.md)');
    test.use({ storageState });
    test.setTimeout(60000);

    test('characters, two-character group chat, explicit speaker, TTS play/stop', async ({ page }) => {
        const pageErrors = [];
        const consoleErrors = [];
        const synthesizeRequests = [];
        let monicaId = '';
        let dougId = '';
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('console', message => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });

        // Voice discovery: the real /tts/voices request passes through
        // (server-side character validation requires provider-valid voice
        // IDs) and the test captures the actual list for character creation.
        const availableVoices = [];
        page.on('response', response => {
            if (!response.url().includes('/api/openparlor/tts/voices')) return;
            response.json().then(json => {
                for (const voice of json?.voices || []) {
                    if (typeof voice === 'string' && voice) availableVoices.push(voice);
                }
            }).catch(() => {});
        });

        // Model boundary: the chat endpoint is the only model-facing request
        // the UI makes, so mocking it keeps the run independent of llama.cpp.
        // Group turn → both characters respond; explicit turn → Monica only.
        await page.route('**/api/openparlor/chat', async route => {
            const body = route.request().postDataJSON() || {};
            const text = (body.messages || [])[0]?.content ?? '';
            const solo = text.startsWith(`Just you, ${MONICA}`);
            await route.fulfill({
                contentType: 'application/x-ndjson; charset=utf-8',
                body: solo ? ndjsonBody([
                    { type: 'speaker_start', character_id: monicaId },
                    { type: 'delta', text: 'Only I ' },
                    { type: 'delta', text: 'will answer.' },
                    { type: 'speaker_end' },
                    { type: 'done' },
                ]) : ndjsonBody([
                    { type: 'speaker_start', character_id: monicaId },
                    { type: 'delta', text: 'Hello from ' },
                    { type: 'delta', text: MONICA },
                    { type: 'speaker_end' },
                    { type: 'speaker_start', character_id: dougId },
                    { type: 'delta', text: 'Hello from ' },
                    { type: 'delta', text: DOUG },
                    { type: 'speaker_end' },
                    { type: 'done' },
                ]),
            });
        });

        // Service-status endpoints the app polls on load; a local server may
        // not implement them (the UI degrades gracefully). Fulfill them so the
        // "no console errors" assertion covers real issues only.
        await page.route('**/api/openparlor/health', route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({}),
        }));
        await page.route('**/api/openparlor/prerequisites', route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({}),
        }));

        // TTS boundary: synthesis is mocked so playback is deterministic and
        // does not depend on TTS engine latency. Voice *discovery* uses the
        // real endpoint because the server validates character voices against
        // the provider's live list.
        await page.route('**/api/openparlor/tts/synthesize', async route => {
            synthesizeRequests.push(route.request().postDataJSON());
            await route.fulfill({ contentType: 'audio/wav', body: silentWavBuffer() });
        });

        function waitForSynthesizeRequest(count) {
            const deadline = Date.now() + 5000;
            return (async () => {
                while (synthesizeRequests.length < count && Date.now() < deadline) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                expect(synthesizeRequests.length, 'tts synthesize request observed').toBeGreaterThanOrEqual(count);
            })();
        }
        // 1. App loads.
        await page.goto('/openparlor/');
        await expect(page.locator('.brand-name')).toHaveText('OpenParlor');
        await expect(page.locator('#characterList .state-loading')).toHaveCount(0);
        await expect(page.locator('#conversationList .state-loading')).toHaveCount(0);

        // The character form requires provider-valid voices, so the local
        // server must have a TTS provider configured; skip cleanly otherwise.
        let voicesReady = false;
        try {
            await expect.poll(() => availableVoices.length >= 2, { timeout: 10000 }).toBeTruthy();
            voicesReady = true;
        } catch {
            voicesReady = false;
        }
        // eslint-disable-next-line playwright/no-skipped-test
        test.skip(!voicesReady, 'requires a local TTS provider listing at least 2 voices (see tests/openparlor/README.md)');
        const [monicaVoice, dougVoice] = availableVoices;

        // 2. Character creation (with voices) and selection.
        for (const [name, voice] of [[MONICA, monicaVoice], [DOUG, dougVoice]]) {
            await page.locator('#newCharacterButton').click();
            await page.locator('#charNameInput').fill(name);
            await page.selectOption('#charVoiceSelect', voice);
            await page.locator('#charFormSave').click();
            await expect(page.locator('#characterForm')).toBeHidden();
            await expect(page.locator('.character-card', { hasText: name })).toBeVisible();
        }
        await expect(page.locator('#characterSelect')).toBeEnabled();
        monicaId = await page.locator('.character-card', { hasText: MONICA }).evaluate(el => el.dataset.id);
        dougId = await page.locator('.character-card', { hasText: DOUG }).evaluate(el => el.dataset.id);
        expect(monicaId, 'Monica character id').toBeTruthy();
        expect(dougId, 'Doug character id').toBeTruthy();
        expect(monicaId).not.toBe(dougId);

        // 3. Two-character conversation.
        await page.selectOption('#characterSelect', monicaId);
        await page.locator('#newChatButton').click();
        await expect(page.locator('#chatTitle')).toHaveText(`Chat with ${MONICA}`);
        await expect(page.locator('#messageInput')).toBeEnabled();
        await page.selectOption('#addParticipantSelect', dougId);
        await page.locator('#addParticipantButton').click();
        await expect(page.locator('#participantsList .participant-chip', { hasText: MONICA })).toBeVisible();
        await expect(page.locator('#participantsList .participant-chip', { hasText: DOUG })).toBeVisible();

        // 4. Group ("everyone") turn: both characters respond, the streamed
        //    deltas complete, and the speaker labels are correct.
        await page.locator('#messageInput').fill('Hello, everyone!');
        await page.locator('#sendButton').click();
        const assistantBubbles = page.locator('.message:not(.user-message) .bubble');
        await expect(assistantBubbles).toHaveCount(2);
        await expect(assistantBubbles.nth(0)).toHaveText(MONICA_GROUP_REPLY);
        await expect(assistantBubbles.nth(1)).toHaveText(DOUG_GROUP_REPLY);
        const assistantSpeakers = page.locator('.message:not(.user-message) .speaker');
        await expect(assistantSpeakers.nth(0)).toHaveText(MONICA);
        await expect(assistantSpeakers.nth(1)).toHaveText(DOUG);
        await expect(page.locator('.user-message .speaker').last()).toHaveText('You');

        // 5. Explicit speaker: only Monica responds.
        await page.locator('#messageInput').fill(`Just you, ${MONICA}. Introduce yourself.`);
        await page.locator('#sendButton').click();
        await expect(assistantBubbles).toHaveCount(3);
        await expect(assistantBubbles.nth(2)).toHaveText(MONICA_SOLO_REPLY);
        await expect(assistantSpeakers.nth(2)).toHaveText(MONICA);

        // 6. TTS controls attach to every assistant message and play/stop
        //    work with the correct speaker voice.
        const assistantMessages = page.locator('.message:not(.user-message)');
        for (let i = 0; i < 3; i++) {
            await expect(assistantMessages.nth(i).locator('.play-btn')).toBeVisible();
            await expect(assistantMessages.nth(i).locator('.stop-btn')).toBeVisible();
            await expect(assistantMessages.nth(i).locator('.replay-btn')).toBeVisible();
        }

        await assistantMessages.nth(0).locator('.play-btn').click();
        await waitForSynthesizeRequest(1);
        expect(synthesizeRequests.at(-1)).toMatchObject({ text: MONICA_GROUP_REPLY, voice: monicaVoice });
        await expect(assistantMessages.nth(0).locator('.stop-btn')).toBeEnabled();
        await expect(assistantMessages.nth(0).locator('.play-btn')).toBeDisabled();
        await assistantMessages.nth(0).locator('.stop-btn').click();
        await expect(assistantMessages.nth(0).locator('.stop-btn')).toBeDisabled();
        await expect(assistantMessages.nth(0).locator('.play-btn')).toBeEnabled();

        await assistantMessages.nth(1).locator('.play-btn').click();
        await waitForSynthesizeRequest(2);
        expect(synthesizeRequests.at(-1)).toMatchObject({ text: DOUG_GROUP_REPLY, voice: dougVoice });
        await expect(assistantMessages.nth(1).locator('.stop-btn')).toBeEnabled();
        await assistantMessages.nth(1).locator('.stop-btn').click();

        // 7. No console errors across the whole flow.
        expect(pageErrors).toEqual([]);
        expect(consoleErrors).toEqual([]);
    });
});

