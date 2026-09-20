import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadBrowserParser() {
    const source = fs.readFileSync(path.join(__dirname, '../../public/openparlor/openparlor.js'), 'utf8');
    const context = { TextDecoder };
    vm.runInNewContext(source, context, { filename: 'openparlor.js' });
    return context.createNdjsonParser;
}

const createNdjsonParser = loadBrowserParser();

function parsedRecords(parser) {
    return JSON.parse(JSON.stringify(parser.records));
}

test('parses a single complete NDJSON record', () => {
    const parser = createNdjsonParser();
    parser.feed(new TextEncoder().encode('{"type":"delta","text":"hello"}\n'));
    parser.flush();
    assert.deepStrictEqual(parsedRecords(parser), [{ type: 'delta', text: 'hello' }]);
});

test('parses multiple records in one chunk', () => {
    const parser = createNdjsonParser();
    const input = '{"type":"delta","text":"a"}\n{"type":"delta","text":"b"}\n{"type":"done"}\n';
    parser.feed(new TextEncoder().encode(input));
    parser.flush();
    assert.deepStrictEqual(parsedRecords(parser), [
        { type: 'delta', text: 'a' },
        { type: 'delta', text: 'b' },
        { type: 'done' }
    ]);
});

test('handles record split across arbitrary chunk boundaries', () => {
    const parser = createNdjsonParser();
    const full = '{"type":"delta","text":"split"}\n';
    const bytes = new TextEncoder().encode(full);

    // Split at an awkward midpoint
    parser.feed(bytes.slice(0, 10));
    parser.feed(bytes.slice(10));
    parser.flush();
    assert.deepStrictEqual(parsedRecords(parser), [{ type: 'delta', text: 'split' }]);
});

test('handles multi-byte UTF-8 character split across chunks', () => {
    const parser = createNdjsonParser();
    const full = '{"type":"delta","text":"héllo"}\n';
    const bytes = new TextEncoder().encode(full);

    // Split in the middle of the é (2-byte UTF-8)
    const idx = full.indexOf('é');
    const byteIdx = new TextEncoder().encode(full.slice(0, idx)).length;
    parser.feed(bytes.slice(0, byteIdx + 1));
    parser.feed(bytes.slice(byteIdx + 1));
    parser.flush();
    assert.deepStrictEqual(parsedRecords(parser), [{ type: 'delta', text: 'héllo' }]);
});

test('skips malformed JSON lines', () => {
    const parser = createNdjsonParser();
    const input = 'not json\n{"type":"delta","text":"ok"}\n\n{"broken":\n';
    parser.feed(new TextEncoder().encode(input));
    parser.flush();
    assert.deepStrictEqual(parsedRecords(parser), [{ type: 'delta', text: 'ok' }]);
});

test('handles error record', () => {
    const parser = createNdjsonParser();
    parser.feed(new TextEncoder().encode('{"type":"error","error":"safe text"}\n'));
    parser.flush();
    assert.deepStrictEqual(parsedRecords(parser), [{ type: 'error', error: 'safe text' }]);
});

test('handles done record after deltas', () => {
    const parser = createNdjsonParser();
    parser.feed(new TextEncoder().encode('{"type":"delta","text":"Hi "}\n'));
    parser.feed(new TextEncoder().encode('{"type":"delta","text":"there"}\n'));
    parser.feed(new TextEncoder().encode('{"type":"done"}\n'));
    parser.flush();
    assert.deepStrictEqual(parsedRecords(parser), [
        { type: 'delta', text: 'Hi ' },
        { type: 'delta', text: 'there' },
        { type: 'done' }
    ]);
});

test('empty input produces no records', () => {
    const parser = createNdjsonParser();
    parser.feed(new TextEncoder().encode(''));
    parser.flush();
    assert.deepStrictEqual(parsedRecords(parser), []);
});

test('parses final record without trailing newline on flush', () => {
    const parser = createNdjsonParser();
    parser.feed(new TextEncoder().encode('{"type":"delta","text":"last"}'));
    assert.deepStrictEqual(parsedRecords(parser), []);
    parser.flush();
    assert.deepStrictEqual(parsedRecords(parser), [{ type: 'delta', text: 'last' }]);
});
