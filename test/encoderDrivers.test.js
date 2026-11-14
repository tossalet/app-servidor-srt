const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const drivers = require('../encoderDrivers');
const { parseXml, flat, zowiePublishList } = drivers._test;

/* ---------- Encoder HiSilicon simulado (URAY / HW Stream) con N entradas, main y sub en cada una ---------- */
function hisiServer(nInputs) {
    const out = {}; // 'entrada:stream' -> parámetros
    for (let i = 0; i < nInputs; i++) {
        out[`${i}:0`] = { venc_enable: '1', venc_codec: '96', venc_codec_supported: 'H.264,H.265', venc_gop: '50', venc_width: '1920', venc_height: '1080',
            venc_width_height_same_as_input: '1', venc_framerate: '25', venc_rc_mode: '0', venc_bitrate: String(4000 + i * 100),
            srt_enable: '0', srt_port: String(9000 + i), srt_publish_enable: '1', srt_publish_uri: `srt://10.8.0.1:${9100 + i}?latency=500`,
            rtmp_publish_enable: '0', rtmp_publish_uri: 'rtmp://192.168.1.50/live/0' };
        out[`${i}:1`] = { venc_enable: '1', venc_codec: '96', venc_gop: '50', venc_width: '640', venc_height: '360', venc_framerate: '25', venc_rc_mode: '1',
            venc_bitrate: '800', srt_publish_enable: '0', srt_publish_uri: `srt://10.8.0.1:${9200 + i}` };
    }
    const state = { rebooted: false, fps: Array(nInputs).fill(50), out, calls: [] };
    const xml = (root, o) => `<?xml version="1.0"?><${root}>${Object.entries(o).map(([k, v]) => `<${k}>${String(v).replace(/&/g, '&amp;')}</${k}>`).join('')}</${root}>`;
    const server = http.createServer((req, res) => {
        if (req.headers.authorization !== 'Basic ' + Buffer.from('admin:admin').toString('base64')) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="encoder"' }); return res.end();
        }
        const u = new URL(req.url, 'http://x');
        const q = Object.fromEntries(u.searchParams);
        state.calls.push(req.url);
        const key = `${q.input}:${q.output}`;
        if (u.pathname === '/get_status') {
            const vis = Array.from({ length: nInputs }, (_, i) => `<vi id="${i}"><framerate>${state.fps[i]}</framerate><width>1920</width><height>1080</height><interlaced>0</interlaced>
<venc id="0"><enable>1</enable><codec>${out[`${i}:0`].venc_codec}</codec><bitrate>${out[`${i}:0`].venc_bitrate}</bitrate></venc>
<venc id="1"><enable>1</enable><codec>96</codec><bitrate>${out[`${i}:1`].venc_bitrate}</bitrate></venc></vi>`).join('');
            res.end(`<?xml version="1.0"?><status><version>3.06</version><runtime>0000-00-00 00:18:38</runtime><cpuinfo>Hi3531DV200 HDMIx${nInputs}</cpuinfo><cpuusage>14</cpuusage>${vis}</status>`);
        } else if (u.pathname === '/get_output' && out[key]) {
            res.end(xml('output', { input: q.input, output: q.output, ...out[key] }));
        } else if (u.pathname === '/set_output' && out[key]) {
            for (const [k, v] of Object.entries(q)) {
                if (k === 'input' || k === 'output') continue;
                if (k === 'venc_bitrate' && Number(v) > 32000) continue; // el firmware ignora valores fuera de rango
                out[key][k] = v;
            }
            res.end('succeed');
        } else if (u.pathname === '/reboot') {
            state.rebooted = true; res.end('succeed');
        } else {
            res.writeHead(404); res.end('Not Found');
        }
    });
    return { server, state };
}

