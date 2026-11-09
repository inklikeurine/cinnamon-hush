// DndState.js: reasons, priority, labels, switchability.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);
const DndState = require('./modules/DndState').DndState;

T.run('off by default', () => {
    const d = new DndState();
    T.eq(d.active, false, 'inactive');
    T.eq(d.reason, null, 'no reason');
    T.eq(d.label(), 'Off', 'label');
    T.eq(d.switchable, true, 'switchable');
});

T.run('set returns whether anything changed', () => {
    const d = new DndState();
    T.eq(d.set('manual', true), true, 'on');
    T.eq(d.set('manual', true), false, 'again');
    T.eq(d.set('manual', false), true, 'off');
    T.eq(d.set('bogus', true), false, 'unknown reason ignored');
    T.eq(d.active, false, 'still off');
});

T.run('priority and labels', () => {
    const d = new DndState();
    d.set('external', true);
    T.eq(d.label(), 'On — set in System Settings', 'external');
    T.eq(d.switchable, false, 'external cannot be switched off here');
    d.set('inhibitor', true, { app: 'OBS' });
    T.eq(d.label(), 'On — OBS is running an inhibitor', 'inhibitor with app');
    d.set('recording', true);
    T.eq(d.label(), 'On — call or recording in progress', 'recording');
    d.set('fullscreen', true);
    T.eq(d.label(), 'On — fullscreen window', 'fullscreen');
    d.set('schedule', true, { until: '07:00' });
    T.eq(d.label(), 'On until 07:00 (schedule)', 'schedule');
    d.set('manual', true);
    T.eq(d.label(), 'On', 'manual');
    T.eq(d.reasons(), ['manual', 'schedule', 'fullscreen', 'recording', 'inhibitor', 'external'], 'all reasons in order');
    T.eq(d.switchable, true, 'manual on top is switchable');
});

T.run('label uses the gettext function passed in', () => {
    const d = new DndState();
    d.set('manual', true);
    T.eq(d.label(s => 'X:' + s), 'X:On', 'translated');
    d.set('schedule', true, { until: '9' }); d.set('manual', false);
    T.eq(d.label(s => '[' + s + ']'), '[On until 9 (schedule)]', 'placeholder substituted after translation');
});

T.run('detail and is', () => {
    const d = new DndState();
    d.set('inhibitor', true, { app: 'obs' });
    T.eq(d.is('inhibitor'), true, 'is');
    T.eq(d.detail('inhibitor'), { app: 'obs' }, 'detail');
    T.eq(d.detail('manual'), null, 'none');
});

T.run('userOff suppresses held automatic reasons until they end; userOn is manual', () => {
    const d = new DndState();
    d.set('fullscreen', true);
    d.set('schedule', true, { until: '07:00' });
    T.eq(d.reason, 'schedule', 'schedule on top');
    T.eq(d.userOff(), true, 'switched off');
    T.eq(d.active, false, 'off although both are still held');
    T.eq(d.isHeld('fullscreen') && d.isHeld('schedule'), true, 'held');
    T.eq(d.isSuppressed('fullscreen') && d.isSuppressed('schedule'), true, 'suppressed');
    T.eq(d.set('fullscreen', true), false, 're-asserting a suppressed reason changes nothing');
    T.eq(d.active, false, 'still off');
    T.eq(d.set('fullscreen', false), false, 'ending it changes nothing visible');
    T.eq(d.isSuppressed('fullscreen'), false, 'suppression cleared with the reason');
    T.eq(d.set('fullscreen', true), true, 'next fullscreen counts again');
    T.eq(d.reason, 'fullscreen', 'fullscreen active, schedule still suppressed');
    T.eq(d.unsuppress('schedule'), true, 'boundary: schedule back');
    T.eq(d.reason, 'schedule', 'schedule on top again');
    T.eq(d.unsuppress('schedule'), false, 'not suppressed any more');
    T.eq(d.userOn(), true, 'manual on');
    T.eq(d.reason, 'manual', 'manual on top');
    T.eq(d.userOn(), false, 'idempotent');
    T.eq(d.userOff(), true, 'off again');
    T.eq(d.active, false, 'everything suppressed');
    T.eq(d.reasons(), [], 'no active reason');
});

T.run('external is never suppressed', () => {
    const d = new DndState();
    d.set('external', true);
    d.set('recording', true);
    T.eq(d.userOff(), true, 'recording suppressed');
    T.eq(d.reason, 'external', 'external stays');
    T.eq(d.suppress('external'), false, 'cannot suppress external');
    T.eq(d.switchable, false, 'switch greyed');
    T.eq(d.set('external', false), true, 'external ends');
    T.eq(d.active, false, 'off; recording still suppressed');
    T.eq(d.set('recording', false), false, 'recording ends quietly');
    T.eq(d.set('recording', true), true, 'and counts again next time');
});

T.exit();
