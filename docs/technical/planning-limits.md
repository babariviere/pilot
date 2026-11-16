# Planning limits

Mission planning has limits on counts and sizes. Many were copied defaults ("40 items", "48 KiB"), not
decisions. This page lists each one, what it protects and why it has its value, following the rule in
[CODING_STANDARDS.md](../../CODING_STANDARDS.md#limits). Checked on 2026-11-15 after the Pilot Day mission
stopped at the old 40-question map limit.

## The map (`mission-plans.ts`, `mission-plan-store.ts`)

| Limit | Value | Protects | Why this value | Status |
| --- | --- | --- | --- | --- |
| Saved map size (`PLAN_STATE_LIMIT`) | 192 KiB | Disk: each save stores a full copy | Room for about 150 settled questions at the measured 1.2 KB each | Raised from 48 KiB |
| Questions on the map | none | (nothing: settled questions stay for good) | The map size limit bounds it | Removed (was 40) |
| Sources, fog, dependencies, spec lists | none | (nothing beyond the map size) | The map size limit bounds every list | Removed (were 40 each) |
| Slice owners | 2 | Meaning: one UI and one backend owner | Product rule, not size | Kept |
| Text fields (title 200, question/fog/stories 2000, problem/solution 4000) | as listed | Readable map cards | Short card text | Kept |
| Spec document | 28 KiB | Model tokens: the spec is read by every task | Not measured | Check when a spec reaches it |
| Prototype time and cost | 480 min, 10 USD | Spend | Product rule | Kept |
| One save (operation payload) | 64 KiB | Daemon memory and journal size | Journal-wide limit | Kept; saves list only open questions now |

## Interviews (`mission-interview-contract.ts`)

| Limit | Value | Protects | Why this value | Status |
| --- | --- | --- | --- | --- |
| Questions per round | 40, 40 KiB | The person answering: one sitting | Round size, not storage | Kept; message names the numbers |
| Options per question | 8 | Readable choices | Product rule | Kept |
| Context per question | 1500 bytes | Readable background | Fits the More context panel | Kept |
| Custom answer text | 4000 bytes | Readable answers | Product rule | Kept |
| All answers in one save (`ANSWERS_LIMIT`) | 48 KiB | One save must fit 64 KiB | Each answer repeats its picked option (up to 2000 bytes), so 12 KiB blocked saves of large rounds | Raised from 12 KiB |
| Agreement (`AGREEMENT_LIMIT`) | 28 KiB | Model tokens: it becomes the mission brief every worker reads | Not measured | Kept; message names the numbers. Can refuse a submit after a large round: check if it happens |

## Planner reads and chats (`planning-workers.ts`)

| Limit | Value | Protects | Why this value | Status |
| --- | --- | --- | --- | --- |
| Linked Knowledge in a read (`LINKED_KNOWLEDGE`) | 100 | Model tokens per read | About 300 bytes each (measured), about 30 KB in total; the page says when there are more | Raised from 40 |
| Research chats at once | 2 | Worker slots and cost | Small; the mission worker cap also applies | Kept |
| Research chats per question | 2 | Cost of weak findings | One retry | Kept |
| Prototype chats at once | 1 | The user's attention: one prototype is reviewed at a time | One round asks about one prototype; the worker cap also applies | Added |
| Prototype chats per question | 2 | Cost, and a loop with no progress | The same as research: one try, one after feedback | Added |
| Prototype chat time | The question's `maxMinutes` (1 to 480) | Cost | Set by the planner for that experiment | Added: Pilot stops the chat and passes what it published |
| Prototype cost | The question's `maxCostUsd` (0 to 10) | Spend | Set by the planner | Shown to the user, not enforced |
| Research report read | 48,000 characters | Knowledge entry size (64 KiB revision) | Fits one entry | Kept |
| Question asks kept | 60 | Planning worker record size | Not measured | Kept |
| Question answer read | 6,000 characters | Card size | Not measured | Kept |
| Repair reply read | 16,000 characters | Memory; the JSON block comes last | Not measured | Kept |
| Recent operations for Diagnostics | 20 per mission, 50 missions, memory only | Memory | pilotd.log has the rest | Kept |
