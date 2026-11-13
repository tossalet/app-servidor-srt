const { test } = require('node:test');
const assert = require('node:assert');
const { checkOperatorUrl, serverLocalHosts } = require('../urlGuard');

const localHosts = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '192.168.0.50']);
const items = [
    { kind: 'input', channel: 2, url: 'rtmp://127.0.0.1:1935/live/ajena' },
    { kind: 'output', channel: 2, url: 'rtmp://127.0.0.1:1935/out/ajena' },
    { kind: 'output', channel: 1, url: 'rtmp://127.0.0.1:1935/out/mia' }
];
const canSeeChannel = c => String(c) === '1';
const check = (url, isInput) => checkOperatorUrl(url, { isInput, items, canSeeChannel, localHosts });

test('URLs permitidas para operadores', () => {
    assert.strictEqual(check('disk:///media/usb/CAM1.mp4', true), null);
    assert.strictEqual(check('srt://:9000?mode=listener', true), null);
    assert.strictEqual(check('srt://0.0.0.0:9000?mode=listener', true), null);
    assert.strictEqual(check('udp://0.0.0.0:5000', true), null);
    assert.strictEqual(check('udp://@:5000', true), null);
    assert.strictEqual(check('rtmp://127.0.0.1:1935/live/nueva', true), null);
    assert.strictEqual(check('rtmp://127.0.0.1:1935/out/mia', false), null);
    assert.strictEqual(check('srt://remoto.example.com:9000', false), null);
    assert.strictEqual(check('srt://203.0.113.5:9000?mode=caller', true), null);
});

test('URLs rechazadas para operadores', () => {
    assert.ok(check('rtmp://127.0.0.1:1935/out/ajena', true));
    assert.strictEqual(check('rtmp://127.0.0.1:1935/live/ajena', true), 'Esa clave RTMP ya la usa otra señal');
    assert.strictEqual(check('rtmp://127.0.0.1:1935/out/ajena', false), 'Esa clave RTMP ya la usa otra señal');
    const local = 'No puedes usar direcciones de este servidor como origen o destino';
    assert.strictEqual(check('srt://127.0.0.1:9000', true), local);
    assert.strictEqual(check('srt://127.5.5.5:9000?mode=caller', true), local);
    assert.strictEqual(check('udp://127.0.0.1:5000', false), local);
    assert.strictEqual(check('srt://192.168.0.50:9000?mode=caller', true), local);
    assert.strictEqual(check('srt://localhost:9000', true), local);
    assert.strictEqual(check('udp://[::1]:5000', false), local);
});

test('serverLocalHosts incluye los fijos', () => {
    const s = serverLocalHosts();
    for (const h of ['127.0.0.1', 'localhost', '::1', '0.0.0.0']) assert.ok(s.has(h));
});
