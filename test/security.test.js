const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Telegram de mentira: el real arranca temporizadores y el proceso de test no terminaría
const alerts = [];
const tgPath = path.join(__dirname, '..', 'telegram.js');
require.cache[tgPath] = { id: tgPath, filename: tgPath, loaded: true, exports: { notify: (t) => alerts.push(t) } };
const security = require('../security');

// Respuesta mínima de Express para los middlewares
function fakeRes() {
    const res = { statusCode: 200, headers: {}, body: null, listeners: {} };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.end = () => res;
    res.on = (ev, fn) => { res.listeners[ev] = fn; };
    return res;
}
const req = (over) => ({ method: 'GET', path: '/api/inputs', ip: '10.0.0.1', headers: { host: 'srv:4000' }, ...over });

test('mismo origen: el panel sí, otras webs y encoders por el proxy no', () => {
    assert.ok(security.sameOrigin({ host: 'srv:4000', origin: 'https://srv:4000' }));
    assert.ok(security.sameOrigin({ host: 'srv:4000', referer: 'http://srv:4000/index.html' }));
    assert.ok(security.sameOrigin({ host: 'srv:4000' })); // curl, scripts
    assert.ok(!security.sameOrigin({ host: 'srv:4000', origin: 'https://evil.example' }));
    assert.ok(!security.sameOrigin({ host: 'srv:4000', origin: 'http://srv:4010' })); // web de un encoder
    assert.ok(!security.sameOrigin({ host: 'srv:4000', origin: 'null' }));
    assert.ok(!security.sameOrigin({ host: 'srv:4000', origin: 'no es una url' }));
});

test('CSRF: GET pasa siempre, POST de otro origen se rechaza', () => {
    let next = 0;
    security.csrf(req({ headers: { host: 'srv:4000', origin: 'https://evil.example' } }), fakeRes(), () => next++);
    assert.strictEqual(next, 1);
    const res = fakeRes();
    security.csrf(req({ method: 'POST', ip: '10.0.0.9', headers: { host: 'srv:4000', origin: 'https://evil.example' } }), res, () => next++);
    assert.strictEqual(next, 1);
    assert.strictEqual(res.statusCode, 403);
    security.csrf(req({ method: 'DELETE', headers: { host: 'srv:4000', origin: 'http://srv:4000' } }), fakeRes(), () => next++);
    assert.strictEqual(next, 2);
});

test('cabeceras de seguridad y /api sin caché', () => {
    const res = fakeRes();
    security.headers(req(), res, () => {});
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(res.headers['content-security-policy'], /object-src 'none'/);
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    const page = fakeRes();
    security.headers(req({ path: '/index.html' }), page, () => {});
    assert.strictEqual(page.headers['cache-control'], undefined);
});

test('límite de peticiones: escrituras por minuto y exentos', () => {
    const ip = '10.0.0.50';
    let passed = 0;
    let last;
    for (let i = 0; i < 130; i++) {
        last = fakeRes();
        security.rateLimit(req({ method: 'POST', ip }), last, () => passed++);
    }
    assert.strictEqual(passed, 120);
    assert.strictEqual(last.statusCode, 429);
    assert.ok(Number(last.headers['retry-after']) > 0);
    // Audio, vídeo y estáticos no cuentan
    let free = 0;
    security.rateLimit(req({ path: '/api/audio/3', ip }), fakeRes(), () => free++);
    security.rateLimit(req({ path: '/api/media/play', ip }), fakeRes(), () => free++);
    security.rateLimit(req({ path: '/hls/3/index.m3u8', ip }), fakeRes(), () => free++);
    assert.strictEqual(free, 3);
});

test('escaneos: 404 directo y puntos para la IP', () => {
    const ip = '10.0.0.77';
    for (const p of ['/.env', '/wp-admin/setup.php', '/.git/config', '/phpmyadmin/']) {
        const res = fakeRes();
        let next = 0;
        security.watch(req({ path: p, ip }), res, () => next++);
        assert.strictEqual(next, 0, p);
        assert.strictEqual(res.statusCode, 404, p);
    }
    assert.ok(security._test.suspects.get(ip).score >= 20);
    assert.ok(!alerts.some(a => a.includes(ip)), 'aún por debajo del umbral');
    // Rutas del panel: siguen su camino
    let next = 0;
    for (const p of ['/index.html', '/api/inputs', '/js/app.js', '/vendor/hls.js/hls.min.js', '/hls/2/seg_10.m4s']) {
        security.watch(req({ path: p, ip: '10.0.0.78' }), fakeRes(), () => next++);
    }
    assert.strictEqual(next, 5);
});

test('rutas con ".." o "\\": 400 antes de llegar al login', () => {
    for (const p of ['/images/../index.html', '/vendor/fontawesome/../../js/app.js', '/images/%2e%2e/index.html', '/images/..%2findex.html', '/images\\..\\index.html', '/a%00b']) {
        const res = fakeRes();
        let next = 0;
        security.watch(req({ path: p, ip: '10.0.0.90' }), res, () => next++);
        assert.strictEqual(next, 0, p);
        assert.strictEqual(res.statusCode, 400, p);
    }
    assert.strictEqual(alerts.filter(a => a.includes('10.0.0.90')).length, 1, 'un solo aviso por IP');
    let next = 0;
    for (const p of ['/images/bars.svg', '/vendor/fontawesome/css/all.min.css', '/api/media/play', '/thumbs/thumb_1.jpg', '/a.b/c..d']) {
        security.watch(req({ path: p, ip: '10.0.0.91' }), fakeRes(), () => next++);
    }
    assert.strictEqual(next, 5);
});

test('log limpio: sin saltos de línea', () => {
    assert.strictEqual(security._test.clean('admin\n[AUTH] Login de root'), 'admin?[AUTH] Login de root');
});
