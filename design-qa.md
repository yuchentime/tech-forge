# Design QA

## Comparison Target

- Source visual: `/var/folders/h7/x9487w8d0bn5fk6b81zhslvw0000gn/T/codex-clipboard-f6cf9393-3832-4512-8943-16ed14103a26.png` (2556 × 1652 px).
- Updated interaction direction: segmented `普通对话 / 演练模式` control to the right of `文件`; hide `文件` while rehearsal mode is active. The rehearsal page displays `这是测试页面`.
- Implementation screenshot: CUA capture of the active TeachForge Electron window, shown in the task thread; the CUA capture is not persisted to a local file. Displayed capture is approximately 2560 × 1640 px.
- CSS viewport and device scale factor were not exposed by the CUA capture. No pixel normalization was applied. The comparison uses the source and implementation images in the same CUA result; their page content differs intentionally because rehearsal mode is selected in the implementation.

## Visual Review

- Full view: the app shell and conversation layout remain consistent with the source. In conversation mode, the mode selector sits immediately to the right of the file control. In rehearsal mode, the file control is hidden, the message history and composer fade out, and the test page fades in.
- Focused region: the header keeps the long conversation title on one line and truncates it at 24 Unicode code points, including the ellipsis. The rehearsal view centers the exact text `这是测试页面`.
- Fonts and typography: existing application typography is retained; the title remains single-line.
- Spacing and layout rhythm: the segmented control and file button fit on the right side of the header without wrapping or overlap at the inspected window size; hiding the file control leaves the rehearsal selector aligned at the right.
- Colors and visual tokens: the control reuses the existing stone palette and emerald active state.
- Image quality and asset fidelity: no new image assets were required; the caret uses the existing Phosphor icon library.
- Copy and content: labels are `普通对话` and `演练模式`; the rehearsal placeholder reads `这是测试页面`.

## Findings

- No actionable P0, P1, or P2 visual issues found.
- The blank rehearsal page intentionally replaces the conversation body while leaving the conversation title and mode control visible.

## Verification

- `npm run build:renderer --workspace @teachforge/desktop` passed.
- `git diff --check` passed.
- Manually switched between conversation and rehearsal modes in the running Electron window and confirmed the test-page text and file-control visibility in both states.
- Unit tests were not run.

## Implementation Checklist

- [x] Place the segmented mode control to the right of the file button and hide the file button during rehearsal.
- [x] Keep the conversation title to one line and truncate after 24 characters.
- [x] Transition between the conversation view and the rehearsal test page.
- [x] Show `这是测试页面` in the rehearsal view.

final result: passed
