import { expect, test } from '@playwright/test';

const enabled = process.env.OPENPARLOR_BROWSER_ACCEPTANCE === '1';
const storageState = process.env.ST_AUTH_STORAGE_STATE;

// Run-scoped name so repeated local runs never collide with existing
// characters on the developer's server.
const AVA = `AVA-${String(Date.now()).slice(-6)}`;

test.describe('TASK-004 streamed OpenParlor chat', () => {
    // Conditional (environment-gated) skip, not a permanently skipped test.
    // eslint-disable-next-line playwright/no-skipped-test
    test.skip(!enabled || !storageState, 'requires OPENPARLOR_BROWSER_ACCEPTANCE=1 and ST_AUTH_STORAGE_STATE (see tests/openparlor/README.md)');
    test.use({ storageState });
    test.setTimeout(60000);

    test('sends, streams, completes, and preserves composer keyboard behavior', async ({ page }) => {
        const pageErrors = [];
        const consoleErrors = [];
        let chatRequests = 0;
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('console', message => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });
        await page.route('**/api/openparlor/chat', async route => {
            chatRequests += 1;
            expect(route.request().method()).toBe('POST');
            const body = route.request().postDataJSON();
            expect(body).toMatchObject({ messages: [{ role: 'user', content: 'Hello from browser acceptance' }], stream: true });
            expect(body.conversation_id, 'conversation id sent by the UI').toBeTruthy();
            await new Promise(resolve => setTimeout(resolve, 100));
            await route.fulfill({ contentType: 'application/x-ndjson; charset=utf-8', body: '{"type":"delta","text":"Hello "}\n{"type":"delta","text":"there"}\n{"type":"done"}\n' });
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

        // The character form requires provider-valid voices, so the local
        // server must have a TTS provider configured; skip cleanly otherwise.
        const availableVoices = [];
        page.on('response', response => {
            if (!response.url().includes('/api/openparlor/tts/voices')) return;
            response.json().then(json => {
                for (const voice of json?.voices || []) {
                    if (typeof voice === 'string' && voice) availableVoices.push(voice);
                }
            }).catch(() => {});
        });

        await page.goto('/openparlor/');
        await expect(page.locator('.brand-name')).toHaveText('OpenParlor');
        await expect(page.locator('#characterList .state-loading')).toHaveCount(0);
        await expect(page.locator('#conversationList .state-loading')).toHaveCount(0);

        try {
            await expect.poll(() => availableVoices.length >= 1, { timeout: 10000 }).toBeTruthy();
        } catch {
            // eslint-disable-next-line playwright/no-skipped-test
            test.skip(true, 'requires a local TTS provider listing at least 1 voice (see tests/openparlor/README.md)');
        }

        // Create a character and open a conversation with it; the composer
        // stays disabled until a conversation exists.
        await page.locator('#newCharacterButton').click();
        await page.locator('#charNameInput').fill(AVA);
        await page.selectOption('#charVoiceSelect', availableVoices[0]);
        await page.locator('#charFormSave').click();
        await expect(page.locator('#characterForm')).toBeHidden();
        await expect(page.locator('.character-card', { hasText: AVA })).toBeVisible();
        await expect(page.locator('#characterSelect')).toBeEnabled();
        await page.selectOption('#characterSelect', await page.locator('.character-card', { hasText: AVA }).evaluate(el => el.dataset.id));
        await page.locator('#newChatButton').click();
        const input = page.locator('#messageInput');
        const send = page.locator('#sendButton');
        await expect(input).toBeEnabled();
        await input.fill('Hello from browser acceptance');
        await input.press('Shift+Enter');
        await expect(input).toHaveValue('Hello from browser acceptance\n');
        await input.fill('Hello from browser acceptance');
        await input.press('Enter');
        await expect(page.locator('.user-message .bubble').last()).toHaveText('Hello from browser acceptance');
        await expect(send).toBeDisabled();
        await send.click({ force: true });
        await expect(page.locator('.message:not(.user-message) .bubble').last()).toHaveText('Hello there');
        await expect(send).toBeEnabled();
        expect(chatRequests).toBe(1);
        expect(pageErrors).toEqual([]);
        expect(consoleErrors).toEqual([]);
    });
});
