// Núcleo de visibilidad por entrada (puro: sin db, auth ni express).
// Un admin ve todo; un operador ve las entradas que posee o que le han
// asignado, y las salidas/encoders/telemetría ligados a ellas.
// Todas las claves se normalizan a String.

const ROLE_ADMIN = 4;

// Estado de un encoder tal como lo ve un operador: de la VPN sólo si está arriba
// y la antigüedad del handshake; ni el endpoint WireGuard ni los contadores.
// Con `inputs` (Set de entradas del encoder visibles), la telemetría de la API se limita a ellas.
function operatorEncoderStatus(status, inputs) {
  if (!status) return status;
  let out = status;
  if (status.vpn) {
    const { up, handshakeAge } = status.vpn;
    out = { ...out, vpn: { up, handshakeAge } };
  }
  if (inputs && out.api && Array.isArray(out.api.inputs)) {
    out = { ...out, api: { ...out.api, inputs: out.api.inputs.filter(i => i && inputs.has(Number(i.id))) } };
  }
  return out;
}

// Canal del servidor vinculado a cada entrada de un encoder: [entrada 1, entrada 2...].
// input_channels (JSON) manda; si no hay, el campo channel es la entrada 1 (encoders de una entrada).
function encoderChannelsOf(row) {
  let list = null;
  if (Array.isArray(row.channels)) list = row.channels;
  else if (row.input_channels) {
    try { const v = JSON.parse(row.input_channels); if (Array.isArray(v)) list = v; } catch { /* columna corrupta: como si no hubiera */ }
  }
  if (!list || !list.length) list = [row.channel];
  return list.map(c => (c === null || c === undefined || c === '' ? null : String(c)));
}

class AccessState {
  constructor() {
    this.reset({});
  }

  // Sustituye todo el estado (se llama tras cada cambio en BD).
  reset({ inputs = [], outputs = [], grants = [], encoders = [] } = {}) {
    this.owners = new Map();    // canal -> username propietario
    this.grants = new Map();    // username -> Set<canal>
    this.outputs = new Map();   // id salida -> canal
    this.encoders = new Map();  // id encoder -> [canal | null por entrada]
    for (const i of inputs) this.owners.set(String(i.channel), i.owner);
    for (const o of outputs) this.outputs.set(String(o.id), String(o.channel));
    for (const g of grants) {
      if (!this.grants.has(g.username)) this.grants.set(g.username, new Set());
      this.grants.get(g.username).add(String(g.channel));
    }
    for (const e of encoders) {
      this.encoders.set(String(e.id), encoderChannelsOf(e));
    }
  }

  _isAdmin(user) {
    return !!user && user.role === ROLE_ADMIN;
  }

  canSee(user, channel) {
    if (this._isAdmin(user)) return true;
    if (!user) return false;
    const ch = String(channel);
    if (!this.owners.has(ch)) return false;
    if (this.owners.get(ch) === user.username) return true;
    const g = this.grants.get(user.username);
    return !!g && g.has(ch);
  }

  canSeeOutput(user, outputId) {
    if (this._isAdmin(user)) return true;
    const ch = this.outputs.get(String(outputId));
    return ch !== undefined && this.canSee(user, ch);
  }

  // Un operador ve el encoder si ve la señal de alguna de sus entradas
  canSeeEncoder(user, encoderId) {
    if (this._isAdmin(user)) return true;
    const v = this.visibleEncoderInputs(user, encoderId);
    return !!v && v.size > 0;
  }

  // Entradas del encoder (0, 1...) cuya señal ve el usuario. null = todas (admin).
  // Una entrada sin señal vinculada no la ve ningún operador (falla cerrado).
  visibleEncoderInputs(user, encoderId) {
    if (this._isAdmin(user)) return null;
    const chans = this.encoders.get(String(encoderId)) || [];
    const res = new Set();
    chans.forEach((ch, i) => { if (ch != null && this.canSee(user, ch)) res.add(i); });
    return res;
  }

  canSeeEncoderInput(user, encoderId, input) {
    const v = this.visibleEncoderInputs(user, encoderId);
    return v === null || v.has(Number(input));
  }

  // null = todos (admin)
  visibleChannels(user) {
    if (this._isAdmin(user)) return null;
    const set = new Set(this.ownedBy(user.username));
    for (const c of this.grantsOf(user.username)) set.add(c);
    return set;
  }

  ownedBy(username) {
    const res = [];
    for (const [ch, owner] of this.owners) if (owner === username) res.push(ch);
    return res;
  }

  grantsOf(username) {
    const g = this.grants.get(username);
    return g ? [...g] : [];
  }

  // Clave de telemetría/stats: canal ('1') o salida ('out_5').
  _canSeeKey(user, key) {
    const k = String(key);
    return k.startsWith('out_') ? this.canSeeOutput(user, k.slice(4)) : this.canSee(user, k);
  }

  _filterKeys(user, obj, byOutputId) {
    const res = {};
    for (const k of Object.keys(obj || {})) {
      const ok = byOutputId ? this.canSeeOutput(user, k) : this._canSeeKey(user, k);
      if (ok) res[k] = obj[k];
    }
    return res;
  }

  // Devuelve los datos a enviar a este usuario, o undefined si no hay nada.
  // Para operadores falla cerrado: un evento que no está aquí no se envía.
  filterFor(user, event, data) {
    if (this._isAdmin(user)) return data;
    switch (event) {
      case 'stats':
        return data && this._canSeeKey(user, data.channel) ? data : undefined;
      case 'audio_levels': {
        const r = this._filterKeys(user, data, false);
        return Object.keys(r).length ? r : undefined;
      }
      case 'telemetry_snapshot':
        return this._filterKeys(user, data, false);
      case 'rtmp_viewers':
        return this._filterKeys(user, data, true);
      case 'encoders_status':
        if (!Array.isArray(data)) return undefined;
        return data.filter(e => e && this.canSeeEncoder(user, e.id))
          .map(e => operatorEncoderStatus(e, this.visibleEncoderInputs(user, e.id)));
      default:
        return undefined;
    }
  }
}

module.exports = { AccessState, ROLE_ADMIN, operatorEncoderStatus, encoderChannelsOf };
