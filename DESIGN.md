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

- App shell: slim top bar (wordmark, Change today's mood, sign out), content column max 1024px on the desk. The pack page is wide: header and main up to 90rem (1440px).
- Home: topic tab strip full width, then reviewer list. The topic shelf is a separate home library surface.
- Workspace: header (breadcrumb; title with a meta line: exam countdown · Generated stamp), then one sticky **strip**, then the study document. Before first generate, sources stay expanded inline above the study.
- **Strip**: mode tabs left; the active mode's tools right (Locked In and Summary: claims chip `N/M sourced`, Contents, Notes, Edit, Download; Test Me and Carded: Focus), then **More** (⋯). Solid background, no backdrop filter (it would trap fixed sheets). On phones: tabs on one row, tools on a second, labels hidden behind icons, every control 44px. In Focus mode only the Focus toggle stays.
- **More**: (1) the mode's own actions (Check again, Open slides, Pin, Earlier version), (2) Redo for the active mode with its one-line description and requests left today, (3) pack items: Sources (n) with any unreadable pages, Exam date. Sources and Exam date open dialogs.
- **Generation section** (once study modes exist): shown above the study only while modes are missing or a job is running, failed or partial. A finished job shows a short Pack ready line that clears itself.
- **Rail** (pack page): a sticky 17.5rem column right of the study content when the pack container is at least 64rem wide (a container query, so the topic shelf and Ask padding count) and Ask is closed. Sections, in order: the mode's own section, then Pack.
  - Locked In and Summary: **Contents** with mastery bars, the current section highlighted (the last heading at or above 30% of the viewport, `aria-current="location"`), reading progress %, and Top/End entries (the same jumps as the floating pair); **Notes** collapsed with a count, expanding in place to highlights and saved Ask answers. The strip's Contents and Notes buttons hide while the rail shows; the claims chip stays in the strip.
  - Test Me and Carded: **Sections**, the Locked In headings with mastery bars, weak sections marked (described as "Under 60% correct on 3 or more answers"); no links.
  - The rail's Contents keeps the current section in view by scrolling the rail itself, never the page; it pauses for 2 seconds after the reader scrolls the rail.
  - **Pack**: Sources (n) and Exam date buttons opening the same dialogs as More (More keeps them, since the rail is not always visible).
  - Print-hidden.
- **Contents and Notes fallback** (no rail: narrow window, phone, or Ask open): a popover under the strip on desktop, the bottom sheet on phones. While a phone sheet is open (`html[data-study-sheet-open]`), the floating ↑ ↓ and Ask pill hide so they never cover it.
- **Wide inline math**: an inline formula wider than the text column scrolls inside the column (measured `math-overflow` class); other inline formulas are untouched. Display math always scrolls.
- **Document title**: the "Locked In:" / "Summary:" prefix of the first heading is hidden on screen (kept in the text and in print).
- Breakpoint: single column below 768px. No horizontal overflow at 390px.
- Touch targets: primary controls ≥ 44px height on touch-sized viewports. Small icon and inline controls (topic ⋯, Carded Edit/Pin) grow to 44px on coarse pointers (`pointer-coarse:`), keeping desktop density.

## Components

- **Topic tabs**: horizontal scroll if needed; selected = amber underline or filled chip.
- **Today card**: one card at the top of the desk for all topics: "N to review · M new", weak sections and minutes (wraps, never truncated; a zero part is left out), **Start studying** to the first Do-first item, **See the plan** for the Today dialog, and **How cards come back** (the `StudyHelp` explainer). Empty: Nothing due today.
- **StudyHelp** ("How cards come back", `Question` icon; icon only below 640px): a popover on desktop, a bottom sheet on phones. It explains New (up to 20 a day per pack, or spread out until the exam), To review, Again (tomorrow) and Good (about 3 days, then 2 weeks, then 2 months, then longer; never after the exam), and Weak (under 60% correct across 3 or more answers). Shown on the Today card and in Carded.
- **Pack rows**: name up to two lines (never clipped); meta line wraps: generated stamp or Not generated yet, "N to review · M new" when above 0 (zero parts left out), exam date when set, mastery, weak section (described as "Under 60% correct on 3 or more answers"). A small **Review** button when cards are due (else **Resume** for an active sitting), then the overflow menu (rename/delete).
- **Topic shelf**: Due today shows the all-topics total (cards to review plus today's new cards), equal to the Today card; each topic shows its own count when above 0. Below 768px it is a drawer that starts closed on every load.
- **Dates**: one stamp, `Oct 6, 1:36 PM`, in the viewer's zone. Server renders show the label without a time (no UTC text). Days read `Oct 9`.
- **Change today's mood**: not a primary CTA. Hover/focus opens the look menu on fine pointers; click toggles on coarse pointers.
- **Citation chips**: small mono `p.14` buttons inline after a claim. They open the source modal and are never part of the annotation text.
- **Not from your uploaded sources**: amber tag with WarningCircle after an unsupported claim. Hover or focus underlines the claim in the warning color. The popover explains and offers Keep or Delete sentence.
- **Source modal**: built on the shared Dialog. PDF pages render to a canvas, fit to width, with Slide N of M and previous/next. It closes with Escape or the backdrop and returns focus.
- **Print**: `.print-hide` hides chrome, `.print-document` forces a white page and dark ink, and each `h2` after the first starts a new page.
- **Annotations**: select text in either editable reading document to highlight or add a note. Color choices are allowlisted and Earlier version keeps displaced quotes.
- **Source rows**: filename, kind icon, status badge when Failed or Not yet processed, delete. Ready sources show no status badge.
- **Badges**: Failed / Not yet processed are labeled. Ready badge is no longer shown.
- **Generate**: primary for the first pack. Generate missing fills only absent modes. Hidden once all four modes exist.
- **Redo**: an item in More for the active study mode, with a one-line description of upstream. Confirm if that mode already has content. Redo Locked In names all four modes. Redo Summary, Test Me, or Carded names only that mode.
- **Study mode tabs**: Locked In · Summary · Test Me · Carded, with no theme-specific duplicate chooser. 14px labels; the selected tab is a bottom underline only.
- **Carded**: header "Remaining: N to review · M new" with Export, Browse all / Study due and How cards come back; no Restart. The session recap offers **Practice missed (n)** (cards rated Again) and **Practice all (n)**; practice runs the same cards with flip and Again/Good, labelled "Practice, not scheduled", and never saves a rating. It ends on "Practice done" with the same buttons plus **Back to due**.
- **Test Me recap**: a large score ("7/15" with "47%"), the studied-for line, **By section** (sections with items this sitting, "3 of 5" and a bar; uncited items under Other), and each miss with **Your answer** (`XCircle`, muted; "No answer" when empty) beside **Correct** (`CheckCircle`). Retry missed and Start again stay.
- **Unsourced tag**: "Not from your uploaded sources" with Keep, Delete and Ask why; under the title one muted reason line: "Not found in your sources: <terms>" for a term-guard tag, else "The checker could not match this sentence to its cited page."
- **Scroll jump**: on pack pages taller than three screens, ↑ (Back to top) and ↓ (Jump to end) stack above the Ask pill. ↑ shows past half a screen; ↓ hides once the end of the study content (`data-study-end`) is on screen. Hidden while Ask is open, kept in Focus mode, print-hidden, instant under reduced motion.
- **Empty states**: short title, one teaching sentence, one action when available.
- **Buttons**: ghost for strip and menu controls; outline for dialog Cancel; primary only for the main action (Save changes, Generate, Start studying, Save date).
- **Skeletons**: muted blocks, not centered spinners, for list loads.

## Motion

150–250ms for chrome (tabs, buttons, pending). Carded flip is end over end (`rotateX`), about 700ms, after which Again/Good appear. No page-load choreography. Reduced motion shortens animation and transition to a negligible duration.

## Icons

`@phosphor-icons/react` only (regular weight for chrome, bold sparingly for emphasis). No Lucide in product chrome after restyle.

## Copy rules

- Product language: topic, pack, source, generate, redo, study mode, Locked In, Summary, Test Me, Carded. Visible copy says pack; code, routes, tables and API errors keep reviewer.
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