/* ---------- ZowieBox simulado (una entrada, main y sub) ---------- */
function zowieServer() {
    const venc = (chn, br) => ({ venc_chnid: chn, codec: { selected_id: 0, codec_list: ['H.264', 'H.265', 'MJPEG'] }, profile: { selected_id: 2, profile_list: ['BP', 'MP', 'HP'] },
        ratecontrol: { selected_id: 0, mode_list: ['CBR', 'VBR'] }, bitrate: br, width: chn ? 1280 : 1920, height: chn ? 720 : 1080, framerate: 50, keyinterval: 1, gop: 50, stream_id: chn, desc: chn ? 'sub' : 'main' });
    const state = {
        venc: [venc(0, 6000), venc(1, 2000)],
        publish: [{ index: 0, service: 'Custom', protocol: 'srt', url: 'srt://10.8.0.1:9001', key: '', switch: 0, name: 'TSST' }],
        rebooted: false
    };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const send = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
            if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
            const b = JSON.parse(body || '{}');
            const p = req.url.split('?')[0];
            if (p === '/system' && b.group === 'systime') return send({ status: '00000', rsp: 'succeed', data: { time: {} } });
            if (p === '/system' && b.group === 'syscontrol') { state.rebooted = true; return send({ status: '00000', rsp: 'succeed' }); }
            if (p === '/video' && b.group === 'hdmi') return send({ status: '00000', rsp: 'succeed', data: { hdmi_signal: 1, audio_signal: 48000, width: 1920, height: 1080, framerate: 50, desc: '1080p50' } });
            if (p === '/video' && b.group === 'all') return send({ status: '00000', rsp: 'succeed', data: { venc: state.venc } });
            if (p === '/video' && b.group === 'venc') {
                const v = b.venc[0];
                state.venc = state.venc.map(x => x.venc_chnid === v.venc_chnid ? v : x);
                return send({ status: '00000', rsp: 'succeed' });
            }
            if (p === '/streamplay' && b.opt === 'streamplay_get_all') return send({ status: '00000', rsp: 'succeed', data: { publish: state.publish } });
            if (p === '/streamplay' && b.opt === 'update_publish_switch') {
                const item = state.publish.find(x => x.index === b.data.index);
                if (!item) return send({ status: '60013', rsp: 'invalid index' });
                item.switch = b.data.switch;
                return send({ status: '00000', rsp: 'succeed' });
            }
            send({ status: '00004', rsp: 'not supported' });
        });
    });
    return { server, state };
}

const listen = (server) => new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
let hisi, hisi1, zowie, hisiEnc, hisi1Enc, zowieEnc;

before(async () => {
    hisi = hisiServer(4);
    hisi1 = hisiServer(1);
    zowie = zowieServer();
    hisiEnc = { id: 1, host: '127.0.0.1', web_port: await listen(hisi.server), https: 0, api_user: '', api_pass: '' };
    hisi1Enc = { id: 3, host: '127.0.0.1', web_port: await listen(hisi1.server), https: 0, api_user: '', api_pass: '' };
    zowieEnc = { id: 2, host: '127.0.0.1', web_port: await listen(zowie.server), https: 0, api_user: '', api_pass: '' };
});
after(() => { hisi.server.close(); hisi1.server.close(); zowie.server.close(); });

test('parseXml lee elementos, atributos y entidades', () => {
    const doc = parseXml('<?xml version="1.0"?><status><a>1</a><vi id="0"><venc id="1"><b>x &amp; y</b></venc></vi><empty/></status>');
    assert.strictEqual(doc.name, 'status');
    assert.deepStrictEqual(flat(doc), { a: '1', empty: '' });
    const venc = doc.children[1].children[0];
    assert.strictEqual(venc.attrs.id, '1');
    assert.strictEqual(venc.children[0].text, 'x & y');
});

test('detect distingue HiSilicon y ZowieAPI, y cuenta las entradas', async () => {
    const h = await drivers.detect(hisiEnc);
    assert.strictEqual(h.driver, 'uray');
    assert.strictEqual(h.info.inputs, 4);
    assert.strictEqual((await drivers.detect(zowieEnc)).driver, 'zowietek');
});

test('detect con credenciales erróneas identifica la API y avisa', async () => {
    const r = await drivers.detect({ ...hisiEnc, api_user: 'admin', api_pass: 'mal' });
    assert.strictEqual(r.driver, 'uray');
    assert.strictEqual(r.error.code, 'EAUTH');
});

