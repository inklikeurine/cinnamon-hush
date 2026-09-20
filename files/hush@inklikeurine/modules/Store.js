// Store.js — Hush's runtime files under ~/.local/share/hush/:
//   history.json   the History (records + states), written debounced
//   state.json     small things that must survive a reload: the next
//                  notification id, so ids never collide with restored records
// Pure GLib; headless-tested in store.test.js on a temporary directory.
// Reads are defensive (a missing or corrupt file yields null); writes are
// small and synchronous (GLib.file_set_contents, well under a millisecond)
// but coalesced: saveHistory() writes at most once per `debounceMs`.
//
//   const store = new Store({ dir: GLib.get_home_dir() + '/.local/share/hush' });
//   store.loadHistory()              → text or null
//   store.saveHistory(obj)           → debounced write of JSON.stringify(obj)
//   store.flush()                    → write now if a save is pending
//   store.deleteHistory()            → remove the file (persistence turned off)
//   store.loadState() / saveState(obj)   → immediate
//   store.destroy()                  → flush and stop timers

const GLib = imports.gi.GLib;

var HISTORY_FILE = 'history.json';
var STATE_FILE = 'state.json';

function _log(level, msg) {
    const g = globalThis.global;
    if (g && typeof g[level] === 'function') g[level]('[hush] ' + msg);
}

class Store {
    constructor(opts) {
        const o = opts || {};
        this.dir = o.dir || (GLib.get_home_dir() + '/.local/share/hush');
        this.debounceMs = Number.isFinite(o.debounceMs) ? o.debounceMs : 2000;
        this._pending = null;       // object waiting to be written
        this._timer = 0;
        this._destroyed = false;
        this.writes = 0;
        this.lastError = null;
    }

    get historyPath() { return this.dir + '/' + HISTORY_FILE; }
    get statePath() { return this.dir + '/' + STATE_FILE; }

    _ensureDir() {
        if (GLib.file_test(this.dir, GLib.FileTest.IS_DIR)) return true;
        const rc = GLib.mkdir_with_parents(this.dir, 0o700);
        if (rc !== 0) { this.lastError = 'cannot create ' + this.dir; _log('logWarning', this.lastError); return false; }
        return true;
    }

    _read(path) {
        try {
            if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR)) return null;
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok) return null;
            return new TextDecoder().decode(bytes);
        } catch (e) {
            this.lastError = 'cannot read ' + path + ': ' + e.message;
            _log('logWarning', this.lastError);
            return null;
        }
    }

    _write(path, text) {
        if (!this._ensureDir()) return false;
        try {
            GLib.file_set_contents(path, text);
            this.writes++;
            this.lastError = null;
            return true;
        } catch (e) {
            this.lastError = 'cannot write ' + path + ': ' + e.message;
            _log('logWarning', this.lastError);
            return false;
        }
    }

    loadHistory() { return this._read(this.historyPath); }

    saveHistory(obj) {
        if (this._destroyed) return;
        this._pending = obj;
        if (this._timer) return;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.debounceMs, () => {
            this._timer = 0;
            this.flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    flush() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        if (this._pending === null) return false;
        const obj = this._pending;
        this._pending = null;
        return this._write(this.historyPath, JSON.stringify(obj));
    }

    deleteHistory() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        this._pending = null;
        try {
            if (GLib.file_test(this.historyPath, GLib.FileTest.EXISTS)) GLib.unlink(this.historyPath);
            return true;
        } catch (e) {
            this.lastError = 'cannot delete ' + this.historyPath + ': ' + e.message;
            return false;
        }
    }

    loadState() {
        const text = this._read(this.statePath);
        if (text === null) return {};
        try {
            const obj = JSON.parse(text);
            return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
        } catch (e) {
            return {};
        }
    }

    saveState(obj) {
        return this._write(this.statePath, JSON.stringify(obj || {}));
    }

    destroy() {
        if (this._destroyed) return;
        this.flush();
        this._destroyed = true;
    }
}
