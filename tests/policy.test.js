// Policy.js: dnd × trayEnabled × urgency × muted × drop × allowCritical.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);
const Policy = require('./modules/Policy');

const rec = (urgency, appId) => ({ urgency, appId: appId || 'org.example.app' });
const ctx = (o) => Object.assign({ dnd: false, trayEnabled: true, allowCritical: true, muted: {} }, o || {});

T.run('no DND: everything gets a banner', () => {
    for (const u of [0, 1, 2]) T.eq(Policy.decide(rec(u), ctx()), 'banner', 'urgency ' + u);
});

T.run('DND: normal/low silent, critical banner when allowed', () => {
    T.eq(Policy.decide(rec(0), ctx({ dnd: true })), 'silent', 'low');
    T.eq(Policy.decide(rec(1), ctx({ dnd: true })), 'silent', 'normal');
    T.eq(Policy.decide(rec(2), ctx({ dnd: true })), 'banner', 'critical allowed');
    T.eq(Policy.decide(rec(2), ctx({ dnd: true, allowCritical: false })), 'silent', 'critical not allowed');
});

T.run('tray disabled (display-notifications=false): never a banner, even critical', () => {
    T.eq(Policy.decide(rec(2), ctx({ trayEnabled: false })), 'silent', 'critical, no dnd');
    T.eq(Policy.decide(rec(1), ctx({ trayEnabled: false, dnd: true })), 'silent', 'normal, dnd');
});

T.run('muted app: silent, or drop with the drop flag, regardless of DND/urgency', () => {
    const muted = { 'org.example.app': { drop: false }, 'org.example.noisy': { drop: true } };
    T.eq(Policy.decide(rec(2), ctx({ muted })), 'silent', 'muted critical');
    T.eq(Policy.decide(rec(1, 'org.example.noisy'), ctx({ muted })), 'drop', 'dropped');
    T.eq(Policy.decide(rec(1, 'org.example.other'), ctx({ muted })), 'banner', 'unmuted');
    T.eq(Policy.decide(rec(1), ctx({ muted: new Map([['org.example.app', { drop: true }]]) })), 'drop', 'Map form');
});

T.run('missing context pieces default sensibly', () => {
    T.eq(Policy.decide(rec(1), {}), 'banner', 'empty ctx');
    T.eq(Policy.decide(rec(1), undefined), 'banner', 'no ctx');
    T.eq(Policy.decide({ urgency: 1 }, ctx({ muted: { unknown: { drop: true } } })), 'banner', 'record without appId');
});

T.run('mutedFromList reads the settings list shape', () => {
    T.eq(Policy.mutedFromList([{ app: ' Org.Example.App ', name: 'App', drop: true }, { app: '' }, null, { name: 'x' }]),
        { 'org.example.app': { drop: true, name: 'App' } }, 'parsed');
    T.eq(Policy.mutedFromList(null), {}, 'null');
});

T.exit();
