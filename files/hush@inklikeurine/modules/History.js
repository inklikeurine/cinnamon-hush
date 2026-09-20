// History.js — the list of notification records behind the drawer. Pure
// (no GLib at all); headless-tested in history.test.js.
//
// Every record has a state:
//   'unread'  — arrived while DND was on, or not yet seen in the drawer
//   'read'    — seen (drawer opened, in `on-open` mode) or explicitly marked
//   'cleared' — dismissed by its × or by Clear all; leaves the drawer, stays
//               stored (shown again by "Show cleared") until pruned or deleted
//
// The cap counts every state; pruning removes the oldest cleared records
// first, then the oldest read ones, then the oldest unread ones.
//
//   const h = new History({ max: 100 });
//   h.add(record)             // new, or replaces the record with the same id
//   h.get(id)
//   h.dismiss(id)             // → 'cleared'
//   h.clearAll()              // every visible record → 'cleared'; returns how many
//   h.markSeen('on-open')     // every 'unread' → 'read'; 'per-row' does nothing
//   h.markRead(id)
//   h.deleteCleared()         // forget cleared records; returns how many
//   h.visible()               // not cleared, newest first
//   h.cleared()               // cleared, newest first
//   h.unreadCount()
//   h.groups(records)         // [{ appId, appLabel, records }] newest group first
//   h.toJSON() / History.fromJSON(text, { max })

var State = Object.freeze({ UNREAD: 'unread', READ: 'read', CLEARED: 'cleared' });

const STORED_FIELDS = [
    'id', 'appName', 'appIcon', 'summary', 'body', 'actions', 'urgency', 'transient', 'resident',
    'desktopEntry', 'category', 'imagePath', 'time', 'expires', 'appId', 'appLabel',
    'state', 'missed', 'closed', 'closedReason', 'senderGone', 'updates', 'test'
];

function _isState(s) {
    return s === State.UNREAD || s === State.READ || s === State.CLEARED;
}

class History {
    constructor(opts) {
        const o = opts || {};
        this._records = [];           // insertion order (oldest first)
        this._byId = new Map();
        this.max = Number.isFinite(o.max) && o.max > 0 ? Math.floor(o.max) : 100;
    }

    get size() { return this._records.length; }

    setMax(n) {
        this.max = Number.isFinite(n) && n > 0 ? Math.floor(n) : this.max;
        return this.prune();
    }

    get(id) {
        return this._byId.get(id) || null;
    }

    // Adds a record or replaces the one with the same id (replaces_id). A
    // replaced record keeps its position but takes the new time, so it
    // sorts as fresh; its unread/read state is reset to what the caller set.
    add(record) {
        if (!record || typeof record.id !== 'number') return null;
        if (!_isState(record.state)) record.state = State.UNREAD;
        const existing = this._byId.get(record.id);
        if (existing) {
            const index = this._records.indexOf(existing);
            record.updates = (existing.updates | 0) + 1;
            this._records[index] = record;
        } else {
            this._records.push(record);
        }
        this._byId.set(record.id, record);
        this.prune();
        return record;
    }

    remove(id) {
        const rec = this._byId.get(id);
        if (!rec) return false;
        this._byId.delete(id);
        const index = this._records.indexOf(rec);
        if (index >= 0) this._records.splice(index, 1);
        return true;
    }

    markRead(id) {
        const rec = this._byId.get(id);
        if (!rec || rec.state !== State.UNREAD) return false;
        rec.state = State.READ;
        return true;
    }

    dismiss(id) {
        const rec = this._byId.get(id);
        if (!rec || rec.state === State.CLEARED) return false;
        rec.state = State.CLEARED;
        return true;
    }

    clearAll() {
        let n = 0;
        for (const rec of this._records)
            if (rec.state !== State.CLEARED) { rec.state = State.CLEARED; n++; }
        return n;
    }

    markSeen(mode) {
        if (mode === 'per-row') return 0;
        let n = 0;
        for (const rec of this._records)
            if (rec.state === State.UNREAD) { rec.state = State.READ; n++; }
        return n;
    }

    deleteCleared() {
        const keep = [];
        let n = 0;
        for (const rec of this._records) {
            if (rec.state === State.CLEARED) { this._byId.delete(rec.id); n++; }
            else keep.push(rec);
        }
        this._records = keep;
        return n;
    }

    // Enforce the cap: cleared → read → unread, oldest first within each.
    prune() {
        let excess = this._records.length - this.max;
        if (excess <= 0) return 0;
        let removed = 0;
        for (const state of [State.CLEARED, State.READ, State.UNREAD]) {
            for (let i = 0; i < this._records.length && excess > 0;) {
                const rec = this._records[i];
                if (rec.state === state) {
                    this._records.splice(i, 1);
                    this._byId.delete(rec.id);
                    excess--; removed++;
                } else {
                    i++;
                }
            }
            if (excess <= 0) break;
        }
        return removed;
    }

    all() {
        return this._records.slice().sort((a, b) => b.time - a.time);
    }

    visible() {
        return this.all().filter(r => r.state !== State.CLEARED);
    }

    cleared() {
        return this.all().filter(r => r.state === State.CLEARED);
    }

    unreadCount() {
        let n = 0;
        for (const rec of this._records) if (rec.state === State.UNREAD) n++;
        return n;
    }

    // Groups a newest-first list by appId, keeping newest group first.
    groups(records) {
        const list = records || this.visible();
        const out = [];
        const byApp = new Map();
        for (const rec of list) {
            const key = rec.appId || 'unknown';
            let g = byApp.get(key);
            if (!g) {
                g = { appId: key, appLabel: rec.appLabel || rec.appName || key, appIcon: rec.appIcon || '', records: [] };
                byApp.set(key, g);
                out.push(g);
            }
            g.records.push(rec);
        }
        return out;
    }

    toJSON() {
        const records = this._records.map(rec => {
            const o = {};
            for (const f of STORED_FIELDS) if (rec[f] !== undefined) o[f] = rec[f];
            return o;
        });
        return { version: 1, records };
    }

    // Never throws: a corrupt or foreign file yields an empty history.
    static fromJSON(text, opts) {
        const h = new History(opts);
        let data = null;
        try {
            data = typeof text === 'string' ? JSON.parse(text) : text;
        } catch (e) {
            return h;
        }
        if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.records)) return h;
        for (const raw of data.records) {
            if (!raw || typeof raw !== 'object') continue;
            if (typeof raw.id !== 'number' || !Number.isFinite(raw.id)) continue;
            const rec = {};
            for (const f of STORED_FIELDS) if (raw[f] !== undefined) rec[f] = raw[f];
            if (typeof rec.summary !== 'string') rec.summary = '';
            if (typeof rec.body !== 'string') rec.body = '';
            if (!Array.isArray(rec.actions)) rec.actions = [];
            if (typeof rec.time !== 'number') rec.time = 0;
            if (!_isState(rec.state)) rec.state = State.READ;
            rec.closed = rec.closed === true;
            rec.senderGone = true;             // the sender cannot survive a session
            rec.hints = {};
            if (h._byId.has(rec.id)) continue;
            h._records.push(rec);
            h._byId.set(rec.id, rec);
        }
        h._records.sort((a, b) => a.time - b.time);
        h.prune();
        return h;
    }
}
