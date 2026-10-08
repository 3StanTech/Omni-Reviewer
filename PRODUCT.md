# Omni-Reviewer

## What this is

Omni-Reviewer is a signed-in, invite-only personal study tool. Each invited person uploads their own course material, then studies it through four generated study modes that stay on the pack until they choose to regenerate.

It is multi-user but not public signup: an operator creates accounts with a script. Friends cannot see each other's topics or packs. Auth is email plus password via Auth.js Credentials.

## Who it is for

Tristan and invited friends studying late at night from notes, PDFs, slides, and lecture media. Primary jobs:

1. Group study packs under topics.
2. Attach sources to a pack.
3. Generate a durable study set once.
4. Read, quiz, and drill cards without regenerating on every open.

## Core objects

| Object | Role |
| --- | --- |
| **User** | Invite-only account (email + password). Owns topics and generation jobs. |
| **Topic** | Top-level wayfinding tab. Holds many reviewers. Scoped to one user. |
| **Reviewer** | A study pack: sources + four independent study modes. |
| **Source** | An uploaded file (PDF, DOCX, PPTX, photos, text, video, audio) or pasted notes with an ingest status. |
| **Study mode** | One of four persisted study surfaces for a reviewer (Locked In, Summary, Test Me, Carded). |

## Information architecture

- `/login` - email + password. No public signup, no roles.
- `/` - topic tabs, create/rename/delete topic, list of reviewers in the selected topic, create/rename/delete reviewer.
- `/topics/[topicId]/reviewers/[reviewerId]` - pack workspace: sources behind a drawer once generated, generate/regenerate, four study modes.

The header has a **Search packs** button (see Search packs below). Pack pages also carry a fixed **Ask** pill in all four modes (see Ask this pack below). The desk never shows the pill.

Topic tabs are primary navigation. The reviewer workspace collapses the library while studying and exposes sources through one labelled control. A reviewer is a workspace, not a metrics dashboard.

## Ingest rules (v1)

| Kind | Behavior | UI badge |
| --- | --- | --- |
| Text PDF, DOCX, PPTX, text, pasted notes | Fully ingested; used for generation | No badge when Ready; **Failed** with message when ingest fails |
| Scanned or image-heavy PDF, photos of slides | Read page by page from the slide image, then used for generation | Reading progress while pages are read; **Failed** with a Try again button if reading stops |
| Video, audio | Stored as blob only; not transcribed | **Not yet processed** |

DOCX and PPTX are parsed as bounded ZIP/XML text without a native canvas inside a
killable server worker. Text PDFs use the same killable worker boundary. Pasted
notes are plain text in the database and have no Blob object to delete. File sources retain private Blob lifecycle
handling, with a single 55-second route deadline beginning before Blob
verification.
Failed sources keep an error message. Video/audio-only packs cannot generate in v1.

### Slide images (scanned PDFs and photos)

- **Automatic reading.** A scanned or image-heavy PDF is read automatically, page by page, as soon as it is uploaded. A page counts as image-only when it has under about 200 characters of text, so it is read from its slide image. The text a page already has is kept, and the reading is added after it, so figures, equations, and handwriting are not lost.
- **Photos of slides.** Photos picked together become one source with a page per photo, in the order they were taken (then by name). The browser packs them into a single PDF, so citations, the source viewer, and deletion work as for any PDF. Up to 100 photos per source.
- **HEIC.** iPhone HEIC and HEIF photos are supported and converted to JPEG in the browser, so the server never receives the HEIC file.
- **Where the work happens.** The browser turns each page or photo into a small JPEG (long edge 1600 px, at most 800 KB). The server only receives these small images and calls the vision model, so the model key never reaches the browser.
- **Cost.** About one free model request per 8 image pages, counted toward the shared daily free-request cap. A 40-slide scanned deck is about 5 requests.
- **Interrupted reading resumes.** Pages already read are never read again. If the tab closes mid-read, reading picks up on the next visit. If the free limit is reached, reading stops and continues the next time the pack is opened.
- **Generate waits.** While slides are being read in this tab, Generate and Redo are disabled with a note. A pack generated while some pages are unread simply lacks those pages until Redo.
- **Failure.** A page with nothing readable is marked as such and is not retried, so reading always finishes.

## Four study modes

Generated only on explicit Generate or Redo. Tab changes never call the model. Study modes reload from persistence.

