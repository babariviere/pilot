# Running jobs above the composer

`session_jobs.rs` and `session_jobs_tray.rs` show the selected chat's running
background jobs in a quiet strip above the composer, in the same slot family as
the [task strip](session-todos.md). The 76pt tray and 34pt editor are unchanged;
with no jobs nothing is mounted and no space is reserved.

## Source

- `packages/protocol` `SessionSummary.runningJobs`: live worker-owned jobs
  (`id`, `name`, `state: "running"`, `startedAt`, `outputPath`), omitted when
  none and never restored from stale metadata. pilotd republishes the summary
  whenever the worker's jobs change, so the existing sessions list socket is the
  only source. No GET, polling or new subscription is added.
- `POST /api/sessions/:id/jobs/:jobId/stop` answers 202, or 404 once the job no
  longer runs. The agent is told the user stopped it.
- Swift `JobsPanel.swift`, `WorkingIndicator.swift` and `PilotCore/WorkingLine.swift`:
  job count, the longest-running job's name, compact elapsed time (`12s`, `4m`,
  `1h 5m`), per-job Stop, log path with copy.

## Behavior

- Collapsed: `N jobs running`, the longest-running job's name and its elapsed time.
  The strip replaces the composer's `Working...` line when only jobs run; when
  the agent itself works, `Working...` stays.
- The disclosure opens one row per job in server order: name, log path (when
  reported), elapsed time, Show log and Stop. Rows grow for the path and any
  Stop error; the list scrolls after about four rows.
- Show log opens a popup that tails the job's log live (session_jobs_log.rs,
  session_jobs_log_view.rs). It reads the daemon-reported local outputPath
  read-only, every 500 ms while open and off the UI thread, keeping the newest
  256 KiB from a whole line. ANSI escapes are dropped and a carriage return
  overwrites its line, so progress bars show their last state. The view follows
  new output while scrolled to the end, scrolls horizontally for long lines, and
  says when the job is no longer running, the file can't be read or older output
  was dropped. Copy log copies the cleaned text; the path has its own copy. Done
  or Escape closes it and stops reading. This is Local only: the app and daemon
  share the machine, and no backend endpoint serves job output.
- Stop sends one request after a hello identity check and is never retried.
  202 shows `Stopping…` until the summary drops the job; 404 shows `Ended`;
  anything else says the stop wasn't confirmed and leaves Stop available.
- When the list subscription is disconnected or not loaded, the last reported
  jobs stay visible, marked `Last reported`, and Stop is disabled. Disappearance
  from a current summary is the only "no longer running" signal; the transcript
  carries the job's result.
- Open/closed intent is per chat and window and survives navigation and
  reconnects. Updates never open, close or take focus. If the strip held focus
  when the last job ended, focus returns to the composer. Pointer input on the
  strip is fenced while the composer has marked (IME) text.
- Elapsed times update each second for the first minute, then each minute, only
  while the strip is visible and current.

## Verification

`python3 scripts/check-scoped.py --unit session_jobs --test session_jobs --lint`
runs parsing/format/stop-transport units against an owned fixture server and the
mounted native strip at 680/1100 in light and dark: 0/1/several jobs, long
Unicode names, missing paths, the live log popup (ANSI/CR cleanup, follow,
copy, ended job, close), Stop accepted/repeated/error, ended jobs, stale
list, keyboard and pointer disclosure, IME, focus return, draft, reader anchor,
composer geometry and chat navigation. Set `PILOT_NEXT_JOBS_DIR` to save
captures. No real daemon, job or Local profile is touched.