test('HiSilicon 4 entradas: telemetría por entrada con main y sub', async () => {
    const api = drivers.impl('uray');
    hisi.state.fps[2] = 0; // la entrada 3 sin vídeo
    const t = await api.poll(hisiEnc);
    assert.strictEqual(t.cpu, 14);
    assert.strictEqual(t.inputs.length, 4);
    assert.deepStrictEqual(t.inputs.map(i => i.signal), [true, true, false, true]);
    assert.deepStrictEqual(t.inputs[1].streams, [
        { index: 0, bitrate: 4100, codec: 'H.264', streaming: true },
        { index: 1, bitrate: 800, codec: 'H.264', streaming: false }
    ]);
    assert.strictEqual(t.inputs[3].streaming, true);
    hisi.state.fps[2] = 50;
});

test('HiSilicon 4 entradas: estado completo entradas → streams → emisiones', async () => {
    const s = await drivers.impl('uray').state(hisiEnc);
    assert.strictEqual(s.inputs.length, 4);
    const inp = s.inputs[3];
    assert.strictEqual(inp.name, 'Entrada 4');
    assert.deepStrictEqual(inp.streams.map(x => [x.id, x.name, x.bitrate, x.rc]), [['3:0', 'Principal (main)', 4300, 'CBR'], ['3:1', 'Secundario (sub)', 800, 'VBR']]);
    const srt = inp.streams[0].outputs.find(o => o.id === '3:0:srt_publish');
    assert.ok(srt.enabled && srt.editable && srt.url === 'srt://10.8.0.1:9103?latency=500');
    assert.strictEqual(inp.streams[1].outputs.find(o => o.id === '3:1:srt_publish').enabled, false);
    // locate dice a qué entrada pertenece cada stream o emisión
    assert.strictEqual(drivers.locate(s, { outputId: '2:1:srt_publish' }).input.id, 2);
    assert.strictEqual(drivers.locate(s, { streamId: '1:1' }).stream.name, 'Secundario (sub)');
    assert.strictEqual(drivers.locate(s, { streamId: '9:0' }), null);
});

test('HiSilicon: cada orden va a su entrada y su stream', async () => {
    const api = drivers.impl('hwstream');
    await api.setStream(hisiEnc, '2:1', { bitrate: 1500, codec: 'H.265', rc: 'CBR', gop: 25 });
    const o = hisi.state.out['2:1'];
    assert.deepStrictEqual([o.venc_bitrate, o.venc_codec, o.venc_rc_mode, o.venc_gop], ['1500', '265', '0', '25']);
    assert.strictEqual(hisi.state.out['0:1'].venc_bitrate, '800'); // las demás entradas no se tocan
    assert.ok(hisi.state.calls.some(c => c.startsWith('/set_output?input=2&output=1&')));
    await assert.rejects(api.setStream(hisiEnc, '0:0', { bitrate: 40000 }), e => e.code === 'ENOTAPPLIED');
    await assert.rejects(api.setStream(hisiEnc, 'x', { bitrate: 1000 }), e => e.code === 'EINVAL');
});

test('HiSilicon: emisiones por entrada y stream', async () => {
    const api = drivers.impl('uray');
    await api.setOutput(hisiEnc, '1:0:srt_publish', { enabled: false });
    assert.strictEqual(hisi.state.out['1:0'].srt_publish_enable, '0');
    assert.strictEqual(hisi.state.out['0:0'].srt_publish_enable, '1');
    await api.setOutput(hisiEnc, '3:1:srt_publish', { enabled: true, url: 'srt://10.8.0.1:9305?latency=800' });
    assert.deepStrictEqual([hisi.state.out['3:1'].srt_publish_enable, hisi.state.out['3:1'].srt_publish_uri], ['1', 'srt://10.8.0.1:9305?latency=800']);
    await assert.rejects(api.setOutput(hisiEnc, '0:0:srt_publish', { url: 'rtmp://x/y' }), e => e.code === 'EINVAL');
    await assert.rejects(api.setOutput(hisiEnc, '0:0:bogus', { enabled: true }), e => e.code === 'EINVAL');
    await assert.rejects(api.setOutput(hisiEnc, '0:srt_publish', { enabled: true }), e => e.code === 'EINVAL');
});

