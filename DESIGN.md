# Omni-Reviewer - design system

## Mode

**Operate.** Personal study tool. Scanability, consistency, and the late-night desk scene beat expression. No hero, bento, marquee, or three equal feature cards.

## Scene

Default look is **Dream Land**: a Kirby-inspired cream and pastel desk made for Yana, with the Kirby companion. Day is a clean cobalt workspace on a tinted page; Night is graphite chrome with teal study accents. All three use one shared study layout with progressive disclosure. Not Inter as default display.

Looks are chrome, not new objects. Switch them from **Change today's mood** (header). Menu order: Dream Land, Day, Night. Persist in `localStorage` key `omni-look`; a browser with no saved look opens in Dream Land. Stored Thea/RemNote values map to Day; any other unknown value maps to Dream Land. The early script in `app/layout.tsx` sets `data-look` before first paint, so a saved look never flashes another one.

| Look | Scene |
| --- | --- |
| Dream Land | Cream page, pink sidebar and top bar, sky tabs bar and rail, berry-pink primary, 20px rounded panels, pill buttons, dashed star dividers between reading sections, Kirby companion. `color-scheme: light`. |
| Day | Tinted cool page (`#f3f6fb`) behind white cards, cobalt primary, calm white reading surface. |
| Night | Graphite page, raised slate cards, teal accent, dark reading surface, lamp wash. `html.dark`. |

## Typography

| Role | Family | Notes |
| --- | --- | --- |
| UI (Night) | IBM Plex Sans | Labels, tabs, buttons, lists. Fixed rem scale. |
| UI (Day) | IBM Plex Sans | Same roles as Night UI. |
| Reading | Source Serif 4 | Locked In and Summary body. Measure ~65–75ch. |
| Mono | IBM Plex Mono | Code spans only. |

Scale (approx): 12 / 14 / 16 / 18 / 20 / 24 / 30. Ratio ~1.125–1.2. Tracking no tighter than -0.03em on large titles.

## Color

Night is the only dark look (`html.dark` and `data-look="night"`) and the only one with the lamp wash. Day and Dream Land set `color-scheme: light`. Token blocks in `app/globals.css` run `:root, [data-look="dreamland"]`, then Day, then Night: `:root` and `[data-look]` share specificity, so `:root` must come first or it would override later looks.

Structure tokens: `--page` (page tint, mapped to `--background`), `--card-head` (panel header band), `--divider` (hairlines inside panels), `--rail` and `--strip` (side panel and tabs bar surfaces), `--panel-shadow`. Dream Land adds `--star` for star accents.

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

