# Energy and connectivity

## macOS sleep

**Settings → Energy** controls keeping the Mac awake while agents work. It does
not keep the display on or prevent normal screen locking. Jobs and subagents count
as work, followed by a 60-second grace period for completion follow-ups.

**Keep going with the lid closed** is opt-in and requires one-time administrator
approval. It needs both external power and usable Wi-Fi. Losing either with the
lid closed pauses agents and restores normal sleep.

While armed, closed-lid mode also blocks **Apple menu → Sleep**, even with the lid
open. Turn it off before manually sleeping. Keep ventilation clear. Closing the
lid is not a reliable screen-lock action in this mode; lock the Mac explicitly.

Sleep pauses retain pending work for a later full wake with connectivity. Interrupted
native commands and jobs are reported as interrupted, not automatically replayed.
Reconnecting Wi-Fi while the lid stays closed is not itself a qualifying wake.

## Lost connectivity

When Pilot detects an outage, chats show **Paused offline** and resume when the
network returns. Authentication, quota, and ordinary provider errors are not offline
pauses. Active tools finish their admitted work rather than being replayed.

**Stop** remains available during a pause and saves cancellation before recovery.
Reading saved history does not restart an agent.

## Linux

The KDE Wayland helper requests automatic-suspend inhibition only. Display sleep,
manual sleep, and lid behavior are not macOS equivalents; real-hardware behavior
remains unqualified. See [platform limits](technical/agent-sleep.md#linux-kde-wayland).
