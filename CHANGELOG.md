# Changelog

All notable changes to Hush are recorded here. Versions follow
`metadata.json` (`version`), newest first.

## [0.5.0] — 2026-10-12

### Fixed
- Unread marks were cleared the instant the drawer opened, so they were
  never visible. The panel count still resets on open, but the rows that
  were unread keep their mark until the drawer closes.
- The drawer footer was wider than the drawer (four text buttons in 380 px,
  280 px at the minimum width); it now has one text button and three icon
  buttons with tooltips.

### Changed
- The drawer follows the Cinnamon theme: background, text, border and the
  accent colour of the unread mark and the Do Not Disturb header come from
  the active theme instead of a fixed dark palette.
- Row times are relative: "now", "4 min", the clock time today,
  "Yesterday", the weekday this week, the date before that. The exact date
  and time are in the tooltip; the labels refresh every minute while the
  drawer is open.
- The status line under the Do Not Disturb switch is shown only while Do Not
  Disturb is on. When System Settings has notifications off, the greyed
  switch says so in its tooltip.
- An application's mute button appears when the pointer is over its group;
  a muted application shows a "Muted" label that unmutes it when clicked.
- A row's × is faint until the row is hovered or focused.
- "Show cleared" is an icon toggle in the footer; Hush settings and
  Notification settings are icon buttons.
- The drawer has a border and shadow on its inner edge only.
- Empty list: a large icon, and with Do Not Disturb on, a line saying new
  notifications will wait in the drawer.
- A notification arriving while the drawer is open keeps the scroll
  position and keyboard focus.
- Panel tooltip on two lines (unread count, Do Not Disturb state).
- The panel icon's critical blink fades instead of switching hard.

### Added
- Clear one application: a × in its group header (shown on hover) clears
  all of that application's notifications.
- Right-click menu: a Do Not Disturb switch and Clear all.
- Keyboard in the drawer: Up/Down move between notifications, Enter opens,
  Delete dismisses, Tab walks the buttons, Escape closes.

## [0.4.0] — 2026-09-19

### Added
- The list survives logouts and Cinnamon restarts: stored as plain text in
  `~/.local/share/hush/history.json` (setting "Keep the list across
  logouts", on by default; turning it off deletes the file). Notification
  ids continue across reloads (`~/.local/share/hush/state.json`).
- "Show cleared" in the drawer footer lists cleared entries in a dimmed
  section with "Delete cleared".
- Per-application muting: a mute button next to each application's name in
  the drawer; the list lives in Configure → Do Not Disturb → Muted
  applications, with a "Drop" flag that discards instead of collecting.
- Keyboard shortcuts (Configure → General): open/close the drawer, clear
  all, toggle Do Not Disturb.
- The panel icon blinks while an unread critical notification is waiting
  (setting "Blink the panel icon…", on by default).

## [0.3.1] — 2026-09-19

### Fixed
- Drawer entries overlapped one another as soon as the list was taller
  than the drawer: Cinnamon's scrollable box lays rows out at their
  *minimum* height, and a wrapping label that ellipsizes reports a minimum
  of a few pixels. Body labels now wrap without ellipsis (min = natural)
  and long bodies are cut by text to four lines / 240 characters instead of
  by CSS max-height.

### Changed
- The Do Not Disturb status line is prominent while it is on: bold, white,
  slightly larger, with a crossed-bell icon and a tinted header — so
  "On — call or recording in progress" is visible at a glance.

## [0.3.0] — 2026-09-19

### Added
- Scheduled Do Not Disturb: start and end times (overnight ranges allowed)
  on every day, weekdays or weekends; a window belongs to the day it
  starts on. Status line "On until 07:00 (schedule)".
- Automatic Do Not Disturb, each with its own switch: while a window is
  fullscreen (any monitor or the primary one), while a call or recording is
  in progress (an application holds a microphone/capture stream on the
  sound server), and while a listed application (OBS, Discord, … —
  editable list) holds a session inhibitor. Status line names the reason.
- Switching Do Not Disturb off while a schedule or trigger holds it
  overrides that source until it ends (for the schedule, until its next
  boundary); switching it on is a plain manual override.
- Settings dialog: new **Do Not Disturb** page (critical exception,
  schedule, automatic triggers); Test page gained "Hold a test inhibitor
  for 10 seconds".
- Vendored shared modules `Dnd.js` (the system-wide notifications key) and
  `Inhibitors.js` (session inhibitors) alongside `DBusProxy.js`.

### Changed
- The System Settings notifications switch is read through the shared
  `Dnd.js` module (behaviour unchanged).

## [0.2.0] — 2026-09-19

### Added
- Settings → **Test** page: buttons that send canned notifications through
  the session bus exactly as an application would (normal, low, critical,
  with actions, body markup, transient, silent, with image, from a known
  application, long, updating in place, a burst of five from three apps),
  plus Toggle Do Not Disturb, Open the drawer and Clear all test
  notifications. Test notifications carry the hint `x-hush-test`.

## [0.1.0] — 2026-09-19

### Added
- First milestone: Hush takes over the org.freedesktop.Notifications intake
  in-process while on the panel and restores Cinnamon's own handler on
  removal or reload.
- Sliding drawer from the left or right screen edge (automatic, left or
  right), full work-area height, notifications grouped by application with
  body, time, action buttons and per-entry dismiss; Clear all; buttons for
  Hush's settings and Cinnamon's notification settings.
- Do Not Disturb switch (drawer header, middle-click). Notifications
  arriving during Do Not Disturb are collected silently and marked unread;
  the panel shows the unread count; nothing is replayed afterwards.
  Notifications turned off in System Settings count as Do Not Disturb.
- Settings: show critical notifications during Do Not Disturb, drawer
  edge and width, when unread marks clear, entries kept (20–500), keep
  transient notifications, show the unread count.