test('HiSilicon de una entrada: mismo formato, entrada 0', async () => {
    const s = await drivers.impl('uray').state(hisi1Enc);
    assert.strictEqual(s.inputs.length, 1);
    assert.deepStrictEqual(s.inputs[0].streams.map(x => x.id), ['0:0', '0:1']);
    await drivers.impl('uray').setStream(hisi1Enc, '1', { bitrate: 900 }); // número suelto = entrada 1, stream 1
    assert.strictEqual(hisi1.state.out['0:1'].venc_bitrate, '900');
});

test('HiSilicon: reinicio', async () => {
    await drivers.impl('uray').reboot(hisiEnc);
    assert.strictEqual(hisi.state.rebooted, true);
});

test('Zowietek: una entrada con main y sub; emisiones en el main', async () => {
    const api = drivers.impl('zowietek');
    const t = await api.poll(zowieEnc);
    assert.strictEqual(t.inputs.length, 1);
    assert.deepStrictEqual(t.inputs[0].streams.map(s => [s.index, s.bitrate]), [[0, 6000], [1, 2000]]);
    assert.strictEqual(t.inputs[0].streaming, false);
    const s = await api.state(zowieEnc);
    const [main, sub] = s.inputs[0].streams;
    assert.deepStrictEqual([main.id, main.name, sub.id, sub.name], ['0:0', 'Principal (main)', '0:1', 'Secundario (sub)']);
    assert.strictEqual(main.outputs[0].id, 'pub:0');
    assert.deepStrictEqual(sub.outputs, []);

    await api.setStream(zowieEnc, '0:1', { bitrate: 1500, codec: 'H.265', rc: 'VBR' });
    const v = zowie.state.venc[1];
    assert.deepStrictEqual([v.bitrate, v.codec.selected_id, v.ratecontrol.selected_id, v.profile.selected_id], [1500, 1, 1, 2]);
    assert.strictEqual(zowie.state.venc[0].bitrate, 6000);
    await assert.rejects(api.setStream(zowieEnc, '1:0', { bitrate: 1500 }), e => e.code === 'EINVAL');

    await api.setOutput(zowieEnc, 'pub:0', { enabled: true });
    assert.strictEqual(zowie.state.publish[0].switch, 1);
    await assert.rejects(api.setOutput(zowieEnc, 'pub:7', { enabled: true }), /60013/);
    await assert.rejects(api.setOutput(zowieEnc, 'pub:0', { url: 'srt://x:1' }), e => e.code === 'EINVAL');

    await api.reboot(zowieEnc);
    assert.strictEqual(zowie.state.rebooted, true);
});

test('zowiePublishList tolera formatos distintos', () => {
    assert.strictEqual(zowiePublishList({ list: [{ index: 3, switch: '1', url: 'rtmp://a/live', key: 'k' }] })[0].kind, 'rtmp');
    assert.deepStrictEqual(zowiePublishList({ nada: 1 }), []);
});

test('validateStreamParams', () => {
    const caps = { bitrate: { min: 32, max: 32000 } };
    assert.deepStrictEqual(drivers.validateStreamParams({ bitrate: '5000', rc: 'CBR', fps: '' }, caps), { bitrate: 5000, rc: 'CBR' });
    assert.throws(() => drivers.validateStreamParams({ bitrate: 50000 }, caps), /entre 32 y 32000/);
    assert.throws(() => drivers.validateStreamParams({ codec: 'VP9' }, caps), /Códec/);
    assert.throws(() => drivers.validateStreamParams({}, caps), /No hay cambios/);
});

test('Encoder apagado: error claro y sin esperar al infinito', async () => {
    const srv = http.createServer();
    const port = await listen(srv);
    srv.close();
    await assert.rejects(drivers.detect({ host: '127.0.0.1', web_port: port, https: 0 }), e => e.code === 'ECONNREFUSED');
});
