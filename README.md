# Omni-Reviewer

Personal study packs: organize topics, attach sources, and generate four persistent study modes from what you upload.

## What it is

Omni-Reviewer is a signed-in, invite-only multi-user study app. Accounts are created by an operator; there is no public signup. Each user only sees their own topics and packs.

- **Topics** are the top-level tabs (per user).
- Each topic holds many **reviewers** (study packs).
- Each reviewer owns its own uploaded **sources** and an independent set of four **study modes**.

### Four study modes (per reviewer)

1. **Locked In**. Comprehensive, cohesive, chronological long-form study document.
2. **Summary**. Detailed summary of Locked In for last-minute review.
3. **Test Me**. Questionnaire / quiz of the material, including an optional timed one-question run.
4. **Carded**. Durable flashcards derived from Summary, scheduled with FSRS (Again / Good).

New Test Me generation produces multiple-choice questions and saves submitted
answers and misses per reviewer. Existing legacy open-ended questions remain
answerable with a text response, so older packs are not made unusable. Card
reviews are persisted and scheduled with FSRS, and an optional exam date
prevents cards from being scheduled after the exam. Locked In and card faces
support explicit editing and pinning; generation asks for confirmation before
replacing any edited or pinned content, and downstream modes show stale
warnings after a Locked In edit.

Study modes are persisted. Generate or regenerate only on an explicit action.

