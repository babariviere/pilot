# Feedback prototype mockup

MOCKUP with mock data. It shows a feedback item whose triage proposed a prototype. Not app code.

Run from the repository root: `apps/day/nsh.sh run fixtures/feedback-prototype/FeedbackPrototypeMockup.tsx`.

- 1. Proposal: "Proposed: try a prototype first" lists what to explore and the directions.
     "Start prototype" is the step; "Start fix" stays for users who want to skip it.
- 2. Choose a mockup: the prototype chat's question shows on the item with its attached mockups
     (the same attached-artifact rows mission questions use) and the usual answer form.
- 3. Fix from choice: the chosen fix is the new proposal, with the chosen mockup linked, and "Start fix".
- No new colour, badge or layout: it reuses the proposal panel, the question form and artifact rows.
