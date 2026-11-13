// Núcleo de visibilidad por entrada (puro: sin db, auth ni express).
// Un admin ve todo; un operador ve las entradas que posee o que le han
// asignado, y las salidas/encoders/telemetría ligados a ellas.
// Todas las claves se normalizan a String.

const ROLE_ADMIN = 4;

// Estado de un encoder tal como lo ve un operador: de la VPN sólo si está arriba
// y la antigüedad del handshake; ni el endpoint WireGuard ni los contadores.
function operatorEncoderStatus(status) {
  if (!status || !status.vpn) return status;
  const { up, handshakeAge } = status.vpn;
  return { ...status, vpn: { up, handshakeAge } };
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
    this.encoders = new Map();  // id encoder -> canal | null
    for (const i of inputs) this.owners.set(String(i.channel), i.owner);
    for (const o of outputs) this.outputs.set(String(o.id), String(o.channel));
    for (const g of grants) {
      if (!this.grants.has(g.username)) this.grants.set(g.username, new Set());
      this.grants.get(g.username).add(String(g.channel));
    }
    for (const e of encoders) {
      this.encoders.set(String(e.id), e.channel == null ? null : String(e.channel));
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

  canSeeEncoder(user, encoderId) {
    if (this._isAdmin(user)) return true;
    const ch = this.encoders.get(String(encoderId));
    return ch != null && this.canSee(user, ch);
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
        return data.filter(e => e && this.canSeeEncoder(user, e.id)).map(operatorEncoderStatus);
      default:
        return undefined;
    }
  }
}

module.exports = { AccessState, ROLE_ADMIN, operatorEncoderStatus };