- **Panels**: every group on the desk and the pack-page chrome is a `Panel` (`components/ui/panel.tsx`) with an optional `PanelHeader` band (small uppercase label left, actions right). Rows inside a panel are split by `--divider` hairlines. Looks restyle panels through tokens only; no per-look markup.
- App shell: slim top bar (wordmark, Change today's mood, sign out), content column max 1024px on the desk. The pack page is wide: header and main up to 90rem (1440px).
- Home: topic tab strip full width, then reviewer list. The topic shelf is a separate home library surface.
- Workspace: header (breadcrumb; title with a meta line: exam countdown · Generated stamp), then one sticky **strip**, then the study document. Before first generate, sources stay expanded inline above the study.
- **Strip**: a framed panel (`bg-strip`, rounded border, tabs split by dividers, selected tab on the card surface with the underline); mode tabs left; the active mode's tools right (Locked In and Summary: claims chip `N/M sourced`, Contents, Notes, Edit, Download; Test Me and Carded: Focus), then **More** (⋯). Solid background, no backdrop filter (it would trap fixed sheets). On phones: tabs on one row, tools on a second, labels hidden behind icons, every control 44px. In Focus mode only the Focus toggle stays.
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
- **Today card**: one panel at the top of the desk for all topics, with a "Today / All topics" header band and stat columns (to review, new, weak sections, minutes) split by dividers: "N to review · M new", weak sections and minutes (wraps, never truncated; a zero part is left out), **Start studying** to the first Do-first item, **See the plan** for the Today dialog, and **How cards come back** (the `StudyHelp` explainer). Empty: Nothing due today.
- **StudyHelp** ("How cards come back", `Question` icon; icon only below 640px): a popover on desktop, a bottom sheet on phones. It explains New (up to 20 a day per pack, or spread out until the exam), To review, Again (tomorrow) and Good (about 3 days, then 2 weeks, then 2 months, then longer; never after the exam), and Weak (under 60% correct across 3 or more answers). Shown on the Today card and in Carded.
- **Pack rows**: name up to two lines (never clipped); meta line wraps: generated stamp or Not generated yet, "N to review · M new" when above 0 (zero parts left out), exam date when set, mastery, weak section (described as "Under 60% correct on 3 or more answers"). A small **Review** button when cards are due (else **Resume** for an active sitting), then the overflow menu (rename/delete).
- **Topic shelf**: Due today shows the all-topics total (cards to review plus today's new cards), equal to the Today card; each topic shows its own count when above 0. Below 768px it is a drawer that starts closed on every load.
- **Dates**: one stamp, `Oct 6, 1:36 PM`, in the viewer's zone. Server renders show the label without a time (no UTC text). Days read `Oct 9`.
- **Change today's mood**: not a primary CTA. Hover/focus opens the look menu on fine pointers; click toggles on coarse pointers.
- **Desk greeting**: "Good morning/afternoon/evening, Name" with the subtitle. In Dream Land it becomes a speech bubble whose tail points at Kirby on the right, and the name gets "!" (Day and Night keep the plain greeting, no "!"). Gated by CSS (`dreamland:` variant), never by React state, so it never flashes.
- **Kirby companion** (`components/kirby-companion.tsx`, Dream Land only): hand-coded SVG fan art for this private app; never add Nintendo assets or ship it publicly. Gradients render once in `KirbyDefs` (root layout), never inside a hidden subtree. Places: the desk greeting (124px, 84px on phones), untimed Test Me beside the question and on its recap (the last answer reacts there), the timed Test Me recap only (never during the timer), and Carded beside the card (112px; 64px in the panel corner at 640px and below, without narrowing the question or card). States: idle bob and blink; eyes and lean follow the pointer; hover waves; click squashes with "poyo!"; sleeps after 20 s without pointer movement; a saved correct answer or Good plays the victory hop with a star burst; a wrong answer or Again plays a droop with a sweat drop. Reactions fire only after an answer or rating is accepted (never on a 409 or an error); a replayed Carded save reacts with the rating the server saved, not the button tapped. Reduced motion stops every animation while expressions still change. Print-hidden. Kirby never covers study text, choices, the card or its buttons.
- **Citation chips**: small mono `p.14` buttons inline after a claim. They open the source modal and are never part of the annotation text.
- **Not from your uploaded sources**: amber tag with WarningCircle after an unsupported claim. Hover or focus underlines the claim in the warning color. The popover explains and offers Keep or Delete sentence.
- **Source modal**: built on the shared Dialog. PDF pages render to a canvas, fit to width, with Slide N of M and previous/next. It closes with Escape or the backdrop and returns focus.
- **Print**: `.print-hide` hides chrome, `.print-document` forces a white page and dark ink, and each `h2` after the first starts a new page.
- **Annotations**: select text in either editable reading document to highlight or add a note. Color choices are allowlisted and Earlier version keeps displaced quotes.
- **Source rows**: filename, kind icon, status badge when Failed or Not yet processed, delete. Ready sources show no status badge.
- **Badges**: Failed / Not yet processed are labeled. Ready badge is no longer shown.
- **Generate**: primary for the first pack. Generate missing fills only absent modes. Hidden once all four modes exist.
- **Redo**: an item in More for the active study mode, with a one-line description of upstream. Confirm if that mode already has content. Redo Locked In names all four modes. Redo Summary, Test Me, or Carded names only that mode.
- **Study mode tabs**: Locked In · Summary · Test Me · Carded, with no theme-specific duplicate chooser. 14px labels; the selected tab takes the card-coloured fill plus the primary underline.
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
- Official Nintendo assets, logos or fonts (Kirby is hand-drawn SVG only)