1. **Locked In** - comprehensive, cohesive, chronological long-form study document (sanitized Markdown with tables, KaTeX, and legacy semantic ink spans rendered neutrally; GFM footnotes are unsupported). Source of truth. It supports explicit Edit, Save changes, and Cancel.
2. **Summary** - detailed summary of Locked In for last-minute review. It uses the same explicit Markdown editor and save/revision contract as Locked In.
3. **Test Me** - sit the exam. Recognition from Locked In. Default untimed path is one question at a time with numbered multiple-choice tiles. The key scores you. Attempts and misses persist. An optional server-timed run remains. This mode has a last question. It does not schedule tomorrow's work. The recap shows the score with a percent, a breakdown by Locked In section, and each miss with the reader's answer beside the correct one.
4. **Carded** - remember over time. Recall from Summary. End-over-end flip, then self-grade Again / Good. A due queue with remaining-due chrome ("Remaining: N to review · M new"). Each button shows its next interval. The session recap offers Practice missed and Practice all, which re-run cards without saving ratings or changing due dates; there is no Restart. A front using `{{answer}}` placeholders is a cloze card. Carded never shows multiple-choice options.

Looks (Night and Day) are chrome only. Legacy Thea-Style and RemNote-Style values in local storage normalize to Day; they do not add objects or layouts.

Highlights and notes are separate owner-scoped annotations on Locked In and Summary. They store normalized quoted text, context, color, note, and content revision. Editing or regeneration preserves a unique surviving quote and moves deleted or ambiguous quotes to Earlier version instead of guessing. Notes are inert text and do not become Markdown HTML. GFM footnote markers are not an annotation surface and are omitted from the study text model.

During reading, select text to Highlight or Add note. Contents, Notes, Earlier version, and the current reading position are progressive disclosures. Reading positions are local-only and keyed by owner, reviewer, mode, and content revision.

Test Me answer attempts and misses are persisted per reviewer so missed items can
be revisited. Card ratings are stored as review history. Pack rows show how many
cards are due today.

## Scheduling, pacing, mastery and Today

Carded schedules with FSRS (`ts-fsrs`, MIT) and two buttons, Again and Good.

- **Again means tomorrow.** Again always brings the card back the next day. There are no same-day or minute-level steps, so a finite Carded session always ends.
- **Good grows the interval.** Target retention is 0.9 and the longest interval is 365 days. There is no fuzz, so a given history always gives the same schedule.
- **Exam cap.** An optional exam date on the pack caps every due date at the exam, shows a countdown on the pack, and makes cards due now once the exam has passed.
- **Existing cards.** Cards from before FSRS were converted by replaying their review history. Cards never reviewed stay new.
- **Next interval.** Each Carded button shows the interval it would give.

### Exam pacing

Only a pack with an exam date paces its new cards, so each is reviewed at least twice before the exam. New cards per day is the new cards remaining divided by the days left minus 2 (at least 1 day), rounded up, counted over a rolling 24 hours. The last 2 days are held back for second reviews. Due counts on the desk, pack rows and Carded use the paced number. A pack without an exam date introduces at most 20 new cards a day (`NEW_CARDS_PER_DAY`); reviews are never capped. Counts read "N to review · M new" on the desk, pack rows and Carded; the shelf's Due today is their sum.

### Mastery

Mastery is computed when a pack is read, from answers already stored. It makes no model calls and stores nothing new.

- **Sections** are the `##` headings of the current Locked In, the same ones Contents lists.
- **Evidence** is the latest Test Me answer for each question and the latest grade for each card. An item counts toward a section when it cites a page that section cites.
- **Shown** once a section has 3 or more answered items. A section under 60% is weak.
- **Where it shows.** Pack rows show pack mastery and the weakest section. Contents shows a bar per section.

### Today

A one-line bar on the desk sums up the day: cards due, weak sections, the nearest exam, and about how many minutes. It is hidden until there is a pack, and a part with nothing in it is left out. It opens a modal with:

- **Do first.** Review due cards, re-test the weakest sections, then re-read one.
- **Exam pacing.** New cards per day for each topic with an exam.
- **Just browse.** Close the plan and pick any pack.

## Generation

