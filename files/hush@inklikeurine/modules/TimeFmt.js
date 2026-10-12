// TimeFmt.js — the time shown on a drawer row, relative to now. Pure (no
// GLib); headless-tested in timefmt.test.js.
//
//   TimeFmt.relative(ms, nowMs, _)  → 'now' | '4 min' | '4:05 PM' (today) |
//                                     'Yesterday' | 'Fri' (this week) |
//                                     '12 Sep' (older; with the year if not this year)
//   TimeFmt.exact(ms)               → 'Sunday, 11 October 2026, 7:58 AM' (locale order)
//   TimeFmt.clock(ms)               → '4:05 PM' / '16:05' per locale
//
// Clocks and dates follow the system locale; the three words go through
// gettext (`_`, identity when omitted).

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function _startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function _pad(n) {
    return n < 10 ? '0' + n : String(n);
}

function clock(ms) {
    try {
        return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
        const d = new Date(ms);
        return _pad(d.getHours()) + ':' + _pad(d.getMinutes());
    }
}

function _weekday(ms) {
    try {
        return new Date(ms).toLocaleDateString([], { weekday: 'short' });
    } catch (e) {
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ms).getDay()];
    }
}

function _dayMonth(ms, nowMs) {
    const d = new Date(ms);
    const opts = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date(nowMs).getFullYear()) opts.year = 'numeric';
    try {
        return d.toLocaleDateString([], opts);
    } catch (e) {
        return d.getDate() + '/' + (d.getMonth() + 1) + (opts.year ? '/' + d.getFullYear() : '');
    }
}

function relative(ms, nowMs, gettext) {
    const _ = typeof gettext === 'function' ? gettext : (s => s);
    if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return '';
    const diff = nowMs - ms;
    // Up to a minute either side of now (a sender's clock may run ahead).
    if (diff < MINUTE && diff > -MINUTE) return _('now');
    if (diff > 0 && diff < HOUR) return _('%d min').replace('%d', String(Math.floor(diff / MINUTE)));
    const today = _startOfDay(nowMs);
    const tomorrow = _startOfDay(today + 36 * HOUR);
    if (ms >= today && ms < tomorrow) return clock(ms);
    if (ms < today) {
        // Whole calendar days back; rounding absorbs 23/25-hour DST days.
        const days = Math.round((today - _startOfDay(ms)) / (24 * HOUR));
        if (days === 1) return _('Yesterday');
        if (days < 7) return _weekday(ms);
    }
    return _dayMonth(ms, nowMs);
}

function exact(ms) {
    if (!Number.isFinite(ms)) return '';
    try {
        return new Date(ms).toLocaleString([], {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit'
        });
    } catch (e) {
        return new Date(ms).toString();
    }
}
