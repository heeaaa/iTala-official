# Combined UI fixes — verification

Verified on 1 October 2026 in `codex/schedule-iphone-fixes`, based on
`rel/build-three` at `42f6fc7` (the merge of default games).

## Automated evidence

`node tests/run.js` passes, including TypeScript: 357 reducer checks, 475 sync
checks, 120 provider checks, 889 static checks, and the other feature suites.
ESLint passes for all changed TypeScript and JavaScript files. `git diff --check`
passes. Database checks are skipped because this host has no `psql` installation.

| Change | Regression coverage |
| --- | --- |
| League tab alignment | `gamePresentation.test.js` exercises every selected cell in both two-tab and five-tab bars. Labels share equal flexible cells; the selected fill occupies the cell's measured bounds; wrapping cannot stretch the fill below the bar. |
| Phone/tablet sizing | Tabs use a readable base size with fitting for compact cells. Apple and Google controls have equal 52-point frames and full container width. Tablet sign-in content is centered and bounded; finish dialogs support both orientations and scroll. |
| Schedule cache | `scheduleCache.test.js` runs the real cache and Schedule tab through initial fetch, tab remount, disk restore, event switching, five-minute expiry, manual refresh, foreground refresh, forced redirect refresh, offline failure, malformed cache, and league isolation. |
| Default/Forfeit | `defaultGameUi.test.js` runs the actual Tip Off and live screen functions. The action has the new label, is absent from the tracker, appears only for 0–0 league games after Finish Game, and opens the result form in the same modal. |
| Existing finish behavior | The same suite checks scored ties, overtime, the final period, normal non-tied games, spectators, cancel/back, result validation, and refusal when a score arrives while the form is open. Existing reducer/sync/Connect tests cover saving default results. |

All user-facing app text uses “schedule” or “scheduled game” instead of
“fixture.” The sharing prompts say “Google/Apple account.”

## Native visual verification

Not executed on this Windows host: native iOS pixels, Apple's sign-in sheet,
iPad rotation, Split View, and keyboard presentation. The component harness
checks behavior and layout constraints; it does not render native pixels.

Run the UI1–UI5, R54, and T1a cases in `MANUAL-REGRESSION.md` in a device build
on a compact phone, iPhone 17, and iPad in portrait/landscape, including larger
text and Split View. Those cases remain manual verification, not recorded passes.
