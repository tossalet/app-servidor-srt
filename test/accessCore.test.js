const test = require('node:test');
const assert = require('node:assert/strict');
const { AccessState, operatorEncoderStatus } = require('../accessCore');

function crear() {
  const st = new AccessState();
  st.reset({
    inputs: [{ channel: 1, owner: 'ana' }, { channel: 2, owner: 'admin' }, { channel: 10, owner: 'admin' }],
    outputs: [{ id: 5, channel: 1 }, { id: 6, channel: 2 }],
    grants: [{ username: 'ana', channel: 10 }],
    encoders: [{ id: 1, channel: 2 }, { id: 2, channel: 10 }, { id: 3, channel: null }]
  });
  return st;
}
const ana = { username: 'ana', role: 16 }, admin = { username: 'admin', role: 4 }, bob = { username: 'bob', role: 16 };

test('canSee propias y asignadas', () => {
  const st = crear();
  assert.equal(st.canSee(ana, 1), true);
  assert.equal(st.canSee(ana, '10'), true);
  assert.equal(st.canSee(ana, 2), false);
  assert.equal(st.canSee(bob, 1), false);
  assert.equal(st.canSee(admin, 2), true);
  assert.equal(st.canSee(ana, 99), false);
});

test('canSeeOutput', () => {
  const st = crear();
  assert.equal(st.canSeeOutput(ana, 5), true);
  assert.equal(st.canSeeOutput(ana, 6), false);
  assert.equal(st.canSeeOutput(ana, 999), false);
  assert.equal(st.canSeeOutput(admin, 6), true);
});

test('canSeeEncoder', () => {
  const st = crear();
  assert.equal(st.canSeeEncoder(ana, 2), true);
  assert.equal(st.canSeeEncoder(ana, 1), false);
  assert.equal(st.canSeeEncoder(ana, 3), false);
  assert.equal(st.canSeeEncoder(admin, 3), true);
});

test('visibleChannels', () => {
  const st = crear();
  assert.deepEqual(st.visibleChannels(ana), new Set(['1', '10']));
  assert.equal(st.visibleChannels(admin), null);
});

test('ownedBy y grantsOf', () => {
  const st = crear();
  assert.deepEqual(st.ownedBy('ana'), ['1']);
  assert.deepEqual(st.grantsOf('ana'), ['10']);
  assert.deepEqual(st.grantsOf('bob'), []);
});

test('canSee tras reset sin la asignación', () => {
  const st = crear();
  assert.equal(st.canSee(ana, 10), true);
  st.reset({
    inputs: [{ channel: 1, owner: 'ana' }, { channel: 10, owner: 'admin' }],
    outputs: [], grants: [], encoders: []
  });
  assert.equal(st.canSee(ana, 10), false);
});

test('filterFor stats', () => {
  const st = crear();
  const a = { channel: '1' };
  assert.equal(st.filterFor(ana, 'stats', a), a);
  assert.equal(st.filterFor(ana, 'stats', { channel: '2' }), undefined);
  const b = { channel: 'out_5' };
  assert.equal(st.filterFor(ana, 'stats', b), b);
  assert.equal(st.filterFor(ana, 'stats', { channel: 'out_6' }), undefined);
});

test('filterFor audio_levels', () => {
  const st = crear();
  assert.deepEqual(
    st.filterFor(ana, 'audio_levels', { 1: [-3, -3], 2: null, 10: [-6, -6] }),
    { 1: [-3, -3], 10: [-6, -6] }
  );
  assert.equal(st.filterFor(ana, 'audio_levels', { 2: null }), undefined);
});

test('filterFor telemetry_snapshot', () => {
  const st = crear();
  assert.deepEqual(
    st.filterFor(ana, 'telemetry_snapshot', { '1': [], '2': [], 'out_5': [], 'out_6': [] }),
    { '1': [], 'out_5': [] }
  );
  assert.deepEqual(st.filterFor(ana, 'telemetry_snapshot', { '2': [] }), {});
});

test('filterFor rtmp_viewers', () => {
  const st = crear();
  assert.deepEqual(st.filterFor(ana, 'rtmp_viewers', { 5: { count: 1 }, 6: { count: 2 } }), { 5: { count: 1 } });
  assert.deepEqual(st.filterFor(ana, 'rtmp_viewers', { 6: { count: 2 } }), {});
});

test('filterFor encoders_status', () => {
  const st = crear();
  assert.deepEqual(st.filterFor(ana, 'encoders_status', [{ id: 1 }, { id: 2 }, { id: 3 }]), [{ id: 2 }]);
  // Datos raros: falla cerrado
  assert.equal(st.filterFor(ana, 'encoders_status', { id: 2 }), undefined);
  assert.equal(st.filterFor(ana, 'encoders_status', null), undefined);
});

test('filterFor encoders_status: el operador no recibe datos de la VPN', () => {
  const st = crear();
  const vpn = { up: true, handshakeAge: 12, endpoint: '198.51.100.7:51820', rx: 100, tx: 200 };
  const lista = [{ id: 2, online: true, vpn }, { id: 1, online: true, vpn }];
  assert.deepEqual(st.filterFor(ana, 'encoders_status', lista), [{ id: 2, online: true, vpn: { up: true, handshakeAge: 12 } }]);
  assert.deepEqual(lista[0].vpn, vpn); // no muta el original (lo reciben también los admins)
  assert.equal(st.filterFor(admin, 'encoders_status', lista), lista);
  assert.deepEqual(st.filterFor(ana, 'encoders_status', [{ id: 2, vpn: null }]), [{ id: 2, vpn: null }]);
});

test('operatorEncoderStatus', () => {
  const vpn = { up: false, handshakeAge: null, endpoint: '198.51.100.7:51820', rx: 1, tx: 2 };
  assert.deepEqual(operatorEncoderStatus({ online: false, vpn }), { online: false, vpn: { up: false, handshakeAge: null } });
  assert.equal(operatorEncoderStatus(null), null);
  assert.deepEqual(operatorEncoderStatus({ online: true }), { online: true });
});

test('filterFor admin y otros eventos', () => {
  const st = crear();
  const d = { channel: '2' };
  assert.equal(st.filterFor(admin, 'stats', d), d);
  const s = { cpu: 1 }, u = { x: 1 };
  assert.equal(st.filterFor(admin, 'sys_stats', s), s);
  assert.equal(st.filterFor(admin, 'evento_nuevo', u), u);
  // Eventos que filterFor no conoce: el operador no recibe nada (falla cerrado)
  assert.equal(st.filterFor(ana, 'sys_stats', s), undefined);
  assert.equal(st.filterFor(ana, 'db_update', u), undefined);
  assert.equal(st.filterFor(ana, 'evento_nuevo', { channel: '1' }), undefined);
});
