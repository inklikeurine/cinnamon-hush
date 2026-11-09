// Store.js on a temporary directory: debounce, flush, corrupt files, delete, state.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const GLib = imports.gi.GLib;
const require = T.makeRequire(ARGV[0]);
const Store = require('./modules/Store').Store;
const History = require('./modules/History').History;

const dir = T.tmpDir('hush-store') + '/data';
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));

T.run('missing files read as null / {}; the directory is created on first write', () => {
    const s = new Store({ dir, debounceMs: 50 });
    T.eq(s.loadHistory(), null, 'no history');
    T.eq(s.loadState(), {}, 'no state');
    T.eq(GLib.file_test(dir, GLib.FileTest.IS_DIR), false, 'dir not created by reads');
    T.eq(s.saveState({ nextId: 42 }), true, 'state written');
    T.eq(GLib.file_test(dir, GLib.FileTest.IS_DIR), true, 'dir created');
    T.eq(s.loadState(), { nextId: 42 }, 'state round trip');
    s.destroy();
});

T.runAsync('saveHistory is debounced: many saves, one write; flush writes now', async () => {
    const s = new Store({ dir, debounceMs: 100 });
    const h = new History({ max: 10 });
    h.add({ id: 1, summary: 'a', body: '', actions: [], time: 1, state: 'unread', hints: {} });
    for (let i = 0; i < 5; i++) s.saveHistory(h.toJSON());
    T.eq(s.writes, 0, 'nothing written yet');
    await sleep(200);
    T.eq(s.writes, 1, 'one write after the debounce');
    const back = History.fromJSON(s.loadHistory());
    T.eq(back.size, 1, 'restored');
    T.eq(back.get(1).summary, 'a', 'content');
    h.add({ id: 2, summary: 'b', body: '', actions: [], time: 2, state: 'read', hints: {} });
    s.saveHistory(h.toJSON());
    T.eq(s.flush(), true, 'flushed immediately');
    T.eq(s.writes, 2, 'second write');
    T.eq(s.flush(), false, 'nothing pending');
    T.eq(History.fromJSON(s.loadHistory()).size, 2, 'both records');
    s.destroy();
    T.eq(s.writes, 2, 'destroy with nothing pending writes nothing');
});

T.run('destroy flushes a pending save; saves after destroy are ignored', () => {
    const s = new Store({ dir, debounceMs: 60000 });
    s.saveHistory({ version: 1, records: [] });
    s.destroy();
    T.eq(s.writes, 1, 'flushed on destroy');
    s.saveHistory({ version: 1, records: [{ id: 9 }] });
    T.eq(s.flush(), false, 'ignored after destroy');
    T.eq(History.fromJSON(s.loadHistory()).size, 0, 'file holds the flushed empty history');
});

T.run('corrupt files never throw; deleteHistory removes the file and any pending save', () => {
    T.writeFile(dir + '/history.json', '{not json');
    T.writeFile(dir + '/state.json', '[1,2]');
    const s = new Store({ dir, debounceMs: 60000 });
    T.eq(History.fromJSON(s.loadHistory()).size, 0, 'corrupt history → empty');
    T.eq(s.loadState(), {}, 'non-object state → {}');
    s.saveHistory({ version: 1, records: [{ id: 1 }] });
    T.eq(s.deleteHistory(), true, 'deleted');
    T.eq(GLib.file_test(dir + '/history.json', GLib.FileTest.EXISTS), false, 'file gone');
    T.eq(s.flush(), false, 'pending save dropped');
    T.eq(s.deleteHistory(), true, 'deleting twice is fine');
    s.destroy();
});

T.run('an unwritable directory is reported, not thrown', () => {
    const s = new Store({ dir: '/proc/hush-cannot-exist', debounceMs: 10 });
    T.eq(s.saveState({ a: 1 }), false, 'write failed');
    T.ok(/cannot/.test(s.lastError), 'lastError set');
    s.destroy();
});

T.exit();