- First-time **Generate** writes all four study modes. When all four exist, the control stays visible, reads **All generated**, and does not call a model. **Generate missing** fills only modes that are not stored yet.
- **Redo** lives on the active study mode. Confirm when that mode already has content.
- Redo Locked In rebuilds Locked In, then Summary, Test Me, and Carded from current sources.
- Redo Summary / Test Me / Carded rewrites only that mode from persisted upstream (Locked In or Summary).
- Disabled when the required upstream is missing, or when no source is `ready` for Locked In / Generate.
- Cards made from Ask answers are user-authored (edited), so Redo Carded keeps them under the same protection rules. The protected-cards confirmation therefore lists them too.
- Locked In, Summary, and individual card faces can be edited. Save and Cancel are explicit. A failed save keeps the draft on screen. A saved edit increments its revision. Edited or pinned content is never silently overwritten. Redo requires an explicit confirmation and reports downstream modes as stale after a Locked In edit.
- One untimed Test Me sitting is active at a time. The same answer saved twice is kept once. A different answer from another tab is rejected and the first answer stays. Retry missed opens only the misses from the completed sitting, and it refuses while a different sitting is still in progress. Start again replaces the active sitting on purpose.
- Same-document Back and Forward keep a dirty Locked In or Summary draft where the browser allows that interception. Other browsers still warn on leave and on in-app links.
- Clear error when the pack is video/audio only or has no ingested text.
- Pipeline (server, full pack): ready sources → Locked In → Summary and Test Me together in one claimed step → Carded; each mode is saved as it finishes. If Test Me fails while Summary succeeds, Carded still runs and the job ends partial so Resume can fill Test Me.
- Models are OpenRouter `:free` ids (defaults and optional fallbacks). Do not use `openrouter/auto` as a primary model. Defaults were probed live with `data_collection: deny` on 2026-09-27: `dots-studio/dots-3-note-preview:free`, falling back to `qwen/qwen3.8-27b:free` and `cohere/north-mini-code:free`. Requests turn model reasoning off so the output budget goes to the answer. The request budget uses the smallest verified context window among the primary and its fallbacks.
- The free OpenRouter tier allows 50 free-model requests per day on this key. A full pack uses about six (four steps plus up to two grounding checks). Reading scanned pages and photos adds about one request per 8 image pages, from the same daily cap. Each Ask, Explain or Ask why that is not reused costs one request from the same cap, so heavy asking can delay a Generate the same day. Search makes no model calls.

## Citations and grounding

- PDF pages and PPTX slides are stored with `<<<page N>>>` markers. DOCX, pasted notes, and images have no pages and are cited as a whole source. A ready PDF or PPTX stored before markers existed shows **Refresh page numbers**, which re-reads the stored file.
- Sources are numbered S1..Sn in upload order. Locked In and Summary end each claim with `[S1 p.14]`, `[S1 pp.14-15]`, `[S1 p.2, p.3]`, or `[S2]`. The view stores which upload each S number meant (`contentJson.citationSources`), so later uploads never re-point old citations.
- After Locked In and Summary are generated, a grounding check compares each claim with its cited pages: a free text-overlap check first, then one batched model call for the misses that must list the facts the evidence lacks. A claim with no support gets `[[unsourced]]`, shown as **Not from your uploaded sources**. The label never says "hallucination": the checker cannot tell invented facts from correct outside knowledge.
- A term guard then tags any supported claim naming a specific term absent from every source. Possessives match their stem ("Sun Tzu's" = "Sun Tzu"), ordinals match their words ("3rd" = "third"), and listed acronyms match their expansion (PCP, AZT). The report records the missing terms per claim (`termFlags`), and the tag shows them: "Not found in your sources: <terms>"; other tags say "The checker could not match this sentence to its cited page."
- `scripts/recheck-tags.ts` re-checks tagged claims with no model call (overlap and term guard only) and clears tags that now pass; dry run by default, `--apply` saves with the normal revision check. Production runs need the owner's go.
- Keep removes the tag. Delete sentence removes the claim. Both use the normal revision-checked save.
- The header shows "N of M claims from your sources" only for grounded documents, where N counts claims without the tag.
- Citation chips open the source in a modal. PDFs render the cited page in the browser from the private file stream.
- Test Me explanations and card backs end with a citation. After a wrong answer, **Open slide N** opens the cited page. Card citations appear only after the flip.
- Locked In and Summary download as PDF (browser print) or Markdown, with options for highlights and notes and for citations.

## Ask this pack

A tutor for one pack. It answers from that pack's sources and nowhere else.

### Ask contract

