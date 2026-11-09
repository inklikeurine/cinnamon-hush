// History.js: states, replace-by-id, clear/dismiss, markSeen modes, prune order, JSON round-trip.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);
const History = require('./modules/History').History;

let t = 1000;
const rec = (id, extra) => Object.assign({ id, appId: 'app', appLabel: 'App', appName: 'App', summary: 's' + id, body: '', actions: [], urgency: 1, time: t += 10, state: 'unread', hints: { 'image-data': [1] } }, extra || {});

T.run('add / get / visible newest first / unread count', () => {
    const h = new History({ max: 100 });
    h.add(rec(1)); h.add(rec(2)); h.add(rec(3));
    T.eq(h.size, 3, 'size');
    T.eq(h.get(2).summary, 's2', 'get');
    T.eq(h.visible().map(r => r.id), [3, 2, 1], 'newest first');
    T.eq(h.unreadCount(), 3, 'unread');
});

T.run('replace by id keeps one record, bumps updates, keeps position', () => {
    const h = new History({ max: 100 });
    h.add(rec(1)); h.add(rec(2));
    const r = h.add(rec(1, { summary: 'new' }));
    T.eq(h.size, 2, 'still two');
    T.eq(h.get(1).summary, 'new', 'replaced');
    T.eq(r.updates, 1, 'updates counted');
    T.eq(h.visible()[0].id, 1, 'replaced record is newest by time');
});

T.run('dismiss → cleared; clearAll clears visible only; deleteCleared forgets them', () => {
    const h = new History({ max: 100 });
    h.add(rec(1)); h.add(rec(2)); h.add(rec(3));
    T.eq(h.dismiss(2), true, 'dismissed');
    T.eq(h.dismiss(2), false, 'already cleared');
    T.eq(h.dismiss(99), false, 'unknown');
    T.eq(h.visible().map(r => r.id), [3, 1], 'visible');
    T.eq(h.cleared().map(r => r.id), [2], 'cleared');
    T.eq(h.clearAll(), 2, 'cleared two more');
    T.eq(h.visible(), [], 'nothing visible');
    T.eq(h.size, 3, 'still stored');
    T.eq(h.deleteCleared(), 3, 'deleted');
    T.eq(h.size, 0, 'empty');
});

T.run('markSeen: on-open marks every unread read; per-row does nothing; markRead per record', () => {
    const h = new History({ max: 100 });
    h.add(rec(1)); h.add(rec(2)); h.add(rec(3, { state: 'read' }));
    T.eq(h.markSeen('per-row'), 0, 'per-row no-op');
    T.eq(h.unreadCount(), 2, 'still unread');
    T.eq(h.markRead(1), true, 'one read');
    T.eq(h.markRead(1), false, 'already');
    T.eq(h.markSeen('on-open'), 1, 'remaining marked');
    T.eq(h.unreadCount(), 0, 'none');
});

T.run('prune order: cleared first, then read, then unread, oldest first within each', () => {
    const h = new History({ max: 4 });
    h.add(rec(1, { state: 'unread' }));
    h.add(rec(2, { state: 'read' }));
    h.add(rec(3, { state: 'cleared' }));
    h.add(rec(4, { state: 'read' }));
    h.add(rec(5, { state: 'cleared' }));   // 5 records, cap 4 → drop oldest cleared (3)
    T.eq(h.all().map(r => r.id).sort(), [1, 2, 4, 5], 'oldest cleared pruned');
    h.add(rec(6));                          // → drop the other cleared (5)
    T.eq(h.all().map(r => r.id).sort(), [1, 2, 4, 6], 'second cleared pruned');
    h.add(rec(7));                          // no cleared left → oldest read (2)
    T.eq(h.all().map(r => r.id).sort(), [1, 4, 6, 7], 'oldest read pruned');
    h.add(rec(8)); h.add(rec(9));           // read 4 goes, then oldest unread 1
    T.eq(h.all().map(r => r.id).sort(), [6, 7, 8, 9], 'oldest unread pruned last');
    T.eq(h.setMax(2), 2, 'setMax prunes');
    T.eq(h.size, 2, 'size after setMax');
});

T.run('groups by appId, newest group first, records newest first inside', () => {
    const h = new History({ max: 100 });
    h.add(rec(1, { appId: 'a', appLabel: 'A' }));
    h.add(rec(2, { appId: 'b', appLabel: 'B' }));
    h.add(rec(3, { appId: 'a', appLabel: 'A' }));
    const g = h.groups();
    T.eq(g.map(x => x.appId), ['a', 'b'], 'group order');
    T.eq(g[0].records.map(r => r.id), [3, 1], 'inside order');
    T.eq(g[0].appLabel, 'A', 'label');
});

T.run('toJSON stores a whitelist (no hints), fromJSON restores and sanitises', () => {
    const h = new History({ max: 100 });
    h.add(rec(1, { state: 'read', closed: true, closedReason: 1 }));
    h.add(rec(2));
    const json = JSON.stringify(h.toJSON());
    T.ok(!json.includes('image-data'), 'hints not stored');
    const back = History.fromJSON(json, { max: 100 });
    T.eq(back.size, 2, 'restored');
    T.eq(back.get(1).state, 'read', 'state kept');
    T.eq(back.get(1).closed, true, 'closed kept');
    T.eq(back.get(2).senderGone, true, 'sender cannot survive a session');
    T.eq(back.get(2).hints, {}, 'hints empty');
    T.eq(back.visible().map(r => r.id), [2, 1], 'order by time');
});

T.run('fromJSON never throws: corrupt, wrong version, junk records', () => {
    T.eq(History.fromJSON('{not json', { max: 5 }).size, 0, 'corrupt');
    T.eq(History.fromJSON('null').size, 0, 'null');
    T.eq(History.fromJSON('{"version":2,"records":[]}').size, 0, 'wrong version');
    const h = History.fromJSON({ version: 1, records: [null, 5, { id: 'x' }, { id: 3, state: 'bogus', summary: 7 }, { id: 3 }] });
    T.eq(h.size, 1, 'one valid, duplicate dropped');
    T.eq(h.get(3).state, 'read', 'bogus state → read');
    T.eq(h.get(3).summary, '', 'non-string summary → empty');
    T.eq(h.get(3).actions, [], 'actions default');
});

T.run('clearApp clears one application\'s visible records only', () => {
    const h = new History({ max: 100 });
    h.add(rec(1, { appId: 'mail' })); h.add(rec(2, { appId: 'chat' })); h.add(rec(3, { appId: 'mail' }));
    h.dismiss(3);
    T.eq(h.clearApp('mail'), 1, 'one visible mail record cleared');
    T.eq(h.visible().map(r => r.id), [2], 'chat stays');
    T.eq(h.cleared().map(r => r.id).sort(), [1, 3], 'both mail records cleared');
    T.eq(h.clearApp('mail'), 0, 'nothing left');
    T.eq(h.clearApp('nobody'), 0, 'unknown app');
    T.eq(h.size, 3, 'still stored');
});

T.run('add ignores junk; remove works', () => {
    const h = new History({ max: 10 });
    T.eq(h.add(null), null, 'null');
    T.eq(h.add({ id: 'no' }), null, 'bad id');
    h.add(rec(1));
    T.eq(h.remove(1), true, 'removed');
    T.eq(h.remove(1), false, 'gone');
});

T.exit();
