// Schedule.js: overnight ranges, day masks, boundaries, on fixed local dates.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);
const S = require('./modules/Schedule');

// 2026-09-14 is a Monday; 2026-09-19 a Saturday; 2026-09-20 a Sunday.
const d = (y, mo, day, h, m) => new Date(y, mo - 1, day, h, m, 0, 0);
const night = { enabled: true, start: { h: 22, m: 0 }, end: { h: 7, m: 0 }, days: 'every-day' };
const lunch = { enabled: true, start: { h: 12, m: 0 }, end: { h: 13, m: 30 }, days: 'every-day' };

T.run('disabled: never active, no boundary', () => {
    const off = Object.assign({}, night, { enabled: false });
    T.eq(S.isActive(off, d(2026, 9, 14, 23, 0)), false, 'inactive');
    T.eq(S.nextBoundary(off, d(2026, 9, 14, 23, 0)), null, 'no boundary');
    T.eq(S.endOf(off, d(2026, 9, 14, 23, 0)), null, 'no end');
    T.eq(S.isActive(null, new Date()), false, 'null cfg');
});

T.run('overnight window: active late evening and early morning, not midday', () => {
    T.eq(S.isActive(night, d(2026, 9, 14, 23, 0)), true, '23:00');
    T.eq(S.isActive(night, d(2026, 9, 15, 3, 0)), true, '03:00');
    T.eq(S.isActive(night, d(2026, 9, 15, 6, 59)), true, '06:59');
    T.eq(S.isActive(night, d(2026, 9, 15, 7, 0)), false, '07:00 end is exclusive');
    T.eq(S.isActive(night, d(2026, 9, 15, 12, 0)), false, 'noon');
    T.eq(S.isActive(night, d(2026, 9, 15, 22, 0)), true, '22:00 start is inclusive');
});

T.run('same-day window', () => {
    T.eq(S.isActive(lunch, d(2026, 9, 14, 12, 30)), true, '12:30');
    T.eq(S.isActive(lunch, d(2026, 9, 14, 13, 30)), false, '13:30');
    T.eq(S.isActive(lunch, d(2026, 9, 14, 11, 59)), false, '11:59');
});

T.run('weekdays: a window belongs to the day it starts on', () => {
    const wd = Object.assign({}, night, { days: 'weekdays' });
    T.eq(S.isActive(wd, d(2026, 9, 18, 23, 0)), true, 'Friday 23:00');
    T.eq(S.isActive(wd, d(2026, 9, 19, 3, 0)), true, 'Saturday 03:00 (started Friday)');
    T.eq(S.isActive(wd, d(2026, 9, 19, 23, 0)), false, 'Saturday 23:00');
    T.eq(S.isActive(wd, d(2026, 9, 20, 23, 0)), false, 'Sunday 23:00');
    T.eq(S.isActive(wd, d(2026, 9, 21, 3, 0)), false, 'Monday 03:00 (started Sunday)');
    T.eq(S.isActive(wd, d(2026, 9, 21, 23, 0)), true, 'Monday 23:00');
});

T.run('weekends', () => {
    const we = Object.assign({}, lunch, { days: 'weekends' });
    T.eq(S.isActive(we, d(2026, 9, 19, 12, 30)), true, 'Saturday');
    T.eq(S.isActive(we, d(2026, 9, 20, 12, 30)), true, 'Sunday');
    T.eq(S.isActive(we, d(2026, 9, 21, 12, 30)), false, 'Monday');
});

T.run('nextBoundary: end while active, next start otherwise, skipping disallowed days', () => {
    T.eq(S.nextBoundary(night, d(2026, 9, 14, 23, 0)).getTime(), d(2026, 9, 15, 7, 0).getTime(), 'end tomorrow');
    T.eq(S.nextBoundary(night, d(2026, 9, 15, 12, 0)).getTime(), d(2026, 9, 15, 22, 0).getTime(), 'start tonight');
    T.eq(S.nextBoundary(night, d(2026, 9, 15, 7, 0)).getTime(), d(2026, 9, 15, 22, 0).getTime(), 'at the end → next start');
    const wd = Object.assign({}, night, { days: 'weekdays' });
    T.eq(S.nextBoundary(wd, d(2026, 9, 19, 12, 0)).getTime(), d(2026, 9, 21, 22, 0).getTime(), 'Saturday noon → Monday 22:00');
    T.eq(S.nextBoundary(wd, d(2026, 9, 19, 3, 0)).getTime(), d(2026, 9, 19, 7, 0).getTime(), 'Saturday 03:00 → end of Friday window');
    T.eq(S.endOf(night, d(2026, 9, 15, 3, 0)).getTime(), d(2026, 9, 15, 7, 0).getTime(), 'endOf');
});

T.run('end equal to start = whole day; formatTime; fromSettings tolerates junk', () => {
    const all = { enabled: true, start: { h: 9, m: 0 }, end: { h: 9, m: 0 }, days: 'every-day' };
    T.eq(S.isActive(all, d(2026, 9, 14, 8, 59)), true, 'always on');
    T.eq(S.nextBoundary(all, d(2026, 9, 14, 8, 59)).getTime(), d(2026, 9, 14, 9, 0).getTime(), 'boundary at 09:00');
    T.eq(S.formatTime({ h: 7, m: 5 }), '07:05', 'pad');
    T.eq(S.formatTime({ h: 23, m: 59, s: 10 }), '23:59', 'seconds ignored');
    T.eq(S.formatTime(null), '00:00', 'null');
    T.eq(S.fromSettings(true, { h: 22, m: 0, s: 0 }, { h: 7, m: 30, s: 0 }, 'weekdays'),
        { enabled: true, start: { h: 22, m: 0 }, end: { h: 7, m: 30 }, days: 'weekdays' }, 'parsed');
    T.eq(S.fromSettings('yes', 'x', null, 'sometimes'), { enabled: false, start: { h: 0, m: 0 }, end: { h: 0, m: 0 }, days: 'every-day' }, 'junk');
});

T.exit();
