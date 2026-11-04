// spatial/IdentityRegistry.js — shared identity across PCB and loose modes.
export class IdentityRegistry {
  constructor() { this.identities = new Map(); } // id -> record

  register(id, record) {
    this.identities.set(id, { id, ...record, history: record.history || [] });
  }

  get(id) { return this.identities.get(id) || null; }

  updateLocation(id, loc) {
    const r = this.identities.get(id);
    if (!r) return;
    r.locations = { ...(r.locations || {}), ...loc };
    r.lastSeen = Date.now();
    r.history.push({ t: Date.now(), loc });
    if (r.history.length > 100) r.history.shift();
  }

  markState(id, state) {
    const r = this.identities.get(id);
    if (r) r.state = state;
  }

  transferMode(id, newMode) {
    const r = this.identities.get(id);
    if (r) { r.mode = newMode; r.modeChangedAt = Date.now(); }
  }

  toJSON() { return [...this.identities.values()]; }
  static fromJSON(arr) { const reg = new IdentityRegistry(); for (const r of arr || []) reg.register(r.id, r); return reg; }
}