Each pack also has **Ask this pack**, a tutor that answers only from the pack's
own sources and cites slide pages, and a header **Search packs** for full-text
search across every pack. See [Ask this pack and search](#ask-this-pack-and-search).

Locked In and Summary share an explicit Markdown editor with Save changes and
Cancel. Tables and ordinary Markdown use the formatted editor; documents with
math or legacy semantic ink use a labelled source-preserving fallback. In
reading mode, select text to add an allowlisted highlight or note. Annotations
are owner- and revision-scoped, and displaced quotes remain available under
Earlier version. Contents, Notes, and reading position are optional disclosures.

The active visual choices are Day and Night. Existing Thea-Style or
RemNote-Style local preferences are normalized to Day without changing study
data.

### v1 ingest rules

| Upload kind | Behavior |
| --- | --- |
| Text PDF, DOCX, PPTX, text, pasted notes | Fully ingested and used as generation input. |
| Scanned or image-heavy PDF, photos of slides | Read page by page from the slide image (pages under about 200 characters of text), then used as generation input. Photos picked together become one source with a page per photo. HEIC is converted in the browser. |
| Video, audio | Stored (blob reference only); **not** transcribed or parsed in v1 |

DOCX and PPTX extraction reads bounded XML text from the office archive without a
native canvas. Paste text is stored directly as private database content, not as
a Blob. File uploads remain private Blob objects and are checked against the
signed-in user and reviewer before registration. YouTube, audio, and video
transcription remain deferred.

Ingest uses one bounded deadline beginning before Blob verification. Provider
requests and Blob reads receive the route abort signal where supported; Blob
streams cancel on abort. Office and PDF parsing run in a killable server worker,
which is terminated on deadline or client cancellation. Slide images are read
in a separate step after upload: the browser renders each page (or photo) to a
small JPEG, and the server sends batches of up to 8 to the vision model set in
`AI_MODEL_VISION`. That costs about one free model request per 8 image pages,
from the shared daily free-request cap. Reading resumes on the next visit if it
is interrupted, and Generate waits while slides are being read. There are no new
environment variables.
Direct uploads acquire a durable, owner-scoped pathname reservation before
upload, and source paths are unique. Reviewer/topic deletion first records a
durable database tombstone, marks source rows for deletion, cleans only
unreferenced file Blobs, then deletes rows; failed or crashed cleanup is
retryable through the reservation/deletion lease, while paste rows (which have
no Blob) are handled directly.

## Local setup

```bash
npm install
cp .env.example .env.local
# fill in values in .env.local
# db:push is for a local scratch database only; see Schema changes and migrations
npm run db:push
npm run user:create -- you@example.com 'Your Name'
npm run dev
```

The invite script reads the password from stdin and does not accept passwords
as command-line arguments. In an interactive terminal it prompts without
echoing the password.

Open [http://localhost:3000](http://localhost:3000) and sign in with the email and password you created.

## Required environment variables

Names only. Set values in `.env.local` (local) or your host (production):

| Name | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter API key for generation (server only) |
| `AI_MODEL_LOCKED_IN` | Locked In model id (`:free`) |
| `AI_MODEL_SUMMARY` | Summary model id (`:free`) |
| `AI_MODEL_JSON` | Test Me / Carded model id (`:free`) |
| `AI_MODEL_VISION` | Vision model id for images (`:free`) |
| `AI_MODEL_FALLBACKS` | Comma-separated `:free` fallback model ids. Leave the model variables blank to use the probed defaults in `lib/env.ts`; a fallback is sent only when it is in the verified catalogue in `lib/openrouter.ts`. |
| `DATABASE_URL` | Neon Postgres connection string |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob read/write token |
| `AUTH_SECRET` | Session signing secret, at least 32 characters |
| `AUTH_TRUST_HOST` | Set to `true` so the first production host is accepted |
| `AUTH_URL` | Canonical app URL (set after first production deploy) |
| `RESEND_API_KEY` | Resend API key for password-reset email (server only) |
| `EMAIL_FROM` | Optional From header. Defaults to the Resend onboarding sender |

See `.env.example` for the full list.

Schema commands (`db:baseline`, `db:migrate`, `db:backfill-fsrs`, and `db:push` locally) must use Neon’s **direct / unpooled** connection string. The pooler endpoint cannot run migrations.

## Scheduling and study engine

- **FSRS.** Cards use `ts-fsrs` (MIT) with Again and Good only. Again always means tomorrow. Target retention is 0.9, the longest interval is 365 days, and there is no fuzz and no same-day step. Intervals are capped at the pack's exam date. Cards that existed before FSRS were converted by replaying their review history. The Carded buttons show the next interval.
- **Pacing.** Only packs with an exam date. New cards are spread so each is reviewed at least twice before the exam: `ceil(newRemaining / max(1, daysUntilExam - 2))` per day, over a rolling 24 hours. Packs without an exam date show every due new card.
- **Mastery.** Per Locked In `##` section, from the latest Test Me answer for each question and the latest card grade, mapped to sections by the pages they cite. Shown once a section has 3 or more answered items, and weak under 60%. Pack rows show pack mastery and the weakest section, and Contents shows a bar per section. No model calls.
- **Today.** A one-line bar on the desk (cards due, weak sections, nearest exam, about N minutes) opens a modal with Do first, exam pacing per topic, and Just browse.

## Ask this pack and search

- **Ask, Explain this, Ask why.** One thread per pack. Answers use only the pack's Ready sources, end with slide citations, and refuse ("Not in your slides") when the sources do not cover the question. The full contract is in `PRODUCT.md`.
- **Save to Notes and Make a card.** A saved answer shows under "From Ask" in Notes. Make a card adds a user-authored card to Carded.
- **Search packs.** A header dialog that searches slide text, Locked In, Summary and cards across the signed-in user's packs. It makes no model calls.

Routes (all require a session; cross-user ids return 404):

| Route | Purpose |
| --- | --- |
| `GET /api/reviewers/[id]/ask` | The pack's current thread and its answers saved to Notes |
| `POST /api/reviewers/[id]/ask` | Ask a question, Explain a missed Test Me item or a card, or Ask why for an unsourced sentence. Returns one JSON response (not streamed). A repeat Explain or Ask why returns the earlier answer with `reused: true` and no model call. `maxDuration` is 120 |
| `DELETE /api/reviewers/[id]/ask` | Clear chat. Hides the thread; answers saved to Notes stay |
| `PATCH /api/reviewers/[id]/ask/[messageId]` | Save an answer to Notes, or remove it (`{ saved }`) |
| `POST /api/reviewers/[id]/ask/[messageId]/card` | Make a card from an answer. Idempotent per answer |
| `GET /api/search?q=` | Full-text search. A query outside 2 to 200 characters returns no results |

**Free-request quota.** Each Ask, Explain or Ask why that is not reused costs one request from the shared daily free-model cap (50 a day on this key, the same cap Generate and slide reading use). There is no separate app-side limit, so heavy asking can delay a Generate the same day. When the provider reports the limit is used up, Ask shows "The free model limit is used up for now. Try again later today." and keeps the draft. Search, Save to Notes, Make a card, Clear chat and a reused Explain or Ask why make no model calls. Ask does not run the grounding verifier, so a question is exactly one request.

Search reads generated `tsvector` columns, so no write path changed. It indexes the first 150,000 characters of each source and of each Locked In and Summary document, plus card fronts and backs. Text past that prefix is not searchable.

## Schema changes and migrations

Migrations are committed in `drizzle/`. `drizzle/0000_baseline` is the schema as it stood before migrations began, `0001` adds the FSRS columns, and `0002_tutor` adds the pack chat table (`pack_chat_messages`) and the generated, GIN-indexed `search_tsv` columns on `sources`, `views` and `cards`.

1. Change the schema in `lib/schema.ts`, then run `npm run db:generate -- --name <x>` and commit the new `drizzle/` files.
2. Rehearse on a disposable Neon branch, with its direct URL as `DATABASE_URL`:
   - `npm run db:baseline`, once per database. It verifies the database has no drift from `drizzle/0000_baseline`, then records the baseline. It changes only drizzle's own migrations table.
   - `npm run db:migrate` applies the migrations after the baseline.
3. Then production, with the owner's go, after a Neon snapshot. Run the same two commands against production's direct URL.
4. `npm run db:backfill-fsrs` is a one-time run after `0001`. It sets FSRS state on cards that have none by replaying their reviews, and it is idempotent, so a second run changes nothing.
5. `0002_tutor` only adds objects, so it needs no backfill and rerunning `npm run db:migrate` is a no-op. Adding the `search_tsv` columns computes the vector for existing rows, which is quick at this scale.

`npm run db:push` is for local scratch databases only. Never run it against production.

## Privacy and generation contracts

- Source bytes and extracted text are private application data. Storage paths,
  metadata, and retrieval must remain scoped to the signed-in owner and reviewer;
  clients must not rely on public blob URLs.
- A generation run is represented by a persisted job before model work begins.
  The client treats the job id and server status as the source of truth, polls
  for progress, and can resume after a refresh from the last completed step.
- Each completed study mode is persisted immediately. A partial or failed run
  keeps completed modes available and reports the failed step without silently
  replacing it with stale content.
- Provider errors are returned through the app’s stable error shape. Raw
  provider payloads and credentials are never sent to the browser.

## Login and invites

- Sign in at `/login` with email + password.
- Five failed sign-ins in 15 minutes lock that email for 15 minutes.
- Forgot password sends a one-hour, single-use link when `RESEND_API_KEY` is set. The form does not say whether the email has an invite.
- Create invites (no public register):

```bash
npm run user:create -- friend@example.com 'Friend Name'
# optional: assign orphaned rows after a nullable user_id migration
npm run user:create -- friend@example.com 'Friend Name' --bootstrap
```

Enter the password at the hidden stdin prompt. For automation, pipe one
password line to the command from a protected secret source.

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Production build |
| `npm run start` | Start the production server |
| `npm run lint` | Run ESLint |
| `npm run db:generate` | Generate a Drizzle migration from `lib/schema.ts` (`-- --name <x>`) |
| `npm run db:baseline` | Record `0000_baseline` on an existing database after a drift check (once per database, direct URL) |
| `npm run db:migrate` | Apply committed migrations (direct/unpooled `DATABASE_URL`) |
| `npm run db:backfill-fsrs` | One-time, idempotent FSRS backfill after `0001` (direct URL) |
| `npm run db:push` | Push the schema to a local scratch database only |
| `npm run user:create` | Invite a user (`tsx scripts/create-user.ts`) |
| `npm test` | Run Vitest |

GitHub Actions runs `npm test` and `npm run lint` on main and pull requests.

## Notable dependencies

`heic-to` (LGPL-3.0) converts iPhone HEIC and HEIF photos to JPEG in the browser.
It is loaded only when a HEIC file is picked, and the conversion runs in the browser.
PDF pages are rendered with `unpdf`, which is also loaded on demand.

## Stack

Next.js (App Router), TypeScript, Tailwind CSS, Auth.js, Drizzle ORM, Neon Postgres, Vercel Blob, OpenRouter.