- **Sources only.** Answers use the pack's Ready sources that have meaningful text, numbered S1..Sn in upload order. Stored source text is reused; nothing is re-read by vision. Outside knowledge is never used, even when the model knows the answer.
- **Cites.** Every factual sentence ends with a citation such as `[S1 p.14]`. Chips open the cited page in the source modal, as elsewhere. Each answer stores the source list it was written against, so chips stay correct after sources are added or removed.
- **Refuses.** When the sources do not cover the question, the answer is labelled **Not in your slides** with fixed copy: "Your lecture does not cover this. I will not answer from outside knowledge here. Check your reference or ask your professor." It names what the lecture does cover nearby, and offers no Make a card or Save to Notes.
- **Allowed shapes.** Mnemonics, comparisons and "what will likely be asked" are fine when every fact comes from the sources and is cited. "Likely asked" follows what the slides emphasize, never outside exam knowledge.
- **Long packs.** If all source text fits the model's budget, all of it is sent. Otherwise the pages that best match the question (and the previous question) are sent, in page order, with no extra model call.
- **One thread per pack.** The last 6 messages of the current thread are sent as context, each cut to 2,000 characters. Questions are limited to 2,000 characters. The thread reloads with the pack.
- **Clear chat.** Hides the thread. Answers saved to Notes stay. Nothing is hard-deleted, and a repeat Explain after Clear asks the model again.
- **One request per question, no verifier.** The answer is not re-checked by the claim verifier or the text-overlap check; the prompt requires a citation on every fact. The answer arrives whole (not streamed) after a "Reading your slides" pending bubble. On failure nothing is stored and the composer keeps the draft with the error. When the free limit is used up, the message is "The free model limit is used up for now. Try again later today."
- **Tags on answers.** A cited sentence is trusted. A sentence of 6 words or more with no citation gets **Not from your uploaded sources**; shorter sentences are never tagged. Text overlap is not used on answers because it flags correct, cited explanations, especially on slides read from images. The tag is informational: chat answers are not editable, so there is no Keep or Delete.
- **Starter chips.** "What will likely be asked?" and "Make me a mnemonic for this lecture", plus "Explain <weakest section>" when mastery has a weak section. They make no request until chosen.
- **Keys and layout.** **A** opens the panel; it is ignored with a modifier key, while typing in a field, or while a dialog is open. **Escape** or the collapse arrow closes it and focus returns to the pill. On desktop it is a right-hand side panel; at 640 px or less it is a bottom sheet. Keys typed in the panel never reach Carded or Test Me, so Space does not flip a card.

### Explain this and Ask why

- **Explain this** appears after a wrong Test Me answer (also in the in-run panel of a timed run) and on a flipped Carded card. It opens Ask with a short bubble, "Explain: <question start>", and explains the item from the current sources. Stored citations are not sent, because their S numbers may not match the pack's current order.
- **Ask why** is an action on **Not from your uploaded sources** tags, in documents and inside chat answers. It asks whether the sentence is supported by the slides and what they say about it.
- **Reuse.** Explain and Ask why are single-turn (no history). Asking the same item or sentence again returns the earlier answer with no model call, and the panel scrolls to it. Clear chat ends reuse.

### Make a card and Save to Notes

- **Make a card** opens an inline form on an answer, front prefilled with the question and back with the answer (unsourced tags removed, citations kept). Both are editable and use the normal card limits. The card is **user-authored** (edited): it joins Carded as a new card due now, counts toward exam pacing like other new cards, and is kept when Carded is redone unless the confirmation to replace protected cards is accepted. A second click on the same answer says **Already a card**.
- **Save to Notes** stores the answer under **From Ask** in Notes, with its question, working citation chips and **Remove from Notes**. It is not anchored to text in Locked In or Summary. Refused answers cannot be saved.

## Search packs

The header button opens a dialog that searches every pack the signed-in user owns. It makes no model calls and adds no global shortcut.

- **What is indexed.** Ready source text (the first 150,000 characters of each source), Locked In and Summary (the first 150,000 characters of each), and card fronts and backs. Text past that prefix is not searchable. Archived cards and sources still being deleted are left out.
- **Query.** Plain words with English stemming, trimmed to 2 to 200 characters. A query outside that range returns no results, not an error. The dialog waits briefly after typing (250 ms) and shows at most 30 results, grouped by pack. Arrow keys move, Enter opens, Escape closes.
- **Links.** A slide hit opens that page in the source modal on the pack. A Locked In or Summary hit opens the mode and scrolls to the nearest section heading. A card hit opens Carded.
- **Privacy.** Results are scoped to the owner; another user's packs never appear.

