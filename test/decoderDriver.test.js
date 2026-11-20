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
        // Respuesta real de /get_srt (SRT1 caller hacia tsst.dyndns.tv:6616)
        srt: {
            split_mode: 0,
            srt1: { id: 0, ip: 'tsst.dyndns.tv', latency: 500, listen: false, passphrase: '', port: 6616, srt_ip: '', srt_port: 0, status: true, transport: false, udp_ip: '238.0.0.6', udp_port: 11804 },
            srt2: { id: 0, ip: '', latency: 0, listen: false, passphrase: '', port: -1, srt_ip: '', srt_port: 0, status: false, transport: false, udp_ip: '238.0.0.6', udp_port: 53851 },
            srt3: { id: 0, ip: '', latency: 0, listen: false, passphrase: '', port: -1, srt_ip: '', srt_port: 0, status: false, transport: false, udp_ip: '238.0.0.6', udp_port: 36735 },
            srt4: { id: 0, ip: '', latency: 0, listen: false, passphrase: '', port: -1, srt_ip: '', srt_port: 0, status: false, transport: false, udp_ip: '238.0.0.6', udp_port: 56449 }
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
                if (!state.ignoreSet) Object.assign(state.codec, { split_mode: reqJson.split_mode, input_urls: reqJson.input_urls, addr_way: reqJson.addr_way, current_play: reqJson.current_play });
                state.lastSet = reqJson;
                return json({ status: 0 });
            }
            case '/get_srt': return json(state.srt);
            case '/set_srt': {
                const reqJson = JSON.parse(decodeURIComponent(decodeURIComponent(/[?&]request=([^&]*)/.exec(req.url)[1])));
                state.lastSrt = reqJson;
                if (!state.ignoreSet) {
                    state.srt.split_mode = reqJson.split_mode;
                    for (let i = 1; i <= 4; i++) state.srt[`srt${i}`] = { id: 0, ...reqJson[`srt${i}`] };
                    state.codec.current_play = 3; // reproduce SRT
                }
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

test('Decoder: lee el apartado SRT y la fuente', async () => {
    const st = await hwsdec.state(enc);
    assert.strictEqual(st.srt.split, 0);
    assert.deepStrictEqual(st.srt.channels[0], { enabled: true, mode: 'caller', host: 'tsst.dyndns.tv', port: 6616, listenPort: null, latency: 500, passphrase: '' });
    assert.strictEqual(st.srt.channels[1].port, null); // -1 = sin puerto
});

test('Decoder: guarda SRT sin perder la salida UDP de cada canal y pasa a reproducir SRT', async () => {
    await hwsdec.setSrt(enc, {
        split: 1,
        channels: [
            { enabled: true, mode: 'caller', host: '10.8.0.1', port: 9101, latency: 400, passphrase: 'claveSegura123' },
            { enabled: true, mode: 'listener', listenPort: 7000, latency: 300 },
            null, null
        ]
    });
    const s = dec.state.srt;
    assert.strictEqual(s.split_mode, 1);
    assert.strictEqual(s.srt1.ip, '10.8.0.1');
    assert.strictEqual(s.srt1.port, 9101);
    assert.strictEqual(s.srt1.passphrase, 'claveSegura123');
    assert.strictEqual(s.srt1.udp_port, 11804); // lo que el panel no maneja se conserva
    assert.strictEqual(s.srt2.listen, true);
    assert.strictEqual(s.srt2.srt_port, 7000);
    assert.strictEqual(s.srt3.udp_port, 36735);
    assert.ok(!('id' in dec.state.lastSrt.srt1)); // como su web: sin id
    assert.match(dec.state.rawRequests.at(-1) || '', /./);
    const p = await hwsdec.poll(enc);
    assert.strictEqual(p.source, 'srt');
    assert.strictEqual(p.srt.length, 2);
    assert.strictEqual(p.srt[0].encrypted, true);
    assert.ok(!('passphrase' in p.srt[0])); // el estado periódico no lleva la passphrase
});

test('Decoder: SRT que responde OK pero no guarda, es un error', async () => {
    dec.state.ignoreSet = true;
    await assert.rejects(hwsdec.setSrt(enc, { channels: [{ enabled: true, mode: 'caller', host: '1.2.3.4', port: 1234 }] }), e => e.code === 'ENOTAPPLIED');
    dec.state.ignoreSet = false;
});

test('validateDecoderSrt', () => {
    assert.strictEqual(drivers.validateDecoderSrt(null, 1), null);
    assert.deepStrictEqual(drivers.validateDecoderSrt({ enabled: true, mode: 'caller', host: 'tsst.dyndns.tv', port: '6616', latency: '500', passphrase: '' }, 1),
        { enabled: true, mode: 'caller', port: 6616, listenPort: null, latency: 500, host: 'tsst.dyndns.tv', passphrase: '' });
    assert.throws(() => drivers.validateDecoderSrt({ enabled: true, mode: 'caller', host: '', port: 1 }, 1), /dirección y puerto/);
    assert.throws(() => drivers.validateDecoderSrt({ enabled: true, mode: 'listener' }, 2), /puerto de escucha/);
    assert.throws(() => drivers.validateDecoderSrt({ enabled: false, mode: 'caller', passphrase: 'corta' }, 1), /10 a 79/);
    assert.throws(() => drivers.validateDecoderSrt({ enabled: true, mode: 'caller', host: 'a b', port: 1 }, 1), /dirección no válida/);
    assert.throws(() => drivers.validateDecoderSrt({ enabled: true, mode: 'caller', host: 'x', port: 1, latency: 5 }, 1), /latencia/);
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
