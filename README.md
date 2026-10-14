# Hush

Notification centre with Do Not Disturb and a list that slides in from the
edge of the screen.

Hush takes over the intake of Cinnamon's notification system while it is on
the panel: every notification an application sends becomes an entry in
Hush's list, whether or not a banner was shown. With Do Not Disturb on,
nothing pops up and nothing plays, but nothing is lost either — the entries
wait in the drawer with an unread mark and the panel shows how many. When
Do Not Disturb ends, nothing is replayed. Click the panel icon and the
drawer slides in from the left or right edge, full height, grouped by
application. Remove Hush and Cinnamon's own notification handling is back,
exactly as it was.

Hush replaces the built-in **Notifications** applet; keep only one of the
two on your panels.

## Features

- Sliding drawer (left or right edge, automatic by default) listing every
  notification grouped by application, newest first, with a relative time
  ("now", "4 min", "Yesterday"), body, action buttons and a dismiss button
  per entry; it takes its colours from the active Cinnamon theme
- Do Not Disturb switch in the drawer header, in the panel icon's
  right-click menu and on middle-click; the status line says why it is on
- Scheduled Do Not Disturb: start/end times (overnight is fine), every day,
  weekdays or weekends
- Automatic Do Not Disturb while a window is fullscreen, while a call or
  recording is in progress (an application has the microphone open), or
  while a listed application such as OBS holds a session inhibitor — each
  can be turned off separately
- Switching Do Not Disturb off while a schedule or trigger holds it
  overrides that source until it ends
- Notifications that arrive during Do Not Disturb are collected silently
  and marked unread; the panel icon shows the unread count, and the new
  entries stay marked while the drawer is open
- Critical notifications can still show a banner during Do Not Disturb
  (setting)
- Notifications turned off in *System Settings → Notifications* are
  honoured as Do Not Disturb too ("set in System Settings")
- Clear all keeps the entries stored (up to a cap you choose); "Show
  cleared" brings them back in a dimmed section, "Delete cleared" forgets
  them
- The list survives logouts and Cinnamon restarts (can be turned off)
- Mute an application with the button next to its name: no banner, no
  sound, still collected — or dropped entirely with the "Drop" flag
- Clear one application's notifications from its group header
- Keyboard shortcuts for opening the drawer, clearing and toggling Do Not
  Disturb; the panel icon blinks while an unread critical notification waits
- Optional: do not keep transient notifications (volume, progress)
- Removing or reloading the applet restores the stock notification daemon

## Requirements

- Cinnamon 6.6+ on X11 (Linux Mint 22.3+). Wayland sessions are not supported.
- No external commands or packages. Everything runs inside Cinnamon.
- If a future Cinnamon changes how its notification daemon is built, Hush
  cannot take over the intake; it then logs one warning, shows a notice in
  the drawer, and the built-in daemon keeps handling notifications (Do Not
  Disturb still works, but nothing is collected).

## Install

Clone the repository, copy (or symlink) the applet's inner folder into
Cinnamon's user applet directory, then add it from *System Settings → Applets*:

```sh
git clone https://github.com/inklikeurine/cinnamon-hush
cp -r cinnamon-hush/files/hush@inklikeurine ~/.local/share/cinnamon/applets/
```

Source: <https://github.com/inklikeurine/cinnamon-hush>

## Usage

1. Add **Hush** to a panel (*Right-click panel → Applets*) and remove the
   built-in *Notifications* applet.
2. Left-click the icon: the drawer slides in. Entries that arrived since
   you last looked carry a coloured mark until you close the drawer. Click
   an entry to open its application, press an action button to answer it,
   or `×` to dismiss it. Point at an application's group to show its
   buttons: the bell mutes that application (a "Muted" label then stays;
   click it to unmute) and `×` clears all of its entries. *Clear all* at
   the bottom dismisses everything; the clock button next to it shows what
   was dismissed, with *Delete cleared* to forget it; the gear opens Hush's
   settings and the last button Cinnamon's notification settings. Point at
   a time to see the exact date. Escape, a click outside or another click
   on the icon closes the drawer. From the keyboard: Up/Down move between
   entries, Enter opens one, Delete dismisses it, Tab reaches the buttons.
