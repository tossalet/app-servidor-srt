const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { recordingTarget, channelOfRecording, RECORDING_DIR } = require('../recordings');

const NOW = new Date(2026, 10, 13, 9, 5, 7);

test('recordingTarget: carpeta entrada_<canal> junto al fichero elegido', () => {
    const r = recordingTarget('disk:///media/usb/CAM1.mp4', 3, NOW);
    assert.strictEqual(r.destUrl, path.join('/media/usb/entrada_3', 'CAM1_20261113_090507.mp4'));
    assert.strictEqual(r.format, 'mp4');
    assert.strictEqual(r.dir, path.join('/media/usb/entrada_3'));
});

test('recordingTarget: sin extensión usa .mp4', () => {
    const r = recordingTarget('disk:///media/usb/CAM1', 3, NOW);
    assert.strictEqual(r.destUrl, path.join('/media/usb/entrada_3', 'CAM1_20261113_090507.mp4'));
    assert.strictEqual(r.format, 'mp4');
});

test('recordingTarget: subcarpetas y formatos ts/mkv', () => {
    const ts = recordingTarget('disk:///media/usb/sub/CAM1.ts', 12, NOW);
    assert.strictEqual(ts.destUrl, path.join('/media/usb/sub/entrada_12', 'CAM1_20261113_090507.ts'));
    assert.strictEqual(ts.format, 'mpegts');
    const mkv = recordingTarget('disk:///media/usb/CAM1.mkv', '3', NOW);
    assert.strictEqual(mkv.format, 'matroska');
});

test('channelOfRecording', () => {
    assert.strictEqual(channelOfRecording('/media/usb/entrada_3/CAM1_x.mp4'), '3');
    assert.strictEqual(channelOfRecording('/media/usb/CAM1_x.mp4'), null);
    assert.strictEqual(channelOfRecording('/media/usb/entrada_10/CAM1.mp4'), '10');
    assert.strictEqual(channelOfRecording('/media/usb/entrada_3x/a.mp4'), null);
    assert.ok(RECORDING_DIR.test('entrada_7'));
});
