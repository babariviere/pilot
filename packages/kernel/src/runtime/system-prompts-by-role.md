# System prompts by role

See [tool access by role](tool-access-by-role.md) for enforced permissions and
[skill and prompt sources](skill-prompt-review.md) for loader paths and tests.

| Role                | Composition                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Build               | SDK prompt, configured project context and skills, then the Pilot overlay                       |
| Ask                 | Fixed read-only base, restricted resources, then the Pilot overlay                              |
| Screen agent        | Ask plus screen-specific Pilot guidance                                                         |
| Mission member      | Build or Ask plus the member overlay                                                            |
| Mission coordinator | SDK prompt plus coordinator Pilot and mission overlays                                          |
| Subagent            | Child SDK prompt plus host-provided identity                                                    |
| Restricted reviewer | Fixed `REVIEW_BASELINE`; not general Build access                                               |
| Insights report     | Fixed evidence-review base and restricted overlay, without general mission or project resources |

Start with `preparePrompt` in [native-adapter.ts](../native-adapter.ts) and
`pilotPrompt` and `missionPrompt` in [policy.ts](policy.ts). The worker can send
structured sections instead of one concatenated prompt. Tool schemas and
descriptions accompany the request separately.

Mission state, Knowledge, workspace details and configured instructions can
change the rendered request. Inspect the loader and synthetic tests instead
of treating a saved prompt or real transcript as the contract. Prompt wording
does not grant permissions.
