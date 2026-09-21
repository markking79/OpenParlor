import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { safeEndpointLabel, buildModelStatus, createOpenParlorModelStatusRouter } from '../../src/openparlor/model-status-router.js';

async function withModelStatusServer(deps, user, run) {
    const app = express();
    app.use((request, _response, next) => {
        request.user = user;
        next();
    });
    app.use('/api/openparlor', createOpenParlorModelStatusRouter(deps));
    const server = http.createServer(app);
    await new Promise(resolve => {
        server.once('listening', resolve);
        server.listen(0, '127.0.0.1');
    });
    const { port } = server.address();
    try {
        await run(`http://127.0.0.1:${port}`);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

async function getModelStatus(baseUrl) {
    const response = await fetch(`${baseUrl}/api/openparlor/model-status`);
    return { status: response.status, body: await response.json() };
}

// ─── safeEndpointLabel ──────────────────────────────────────────────────────

describe('safeEndpointLabel', () => {
    test('returns empty string for falsy input', () => {
        assert.equal(safeEndpointLabel(''), '');
        assert.equal(safeEndpointLabel(null), '');
        assert.equal(safeEndpointLabel(undefined), '');
    });

    test('returns empty string for non-string input', () => {
        assert.equal(safeEndpointLabel(42), '');
        assert.equal(safeEndpointLabel({}), '');
    });

    test('extracts hostname from a valid URL', () => {
        assert.equal(safeEndpointLabel('https://api.openai.com/v1'), 'api.openai.com');
    });

    test('extracts hostname from URL with port', () => {
        assert.equal(safeEndpointLabel('http://localhost:1234/v1'), 'localhost');
    });

    test('returns empty string for invalid URL', () => {
        assert.equal(safeEndpointLabel('not-a-url'), '');
    });

    test('does not expose credentials in URL', () => {
        assert.equal(safeEndpointLabel('https://user:pass@api.example.com/v1'), 'api.example.com');
    });
});

// ─── buildModelStatus ───────────────────────────────────────────────────────

describe('buildModelStatus', () => {
    test('returns default status for null config', async () => {
        const result = await buildModelStatus(null);
        assert.deepEqual(result, { provider: '', model: '', endpointLabel: '', models: [], connected: false });
    });

    test('returns default status for non-object config', async () => {
        const result = await buildModelStatus('hello');
        assert.deepEqual(result, { provider: '', model: '', endpointLabel: '', models: [], connected: false });
    });

    test('returns default status for config without model section', async () => {
        const result = await buildModelStatus({});
        assert.deepEqual(result, { provider: '', model: '', endpointLabel: '', models: [], connected: false });
    });

    test('returns default status for config with non-object model section', async () => {
        const result = await buildModelStatus({ model: 'not-an-object' });
        assert.deepEqual(result, { provider: '', model: '', endpointLabel: '', models: [], connected: false });
    });

    test('extracts provider and model from config.model', async () => {
        const config = {
            model: {
                provider: 'openai-compatible',
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4',
            },
        };

        const mockProvider = { listModels: async () => [{ id: 'gpt-4' }, { id: 'gpt-3.5-turbo' }] };
        const result = await buildModelStatus(config, () => mockProvider);
        assert.equal(result.provider, 'openai-compatible');
        assert.equal(result.model, 'gpt-4');
        assert.equal(result.endpointLabel, 'api.openai.com');
        assert.equal(result.connected, true);
        assert.deepEqual(result.models, ['gpt-4', 'gpt-3.5-turbo']);
    });

    test('returns connected=false when no baseUrl configured', async () => {
        const config = {
            model: {
                provider: 'openai-compatible',
                baseUrl: '',
                model: 'gpt-4',
            },
        };

        let providerCalled = false;
        const result = await buildModelStatus(config, () => {
            providerCalled = true;
            return { listModels: async () => [{ id: 'should-not-appear' }] };
        });
        assert.equal(providerCalled, false);
        assert.equal(result.provider, 'openai-compatible');
        assert.equal(result.model, 'gpt-4');
        assert.equal(result.connected, false);
        assert.deepEqual(result.models, []);
    });

    test('never includes apiKey or baseUrl in result', async () => {
        const config = {
            model: {
                provider: 'openai-compatible',
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4',
            },
        };

        const mockProvider = { listModels: async () => [{ id: 'gpt-4' }] };
        const result = await buildModelStatus(config, () => mockProvider);
        const serialized = JSON.stringify(result);
        assert.doesNotMatch(serialized, /apiKey/);
        assert.doesNotMatch(serialized, /sk-/);
        assert.doesNotMatch(serialized, /https:\/\//);
    });

    test('handles provider factory that throws', async () => {
        const config = {
            model: {
                provider: 'openai-compatible',
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4',
            },
        };

        const result = await buildModelStatus(config, () => {
            throw new Error('connection refused');
        });
        assert.equal(result.provider, 'openai-compatible');
        assert.equal(result.model, 'gpt-4');
        assert.equal(result.connected, false);
        assert.deepEqual(result.models, []);
    });

    test('handles provider listModels that throws', async () => {
        const config = {
            model: {
                provider: 'openai-compatible',
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4',
            },
        };

        const mockProvider = { listModels: async () => { throw new Error('timeout'); } };
        const result = await buildModelStatus(config, () => mockProvider);
        assert.equal(result.connected, false);
        assert.deepEqual(result.models, []);
    });

    test('handles provider listModels returning non-array', async () => {
        const config = {
            model: {
                provider: 'openai-compatible',
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4',
            },
        };

        const mockProvider = { listModels: async () => 'not-an-array' };
        const result = await buildModelStatus(config, () => mockProvider);
        assert.equal(result.connected, false);
        assert.deepEqual(result.models, []);
    });

    test('filters entries without string id', async () => {
        const config = {
            model: {
                provider: 'openai-compatible',
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4',
            },
        };

        const mockProvider = { listModels: async () => [{ id: 'valid' }, { id: 42 }, null, { id: 'also-valid' }] };
        const result = await buildModelStatus(config, () => mockProvider);
        assert.deepEqual(result.models, ['valid', 'also-valid']);
    });

    test('truncates model list to 100 entries', async () => {
        const config = {
            model: {
                provider: 'openai-compatible',
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4',
            },
        };

        const manyModels = Array.from({ length: 150 }, (_, i) => ({ id: `model-${i}` }));
        const mockProvider = { listModels: async () => manyModels };
        const result = await buildModelStatus(config, () => mockProvider);
        assert.equal(result.models.length, 100);
    });

    test('returns connected=true when provider returns empty model list', async () => {
        const config = {
            model: {
                provider: 'openai-compatible',
                baseUrl: 'https://api.example.com/v1',
                model: 'gpt-4',
            },
        };

        const mockProvider = { listModels: async () => [] };
        const result = await buildModelStatus(config, () => mockProvider);
        assert.equal(result.connected, true);
        assert.deepEqual(result.models, []);
    });

    test('handles missing fields in model config with defaults', async () => {
        const config = {
            model: {},
        };

        const result = await buildModelStatus(config, () => {
            throw new Error('should not be called');
        });
        assert.equal(result.provider, '');
        assert.equal(result.model, '');
        assert.equal(result.endpointLabel, '');
        assert.deepEqual(result.models, []);
        assert.equal(result.connected, false);
    });
});

describe('model status route', () => {
    test('requires an authenticated user with directories', async () => {
        for (const user of [null, {}, { directories: null }]) {
            await withModelStatusServer({}, user, async baseUrl => {
                const result = await getModelStatus(baseUrl);
                assert.equal(result.status, 401);
                assert.deepEqual(result.body, { error: 'Authentication is required' });
            });
        }
    });

    test('uses the authenticated user directories and returns only safe status data', async () => {
        const directories = { root: '/data/alice' };
        let receivedDirectories;
        await withModelStatusServer({
            loadConfig: async value => {
                receivedDirectories = value;
                return { model: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', model: 'local-model', apiKey: 'secret' } };
            },
            createProvider: () => ({ listModels: async () => [{ id: 'local-model' }] }),
        }, { profile: { handle: 'alice' }, directories }, async baseUrl => {
            const result = await getModelStatus(baseUrl);
            assert.equal(result.status, 200);
            assert.deepEqual(result.body, {
                provider: 'openai-compatible',
                model: 'local-model',
                endpointLabel: '127.0.0.1',
                models: ['local-model'],
                connected: true,
            });
            assert.doesNotMatch(JSON.stringify(result.body), /secret|http:/);
        });
        assert.equal(receivedDirectories, directories);
    });

    test('converts configuration or provider failures into a safe unavailable status', async () => {
        await withModelStatusServer({
            loadConfig: async () => { throw new Error('sensitive detail'); },
        }, { directories: { root: '/data/alice' } }, async baseUrl => {
            const result = await getModelStatus(baseUrl);
            assert.equal(result.status, 200);
            assert.deepEqual(result.body, { provider: '', model: '', endpointLabel: '', models: [], connected: false });
        });
    });
});
