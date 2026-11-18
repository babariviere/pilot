# Linked projects mockup

MOCKUP with mock data. It shows the Settings > Projects control that lets a project's agents read other
Pilot projects' read-only main view. Not app code.

Run from the repository root: `apps/day/nsh.sh run fixtures/linked-projects/LinkedProjectsMockup.tsx`.

- Each project row gets one quiet line, "Also reads: …", that opens in place.
- Inside, one checkbox per other Pilot project. Ticking links it; unticking unlinks it.
- No new button, badge or colour: linking is a setting, not a state that needs the user.
