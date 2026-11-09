// TimeFmt.js: now / minutes / today's clock / Yesterday / weekday / day-month (+ year), clock skew, gettext.
imports.searchPath.unshift(ARGV[1]);
const T = imports.lib;
const require = T.makeRequire(ARGV[0]);
const TimeFmt = require('./modules/TimeFmt');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// Monday 12 October 2026, 19:10 local time.
const NOW = new Date(2026, 9, 12, 19, 10, 0).getTime();
const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi, 0).getTime();

T.run('under a minute either side of now is "now"', () => {
    T.eq(TimeFmt.relative(NOW, NOW), 'now', 'same instant');
    T.eq(TimeFmt.relative(NOW - 30 * 1000, NOW), 'now', '30 s ago');
    T.eq(TimeFmt.relative(NOW + 30 * 1000, NOW), 'now', '30 s ahead (sender clock)');
});

T.run('under an hour counts minutes', () => {
    T.eq(TimeFmt.relative(NOW - 3 * MIN, NOW), '3 min', '3 min');
    T.eq(TimeFmt.relative(NOW - 59 * MIN - 59 * 1000, NOW), '59 min', 'just under an hour');
});

T.run('earlier today shows the clock', () => {
    const ms = at(2026, 9, 12, 16, 5);
    T.eq(TimeFmt.relative(ms, NOW), TimeFmt.clock(ms), 'clock time');
    T.ok(/5/.test(TimeFmt.clock(ms)), 'clock mentions the minutes: ' + TimeFmt.clock(ms));
    const midnight = at(2026, 9, 12, 0, 0);
    T.eq(TimeFmt.relative(midnight, NOW), TimeFmt.clock(midnight), 'midnight is today');
});

T.run('across midnight: minutes first, then Yesterday', () => {
    const justAfter = at(2026, 9, 13, 0, 20);
    T.eq(TimeFmt.relative(at(2026, 9, 12, 23, 59), justAfter), '21 min', '21 min ago, yesterday by the calendar');
    T.eq(TimeFmt.relative(at(2026, 9, 11, 7, 58), NOW), 'Yesterday', 'yesterday morning');
    T.eq(TimeFmt.relative(at(2026, 9, 11, 23, 59), NOW), 'Yesterday', 'yesterday late');
});

T.run('this week shows the weekday, older the day and month', () => {
    const fri = at(2026, 9, 9, 11, 20);
    const wd = TimeFmt.relative(fri, NOW);
    T.ok(wd !== 'Yesterday' && wd.length > 0 && wd.length <= 12, 'weekday label: ' + wd);
    T.eq(wd, new Date(fri).toLocaleDateString([], { weekday: 'short' }), 'locale weekday');
    const sixDays = at(2026, 9, 6, 9, 0);
    T.eq(TimeFmt.relative(sixDays, NOW), new Date(sixDays).toLocaleDateString([], { weekday: 'short' }), 'six days back is still a weekday');
    const sevenDays = at(2026, 9, 5, 9, 0);
    T.eq(TimeFmt.relative(sevenDays, NOW), new Date(sevenDays).toLocaleDateString([], { day: 'numeric', month: 'short' }), 'a week back is a date');
    const lastMonth = at(2026, 8, 12, 21, 0);
    T.ok(!/2026/.test(TimeFmt.relative(lastMonth, NOW)), 'same year: no year');
    T.ok(/2025/.test(TimeFmt.relative(at(2025, 11, 30, 9, 0), NOW)), 'last year: year shown');
});

T.run('far-future and junk values', () => {
    const later = at(2026, 9, 12, 21, 0);
    T.eq(TimeFmt.relative(later, NOW), TimeFmt.clock(later), 'later today (clock ahead): clock');
    const nextMonth = at(2026, 10, 20, 9, 0);
    T.eq(TimeFmt.relative(nextMonth, NOW), new Date(nextMonth).toLocaleDateString([], { day: 'numeric', month: 'short' }), 'next month: a date');
    T.eq(TimeFmt.relative(NaN, NOW), '', 'NaN');
    T.eq(TimeFmt.relative(undefined, NOW), '', 'undefined');
    T.eq(TimeFmt.exact(NaN), '', 'exact NaN');
});

T.run('the three words go through gettext', () => {
    const _ = s => '[' + s + ']';
    T.eq(TimeFmt.relative(NOW, NOW, _), '[now]', 'now');
    T.eq(TimeFmt.relative(NOW - 5 * MIN, NOW, _), '[5 min]', 'minutes (format string translated, then filled)');
    T.eq(TimeFmt.relative(at(2026, 9, 11, 9, 0), NOW, _), '[Yesterday]', 'Yesterday');
});

T.run('exact gives a full date and time', () => {
    const ms = at(2026, 9, 11, 7, 58);
    const s = TimeFmt.exact(ms);
    T.ok(/2026/.test(s) && /58/.test(s) && /11/.test(s), 'year, minutes and day present: ' + s);
});

T.exit();