## Auth and security facts

- Auth.js Credentials against the `users` table (scrypt password hashes). Session `user.id` is the user uuid.
- No public register page. Invite with `npm run user:create -- email@x [name]`; the script reads the password from hidden stdin.
- Forgot password is public at `/forgot-password`. It emails a hashed, single-use, one-hour reset link via Resend. The success copy does not reveal whether the email exists. `/reset-password` is also public.
- Middleware/proxy protects pages and APIs; unauthenticated pages go to `/login` except forgot/reset password; APIs return 401.
- Every topic/reviewer/source/view/job API is scoped by session user. Cross-user ids return 404 (no existence leak).
- `OPENROUTER_API_KEY` is server-only. Client never reads it.
- Source bytes are private application data. Upload paths, metadata, and
  retrieval are scoped to the signed-in owner and reviewer; clients must not
  depend on public blob URLs. Do not wait on Blob `onUploadCompleted` for source rows.
- Privacy: notes and extracted text are sent to third-party free model providers via OpenRouter. Requests ask for `data_collection: deny` where supported; treat provider policy as best-effort.
- Generation runs create a persisted job before model work, and clients poll
  that job as the source of truth. Refresh resumes from the last completed step.
  Each successful mode remains available when a later step fails.
- File cleanup is coordinated with database deletion tombstones: source
  creation locks the reviewer/topic at final registration, direct uploads use
  owner-scoped pathname reservations, deletion claims only unreferenced private
  Blobs before deleting rows, and an expired lease permits retry after a
  crashed cleanup. Pasted notes have nullable Blob fields and never call the
  Blob provider.

## Configuration (names only)

| Variable | Role |
| --- | --- |
| `AUTH_SECRET` | Session signing, at least 32 characters |
| `AUTH_TRUST_HOST` | Accept host before `AUTH_URL` is set |
| `AUTH_URL` | Canonical production URL |
| `RESEND_API_KEY` | Password-reset email (server only) |
| `EMAIL_FROM` | Optional From address for reset email |
| `DATABASE_URL` | Neon Postgres (use the direct/unpooled URL for `db:baseline`, `db:migrate` and `db:backfill-fsrs`) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob |
| `OPENROUTER_API_KEY` | Generation (server only) |
| `AI_MODEL_LOCKED_IN` | Locked In model id (`:free`) |
| `AI_MODEL_SUMMARY` | Summary model id (`:free`) |
| `AI_MODEL_JSON` | Test Me / Carded model id (`:free`) |
| `AI_MODEL_VISION` | Vision model id for slide images and photos (`:free`) |
| `AI_MODEL_FALLBACKS` | Comma-separated `:free` fallbacks |

## Operator notes

1. Apply the schema with committed migrations, using Neon's **direct / unpooled** `DATABASE_URL` (the pooler cannot run migrations). Change `lib/schema.ts`, run `npm run db:generate -- --name <x>`, rehearse `npm run db:baseline` (once per database) and `npm run db:migrate` on a disposable Neon branch, then repeat on production only with the owner's go, after a snapshot. `npm run db:backfill-fsrs` is a one-time, idempotent run after `0001`. `npm run db:push` is for local scratch databases only, never production. See the README.
2. Create the first invite: `npm run user:create -- you@example.com 'Name'` and enter its password at the hidden stdin prompt.
3. Sign in; create topics only after a user exists (`topics.user_id` is required).
4. Optional migrate path: if existing rows lack owners, add `user_id` nullable first, run `user:create` with `--bootstrap`, then tighten to not null.

5. `0002_tutor` adds the pack chat table and generated search vectors on sources, views and cards. It only adds objects, so a rerun is a no-op. Apply it like any migration: rehearse on a disposable branch first, then production with the owner's go.

Stay on Neon. Friends cannot see each other's packs.

## Product principles

- Operate UI: task first, chrome quiet, reading surface warm.
- Empty states teach the model (topic → reviewer → sources → generate).
- Full control states: empty, loading, error, disabled, hover, focus.
- Copy never uses an em dash.
- Icons: Phosphor only.
- Mobile: single column below 768px; no horizontal overflow at 390px.
