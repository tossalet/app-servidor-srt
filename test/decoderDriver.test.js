const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const drivers = require('../encoderDrivers');
const { hwsdec } = drivers._test;

/* ---------- Decoder SDI HW Stream / URAY simulado (firmware sdi_hb), con las respuestas reales ---------- */
function decoderServer() {
    const state = {
        codec: {
            addr_way: '0', audio_source_channel: '0', current_play: 3, cvbs_mode: '720x576i-50', cvbs_modes: ['720x576i-50', '720x480i-60'],
            hdmi_mode: '1920x1080i-50', hdmi_modes: ['auto', '1920x1080p-50', '1920x1080i-50', '1280x720p-50'],
            input_urls: { 0: '', 1: '', 2: '', 3: '' }, output_mode_selected: 0, play_file: '', split_mode: 0
        },
        ignoreSet: false, rebooted: false, rawRequests: []
    };
    const server = http.createServer((req, res) => {
        if (req.headers.authorization !== 'Basic ' + Buffer.from('admin:admin').toString('base64')) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="decoder"' }); return res.end();
        }
        const u = new URL(req.url, 'http://x');
        const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        switch (u.pathname) {
            case '/get_codec': return json({ data: state.codec, status: 0 });
            case '/get_status': return json({ result: { output_screen_resolution: 0, split_screen_count: state.codec.split_mode, video_stream_urls: state.codec.input_urls }, status: state.codec.input_urls[0] ? 0 : 3 });
            case '/get_version': return json({ status: 1, versionData: { versionCode: '202007231', versionName: 'ver2.2.8_20200723_sdi_hb_01_03' } });
            case '/set_codec': {
                // Como el firmware: el parámetro llega codificado dos veces (encodeURIComponent + jQuery)
                const raw = /[?&]request=([^&]*)/.exec(req.url)[1];
                state.rawRequests.push(raw);
                const reqJson = JSON.parse(decodeURIComponent(decodeURIComponent(raw)));
                if (!state.ignoreSet) Object.assign(state.codec, { split_mode: reqJson.split_mode, input_urls: reqJson.input_urls, addr_way: reqJson.addr_way });
                state.lastSet = reqJson;
                return json({ status: 0 });
            }
            case '/set_hdmi_mode':
                state.codec.hdmi_mode = u.searchParams.get('hdmi_mode');
                res.writeHead(200); return res.end('succeed');
            case '/reboot':
                state.rebooted = true; res.writeHead(200); return res.end('succeed');
            default:
                res.writeHead(404); return res.end();
        }
    });
    return { server, state };
}

const listen = (server) => new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
let dec, enc;
before(async () => {
    dec = decoderServer();
    enc = { host: '127.0.0.1', web_port: await listen(dec.server), https: 0, kind: 'decoder' };
});
after(() => dec.server.close());

test('Decoder: se detecta su API y se lee su estado', async () => {
    assert.strictEqual((await drivers.detectDecoder(enc)).driver, 'hwsdec');
    const st = await hwsdec.state(enc);
    assert.strictEqual(st.decoder, true);
    assert.strictEqual(st.device.version, 'ver2.2.8_20200723_sdi_hb_01_03');
    assert.strictEqual(st.playing, false);
    assert.deepStrictEqual(st.urls, ['', '', '', '']);
    assert.strictEqual(st.hdmiMode, '1920x1080i-50');
});

test('Decoder: cambia URLs y división reenviando el resto de la configuración', async () => {
    const url = 'srt://10.8.0.1:9101?latency=500&passphrase=clave segura';
    await hwsdec.setConfig(enc, { split: 2, urls: [url, 'srt://10.8.0.1:9102', null, null] });
    assert.strictEqual(dec.state.codec.split_mode, 2);
    assert.strictEqual(dec.state.codec.input_urls[0], url);
    assert.strictEqual(dec.state.lastSet.output_mode_selected, 0);
    assert.strictEqual(dec.state.lastSet.current_play, 0);
    // Doble codificación, como la web del decoder: no aparece ni '{' ni '%7B' sin codificar de nuevo
    assert.match(dec.state.rawRequests.at(-1), /^%257B/);
    const p = await hwsdec.poll(enc);
    assert.strictEqual(p.playing, true);
    assert.strictEqual(p.urls[1], 'srt://10.8.0.1:9102');
});

test('Decoder: si responde OK pero no guarda, es un error', async () => {
    dec.state.ignoreSet = true;
    await assert.rejects(hwsdec.setConfig(enc, { urls: ['srt://10.8.0.1:9999'] }), e => e.code === 'ENOTAPPLIED');
    dec.state.ignoreSet = false;
});

test('Decoder: resolución HDMI sólo de las que admite, y reinicio', async () => {
    await hwsdec.setHdmiMode(enc, '1280x720p-50');
    assert.strictEqual(dec.state.codec.hdmi_mode, '1280x720p-50');
    await assert.rejects(hwsdec.setHdmiMode(enc, '3840x2160p-60'), e => e.code === 'EINVAL');
    await hwsdec.reboot(enc);
    assert.strictEqual(dec.state.rebooted, true);
});

test('Decoder: credenciales incorrectas', async () => {
    await assert.rejects(hwsdec.state({ ...enc, api_user: 'admin', api_pass: 'mala' }), e => e.code === 'EAUTH');
});

test('validateDecoderUrl', () => {
    assert.strictEqual(drivers.validateDecoderUrl(' srt://1.2.3.4:9000?latency=200 '), 'srt://1.2.3.4:9000?latency=200');
    assert.strictEqual(drivers.validateDecoderUrl(''), '');
    assert.throws(() => drivers.validateDecoderUrl('srt://a b'), /URL no válida/);
    assert.throws(() => drivers.validateDecoderUrl('javascript:alert(1)'), /URL no válida/);
    assert.ok(!drivers.DRIVER_CHOICES.includes('hwsdec'));
    assert.ok(drivers.DECODER_DRIVER_CHOICES.includes('hwsdec'));
});
