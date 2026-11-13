const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { checkOperatorUrl, serverLocalHosts, hostToResolve, checkResolvedHost } = require('../urlGuard');

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

test('formas ocultas de direcciones locales', () => {
    const local = 'No puedes usar direcciones de este servidor como origen o destino';
    const hosts = new Set([...localHosts, '2001:db8::5']);
    const c = (u, i = true) => checkOperatorUrl(u, { isInput: i, items, canSeeChannel, localHosts: hosts });
    for (const u of ['srt://2130706433:9000?mode=caller', 'srt://0x7f000001:9000?mode=caller',
        'srt://0177.0.0.1:9000?mode=caller', 'srt://localhost.:9000?mode=caller',
        'srt://[::ffff:127.0.0.1]:9000?mode=caller', 'srt://[0:0:0:0:0:0:0:1]:9000?mode=caller',
        'srt://[::]:9000?mode=caller', 'srt://[2001:0db8:0:0:0:0:0:5]:9000?mode=caller',
        'srt://[::ffff:192.168.0.50]:9000?mode=caller', 'srt://LOCALHOST:9000?mode=caller']) {
        assert.strictEqual(c(u), local, u);
    }
    assert.strictEqual(c('srt://[2001:db8::6]:9000?mode=caller'), null);
    assert.strictEqual(c('srt://203.0.113.5:9000?mode=caller'), null);
});

test('esquemas y formatos no permitidos', () => {
    for (const u of ['file:///etc/passwd', 'file:/etc/x', 'pipe:0', 'concat:a|b', 'localhost:9000', 'unix:///tmp/s', '']) {
        assert.strictEqual(check(u, true), 'Formato de URL no permitido', u);
    }
    assert.strictEqual(check('RTSP://camara.example.com/s', true), null);
    assert.strictEqual(check('https://remoto.example.com/x', false), null);
});

test('serverLocalHosts incluye los fijos', () => {
    const s = serverLocalHosts();
    for (const h of ['127.0.0.1', 'localhost', '::1', '0.0.0.0']) assert.ok(s.has(h));
    assert.ok(s.has(os.hostname().toLowerCase()));
});

const LOCAL = 'No puedes usar direcciones de este servidor como origen o destino';

test('SRT con host vacío: sólo se permite en modo listener explícito', () => {
    assert.strictEqual(check('srt://:9000?mode=caller', true), LOCAL);
    assert.strictEqual(check('srt://:9000', true), LOCAL);
    assert.strictEqual(check('srt://:9000?mode=rendezvous', false), LOCAL);
    assert.strictEqual(check('srt://:9000?mode=caller', false), LOCAL);
    assert.strictEqual(check('srt://0.0.0.0:9000?mode=listener', true), null);
    assert.strictEqual(check('srt://:9000?mode=listener', true), null);
    assert.strictEqual(check('srt://:9000?mode=listener', false), null);
});

test('hostToResolve: sólo nombres que hay que resolver', () => {
    assert.strictEqual(hostToResolve('srt://encoder.example.com:9000?mode=caller', true), 'encoder.example.com');
    assert.strictEqual(hostToResolve('rtmp://LocalTest.me/out/x', false), 'localtest.me');
    assert.strictEqual(hostToResolve('srt://203.0.113.5:9000', true), null);
    assert.strictEqual(hostToResolve('srt://[2001:db8::6]:9000', true), null);
    assert.strictEqual(hostToResolve('srt://:9000?mode=listener', true), null);
    assert.strictEqual(hostToResolve('srt://servidor:9000?mode=listener', true), null);
    assert.strictEqual(hostToResolve('udp://@grupo:5000', true), null);
    assert.strictEqual(hostToResolve('disk:///media/usb/a.mp4', true), null);
    assert.strictEqual(hostToResolve('basura', true), null);
});

test('checkResolvedHost: nombres que apuntan a este servidor', () => {
    const opts = (isInput) => ({ isInput, items, canSeeChannel, localHosts });
    // Resuelve fuera: no añade error
    assert.strictEqual(checkResolvedHost('srt://remoto.example.com:9000', ['203.0.113.5'], opts(true)), null);
    // Cualquier dirección local basta para rechazar
    assert.strictEqual(checkResolvedHost('srt://dani-v2:9000', ['203.0.113.5', '127.0.1.1'], opts(true)), LOCAL);
    assert.strictEqual(checkResolvedHost('srt://127.0.0.1.nip.io:9000', ['127.0.0.1'], opts(false)), LOCAL);
    assert.strictEqual(checkResolvedHost('udp://lan.example:5000', ['192.168.0.50'], opts(false)), LOCAL);
    assert.strictEqual(checkResolvedHost('srt://v6.example:9000', ['::1'], opts(true)), LOCAL);
    // RTMP local: mismas reglas de clave que con 127.0.0.1
    assert.strictEqual(checkResolvedHost('rtmp://localtest.me/out/ajena', ['127.0.0.1'], opts(false)), 'Esa clave RTMP ya la usa otra señal');
    assert.strictEqual(checkResolvedHost('rtmp://localtest.me/out/mia', ['127.0.0.1'], opts(false)), null);
    assert.strictEqual(checkResolvedHost('rtmp://localtest.me/live/nueva', ['127.0.0.1'], opts(true)), null);
    assert.strictEqual(checkResolvedHost('rtmp://localtest.me/otra/x', ['127.0.0.1'], opts(true)), LOCAL);
    // Sin direcciones: falla cerrado
    assert.strictEqual(checkResolvedHost('srt://x.example:9000', [], opts(true)), 'No se pudo resolver el host');
});
