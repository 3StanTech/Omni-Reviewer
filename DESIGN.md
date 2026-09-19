# Omni-Reviewer - design system

## Mode

**Operate.** Personal study tool. Scanability, consistency, and the late-night desk scene beat expression. No hero, bento, marquee, or three equal feature cards.

## Scene

Default look is **Night**: one person at a late-night desk under a lamp. Dark chrome frames the workspace. Long-form reading (Locked In, Summary) sits on a warmer paper surface. One ink-or-amber accent marks selection and primary action. Not Inter as default display.

Looks are chrome, not new objects. Switch them from **Change today's mood** (header). Menu order: Day, Night, Thea-Style, RemNote-Style. Persist in `localStorage` key `omni-look`. Default remains Night.

| Look | Scene |
| --- | --- |
| Night | Warm charcoal desk, lamp amber, cream reading paper. `html.dark`. |
| Day | Cream paper throughout, blue-ink primary, Source Serif 4 for UI. |
| Thea-Style | Pale lavender, cyan-blue primary, DM Sans. Workspace uses four mode destination cards when views exist (study chooser, not marketing). |
| RemNote-Style | White/indigo, Source Sans 3, left topic shelf at md+. |

Thea-Style may use blue/lilac. It must not use a blue-to-pink marketing gradient.

## Typography

| Role | Family | Notes |
| --- | --- | --- |
| UI (Night) | IBM Plex Sans | Labels, tabs, buttons, lists. Fixed rem scale. |
| UI (Day) | Source Serif 4 | Same roles as Night UI. |
| UI (Thea-Style) | DM Sans | Look-scoped. |
| UI (RemNote-Style) | Source Sans 3 | Look-scoped. |
| Reading | Source Serif 4 | Locked In and Summary body. Measure ~65–75ch. Thea/RemNote reading may use that look's UI sans. |
| Mono | IBM Plex Mono | Code spans only. |

Scale (approx): 12 / 14 / 16 / 18 / 20 / 24 / 30. Ratio ~1.125–1.2. Tracking no tighter than -0.03em on large titles.

## Color

Dark product shell by default (`html.dark` and `data-look="night"`). Light looks set `color-scheme: light` and drop the lamp wash.

| Token | Intent |
| --- | --- |
| `--background` | Deep warm charcoal desk |
| `--chrome` / header | Slightly cooler / darker frame |
| `--card` / `--surface` | Raised panels |
| `--foreground` | Soft warm off-white |
| `--muted-foreground` | Secondary labels |
| `--primary` | Lamp amber: primary actions, selected tab |
| `--reading` | Warm paper for long-form |
| `--reading-foreground` | Ink on paper |
| `--success` | Available for success states; unused for Ready (badge no longer shown) |
| `--warning` | Not yet processed |
| `--destructive` | Failed / delete |

Accent is for selection and primary CTAs only, not decoration.

## Layout

- App shell: slim top bar (wordmark, Change today's mood, sign out), content column max ~1100px.
- Home: topic tab strip full width, then reviewer list. RemNote-Style replaces the chip strip with a left topic shelf at md+ (chips remain below md).
- Workspace: stacked on mobile. When study modes exist, sources sit behind a Sources control and study is first. Before first generate, sources stay expanded. Exam countdown sits beside the pack title when an exam date is set.
- Breakpoint: single column below 768px. No horizontal overflow at 390px.
- Touch targets: primary controls ≥ 44px height on touch-sized viewports.

## Components

- **Topic tabs**: horizontal scroll if needed; selected = amber underline or filled chip.
- **Reviewer rows**: name + chevron; overflow menu rename/delete. Second line: generated stamp or Not generated yet, due-today count when above 0, exam date when set.
- **Change today's mood**: not a primary CTA. Hover/focus opens the look menu on fine pointers; click toggles on coarse pointers.
- **Ink legend**: under Locked In and Summary paper. Classes `ink-idea`, `ink-example`, `ink-fact`, `ink-warning`, `ink-exam` only.
- **Source rows**: filename, kind icon, status badge when Failed or Not yet processed, delete. Ready sources show no status badge.
- **Badges**: Failed / Not yet processed are labeled. Ready badge is no longer shown.
- **Generate**: primary amber; first pack only. After study modes exist, hide it.
- **Redo**: outline control on the active study mode, with a one-line description of upstream. Confirm if that mode already has content. Redo Locked In rebuilds all four.
- **Study mode tabs**: Locked In · Summary · Test Me · Carded. Thea-Style adds four destination cards as the primary chooser; compact tabs remain for keyboard.
- **Empty states**: short title, one teaching sentence, one action when available.
- **Skeletons**: muted blocks, not centered spinners, for list loads.

## Motion

150–250ms for chrome (tabs, buttons, pending). Carded flip is end over end (`rotateX`), about 700ms, after which Again/Good appear. No page-load choreography.

## Icons

`@phosphor-icons/react` only (regular weight for chrome, bold sparingly for emphasis). No Lucide in product chrome after restyle.

## Copy rules

- Product language: topic, reviewer, source, generate, redo, study mode, Locked In, Summary, Test Me, Carded.
- Controls name the action.
- Errors name the problem and recovery.
- Never use an em dash in visible UI copy. Use a period, colon, or comma.

## Anti-patterns (banned here)

- Inter as display default
- AI purple gradients
- Three equal marketing feature cards (Thea-Style mode kit is a study-mode chooser, look-scoped, not marketing)
- Hero / bento / marquee
- Em dash in UI strings
- Second icon family
- Regenerating on tab focus or page open
