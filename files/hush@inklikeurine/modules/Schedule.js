// Schedule.js — scheduled Do Not Disturb arithmetic. Pure (no GLib);
// headless-tested in schedule.test.js with fixed dates.
//
//   const cfg = { enabled: true, start: { h: 22, m: 0 }, end: { h: 7, m: 0 }, days: 'every-day' };
//   Schedule.isActive(cfg, new Date())        → true inside the window
//   Schedule.nextBoundary(cfg, new Date())    → Date of the next start or end, or null when disabled
//   Schedule.endOf(cfg, new Date())           → Date the current window ends, or null when not active
//   Schedule.formatTime({ h: 7, m: 0 })        → '07:00'
//
// A window belongs to the day it starts on: with days = 'weekdays' and
// 22:00 → 07:00, Friday 22:00 to Saturday 07:00 is active (starts on a
// weekday) and Sunday 22:00 to Monday 07:00 is not. A window whose end
// equals its start lasts the whole day. Times come from Cinnamon's
// timechooser as { h, m, s }; s is ignored.

var Days = Object.freeze({ EVERY_DAY: 'every-day', WEEKDAYS: 'weekdays', WEEKENDS: 'weekends' });

function _minutes(t) {
    if (!t || typeof t !== 'object') return 0;
    const h = Number.isFinite(t.h) ? Math.min(23, Math.max(0, t.h | 0)) : 0;
    const m = Number.isFinite(t.m) ? Math.min(59, Math.max(0, t.m | 0)) : 0;
    return h * 60 + m;
}

function _dayAllowed(days, dayOfWeek) {          // dayOfWeek: 0 Sunday … 6 Saturday
    if (days === Days.WEEKDAYS) return dayOfWeek >= 1 && dayOfWeek <= 5;
    if (days === Days.WEEKENDS) return dayOfWeek === 0 || dayOfWeek === 6;
    return true;
}

function _dayStart(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function _at(dayStart, minutes) {
    return new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), Math.floor(minutes / 60), minutes % 60, 0, 0);
}

// Length of the window in minutes: overnight when end <= start (equal = 24 h).
function _length(cfg) {
    const s = _minutes(cfg.start), e = _minutes(cfg.end);
    return e > s ? e - s : 1440 - s + e;
}

// Windows that could contain `date`: the one starting today and the one
// starting yesterday (overnight). Each is [start, end) in local time.
function _windowsAround(cfg, date) {
    const out = [];
    const today = _dayStart(date);
    const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
    const len = _length(cfg);
    for (const day of [yesterday, today]) {
        if (!_dayAllowed(cfg.days, day.getDay())) continue;
        const start = _at(day, _minutes(cfg.start));
        out.push({ start, end: new Date(start.getTime() + len * 60 * 1000) });
    }
    return out;
}

function _current(cfg, date) {
    for (const w of _windowsAround(cfg, date))
        if (date >= w.start && date < w.end) return w;
    return null;
}

function isActive(cfg, date) {
    if (!cfg || !cfg.enabled) return false;
    return _current(cfg, date || new Date()) !== null;
}

function endOf(cfg, date) {
    if (!cfg || !cfg.enabled) return null;
    const w = _current(cfg, date || new Date());
    return w ? w.end : null;
}

// The next moment the active state can change (window start or end).
function nextBoundary(cfg, date) {
    if (!cfg || !cfg.enabled) return null;
    const now = date || new Date();
    const w = _current(cfg, now);
    if (w) return w.end;
    // Next allowed start after now, searching up to eight days ahead.
    const today = _dayStart(now);
    for (let i = 0; i < 8; i++) {
        const day = new Date(today.getTime() + i * 24 * 3600 * 1000);
        if (!_dayAllowed(cfg.days, day.getDay())) continue;
        const start = _at(day, _minutes(cfg.start));
        if (start > now) return start;
    }
    return null;
}

function formatTime(t) {
    const m = _minutes(t);
    const h = Math.floor(m / 60), mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
}

// Reads the applet's bound settings into a config object, tolerating junk.
function fromSettings(enabled, start, end, days) {
    const t = v => (v && typeof v === 'object') ? { h: v.h | 0, m: v.m | 0 } : { h: 0, m: 0 };
    return {
        enabled: enabled === true,
        start: t(start),
        end: t(end),
        days: [Days.EVERY_DAY, Days.WEEKDAYS, Days.WEEKENDS].includes(days) ? days : Days.EVERY_DAY
    };
}