3. Turn Do Not Disturb on with the switch at the top of the drawer, from
   the icon's right-click menu, or by middle-clicking the icon. The icon
   changes and a status line appears under the switch saying "On". Banners and sounds stop; entries collect with an unread mark.
   When a schedule or an automatic trigger turned it on, the status line
   says which ("On until 07:00 (schedule)", "On — fullscreen window",
   "On — call or recording in progress", "On — obs is running an
   inhibitor"); switching it off then overrides that source until it ends.
4. Right-click → *Configure…* → **Do Not Disturb**: whether critical
   notifications still show a banner during Do Not Disturb; the schedule
   (start, end, days); the automatic triggers and the list of applications
   whose session inhibitors count as recording; the muted applications
   (with a "Drop" flag to discard their notifications instead of
   collecting them). **General**: drawer edge and width; when unread marks
   clear (when the drawer opens, or only when an entry is dismissed); how
   many entries are kept and whether the list survives logouts; whether
   transient notifications are kept; the unread count and the critical
   blink on the panel; keyboard shortcuts.
5. The **Test** tab of that dialog sends sample notifications of every kind
   (normal, low, critical, with actions, markup, transient, silent, with an
   image, from a known application, long, one that updates itself, a burst
   from three apps) through the same bus path real applications use, so
   you can see what Hush does with each — with Do Not Disturb on or off —
   and clear them again with one button.

## Notes / caveats

- Runtime data: `~/.local/share/hush/history.json` (the list, as plain
  text — titles and bodies of your notifications are readable there by
  anyone with access to your home directory; turn "Keep the list across
  logouts" off in Configure → General to delete it and keep the list in
  memory only) and `~/.local/share/hush/state.json` (the next notification
  id). Nothing under `~/.cache`.
- Network requests: none.
- Hush's Do Not Disturb is its own state; it does **not** change the
  *Notifications* switch in System Settings. The other direction works:
  turning notifications off in System Settings counts as Do Not Disturb in
  Hush (and, as always in Cinnamon, no banner at all is shown then — not
  even critical ones).
- Hush relies on one private detail of Cinnamon's notification daemon (the
  object it exports on the session bus). Cinnamon 6.6 is what it was built
  against; a future release could change that detail, in which
  case Hush falls back as described under Requirements.
- "Call or recording in progress" is a heuristic: it is true whenever any
  application holds a recording stream on the sound server (level meters
  such as pavucontrol's are ignored). A browser tab that was granted the
  microphone counts, an idle OBS with a microphone source counts, a screen
  recording without audio does not. X11 offers no direct "screen is being
  captured" signal.
- The session-inhibitor trigger sees applications that use the GNOME
  session manager or the desktop portal (OBS while recording or streaming);
  Chromium and Electron apps (Discord's desktop client) use the older
  screensaver interface that cinnamon-session does not list, so Discord is
  caught by the microphone trigger instead.
- Notifications shown by other applets directly through the message tray
  (for example the network applet's own "connected" banner) do not come
  through the notification bus and are not listed.
- Applications that ask the server for its name get "Hush" instead of
  "cinnamon" while Hush is installed. None are known to care.
- While Hush is on the panel, the built-in *Notifications* applet, if
  still present, lists none of the notifications Hush handles — Hush takes
  its banners back from the tray after they hide.

## AI-generated

This applet was generated by an AI agent under human direction. Use it at
your own risk; read the source before installing.

## License

AI code generators are trained on enormous pools of public code, released under
every license imaginable — permissive, copyleft, and non-commercial alike. The
origin of any individual generated line is untraceable. Output built from that
pool cannot honestly be owned by anyone.

My position: code built from the commons belongs to the commons. Since no one
can know which licenses any given line was originally released under,
AI-generated code should be treated as unlicensable — public domain by default.

Accordingly, all code in this repository is released into the public domain
under the [Unlicense](UNLICENSE).
