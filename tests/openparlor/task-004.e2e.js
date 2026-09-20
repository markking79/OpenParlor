import { expect, test } from '@playwright/test';

const enabled = process.env.OPENPARLOR_BROWSER_ACCEPTANCE === '1';
const storageState = process.env.ST_AUTH_STORAGE_STATE;

test.describe('TASK-004 streamed OpenParlor chat', () => {
    test.skip(!enabled || !storageState, 'requires explicit local authenticated browser state');

    test.use({ storageState });

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
            expect(route.request().postDataJSON()).toEqual({ messages: [{ role: 'user', content: 'Hello from browser acceptance' }], stream: true });
            await new Promise(resolve => setTimeout(resolve, 100));
            await route.fulfill({ contentType: 'application/x-ndjson; charset=utf-8', body: '{"type":"delta","text":"Hello "}\n{"type":"delta","text":"there"}\n{"type":"done"}\n' });
        });

        await page.goto('/openparlor/');
        const input = page.locator('#messageInput');
        const send = page.locator('#sendButton');
        await input.fill('Hello from browser acceptance');
        await input.press('Shift+Enter');
        await expect(input).toHaveValue('Hello from browser acceptance\n');
        await input.fill('Hello from browser acceptance');
        await input.press('Enter');
        await expect(page.locator('.user-message .bubble').last()).toHaveText('Hello from browser acceptance');
        await expect(send).toBeDisabled();
        await send.click({ force: true });
        await expect(page.locator('.assistant-message .bubble').last()).toHaveText('Hello there');
        await expect(send).toBeEnabled();
        expect(chatRequests).toBe(1);
        expect(pageErrors).toEqual([]);
        expect(consoleErrors).toEqual([]);
    });
});
