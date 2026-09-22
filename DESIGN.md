# Omni-Reviewer - design system

## Mode

**Operate.** Personal study tool. Scanability, consistency, and the late-night desk scene beat expression. No hero, bento, marquee, or three equal feature cards.

## Scene

Default look is **Night**: graphite chrome with teal study accents. Day is a clean white/cobalt workspace. Both use one shared study layout with progressive disclosure. Not Inter as default display.

Looks are chrome, not new objects. Switch them from **Change today's mood** (header). Menu order: Day, Night. Persist in `localStorage` key `omni-look`. Default remains Night. Stored Thea/RemNote values map to Day.

| Look | Scene |
| --- | --- |
| Night | Graphite shell, teal accent, dark reading surface. `html.dark`. |
| Day | White workspace, cobalt primary, calm reading surface. |

## Typography

| Role | Family | Notes |
| --- | --- | --- |
| UI (Night) | IBM Plex Sans | Labels, tabs, buttons, lists. Fixed rem scale. |
| UI (Day) | IBM Plex Sans | Same roles as Night UI. |
| Reading | Source Serif 4 | Locked In and Summary body. Measure ~65–75ch. |
| Mono | IBM Plex Mono | Code spans only. |

Scale (approx): 12 / 14 / 16 / 18 / 20 / 24 / 30. Ratio ~1.125–1.2. Tracking no tighter than -0.03em on large titles.

## Color

Dark product shell by default (`html.dark` and `data-look="night"`). Light looks set `color-scheme: light` and drop the lamp wash.

| Token | Intent |
| --- | --- |
| `--background` | Graphite night or white day workspace |
| `--chrome` / header | Slightly cooler / darker frame |
| `--card` / `--surface` | Raised panels |
| `--foreground` | Cool readable foreground |
| `--muted-foreground` | Secondary labels |
| `--primary` | Teal night or cobalt day action |
| `--reading` | Calm reading surface |
| `--reading-foreground` | Readable document text |
| `--success` | Available for success states; unused for Ready (badge no longer shown) |
| `--warning` | Not yet processed |
| `--destructive` | Failed / delete |

Accent is for selection and primary CTAs only, not decoration.

## Layout

- App shell: slim top bar (wordmark, Change today's mood, sign out), content column max ~1100px.
- Home: topic tab strip full width, then reviewer list. The topic shelf is a separate home library surface.
- Workspace: stacked on mobile. When study modes exist, sources sit behind a Sources control and study is first. Before first generate, sources stay expanded. Exam date editing is behind a labelled disclosure.
- Breakpoint: single column below 768px. No horizontal overflow at 390px.
- Touch targets: primary controls ≥ 44px height on touch-sized viewports.

## Components

- **Topic tabs**: horizontal scroll if needed; selected = amber underline or filled chip.
- **Reviewer rows**: name + chevron; overflow menu rename/delete. Second line: generated stamp or Not generated yet, due-today count when above 0, exam date when set.
- **Change today's mood**: not a primary CTA. Hover/focus opens the look menu on fine pointers; click toggles on coarse pointers.
- **Annotations**: select text in either editable reading document to highlight or add a note. Color choices are allowlisted and Earlier version keeps displaced quotes.
- **Source rows**: filename, kind icon, status badge when Failed or Not yet processed, delete. Ready sources show no status badge.
- **Badges**: Failed / Not yet processed are labeled. Ready badge is no longer shown.
- **Generate**: primary amber for the first pack. After all four modes exist, the control remains and reads All generated. It does not start a model call. Generate missing fills only absent modes.
- **Redo**: outline control on the active study mode, with a one-line description of upstream. Confirm if that mode already has content. Redo Locked In names all four modes. Redo Summary, Test Me, or Carded names only that mode.
- **Study mode tabs**: Locked In · Summary · Test Me · Carded, with no theme-specific duplicate chooser.
- **Empty states**: short title, one teaching sentence, one action when available.
- **Skeletons**: muted blocks, not centered spinners, for list loads.

## Motion

150–250ms for chrome (tabs, buttons, pending). Carded flip is end over end (`rotateX`), about 700ms, after which Again/Good appear. No page-load choreography. Reduced motion shortens animation and transition to a negligible duration.

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
- Three equal marketing feature cards
- Hero / bento / marquee
- Em dash in UI strings
- Second icon family
- Regenerating on tab focus or page open
