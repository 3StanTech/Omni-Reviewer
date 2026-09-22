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
4. **Carded**. Durable flashcards derived from Summary, with Again / Good scheduling.

New Test Me generation produces multiple-choice questions and saves submitted
answers and misses per reviewer. Existing legacy open-ended questions remain
answerable with a text response, so older packs are not made unusable. Card
reviews are persisted with a small SM-2 schedule, and an optional exam date
prevents cards from being scheduled after the exam. Locked In and card faces
support explicit editing and pinning; generation asks for confirmation before
replacing any edited or pinned content, and downstream modes show stale
warnings after a Locked In edit.

Study modes are persisted. Generate or regenerate only on an explicit action.

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
| Text PDF, DOCX, PPTX, image, text, pasted notes | Fully ingested and used as generation input. Scanned-PDF vision fallback is explicitly unavailable in this deployment until a bounded renderer is enabled. |
| Video, audio | Stored (blob reference only); **not** transcribed or parsed in v1 |

DOCX and PPTX extraction reads bounded XML text from the office archive without a
native canvas. Paste text is stored directly as private database content, not as
a Blob. File uploads remain private Blob objects and are checked against the
signed-in user and reviewer before registration. YouTube, audio, and video
transcription remain deferred.

Ingest uses one bounded deadline beginning before Blob verification. Provider
requests and Blob reads receive the route abort signal where supported; Blob
streams cancel on abort. Office and PDF parsing run in a killable server worker,
which is terminated on deadline or client cancellation. Scanned-PDF vision is
disabled until a worker renderer can enforce page/operator/image/pixel limits;
the API returns an explicit error rather than attempting unbounded rendering.
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
# use Neon direct/unpooled DATABASE_URL for schema push
npm run db:push
npm run user:create -- you@example.com 'Your Name'
npm run dev
```

The invite script reads the password from stdin and does not accept passwords
as command-line arguments. In an interactive terminal it prompts without
echoing the password.

Open [http://localhost:3000](http://localhost:3000) and sign in with the email and password you created.

## Required environment variables

Names only — set values in `.env.local` (local) or your host (production):

| Name | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter API key for generation (server only) |
| `AI_MODEL_LOCKED_IN` | Locked In model id (`:free`) |
| `AI_MODEL_SUMMARY` | Summary model id (`:free`) |
| `AI_MODEL_JSON` | Test Me / Carded model id (`:free`) |
| `AI_MODEL_VISION` | Vision model id for images (`:free`) |
| `AI_MODEL_FALLBACKS` | Comma-separated `:free` fallback model ids |
| `DATABASE_URL` | Neon Postgres connection string |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob read/write token |
| `AUTH_SECRET` | Session signing secret, at least 32 characters |
| `AUTH_TRUST_HOST` | Set to `true` so the first production host is accepted |
| `AUTH_URL` | Canonical app URL (set after first production deploy) |
| `RESEND_API_KEY` | Resend API key for password-reset email (server only) |
| `EMAIL_FROM` | Optional From header. Defaults to the Resend onboarding sender |

See `.env.example` for the full list.

`db:push` must use Neon’s **direct / unpooled** connection string. The pooler endpoint cannot run migrations.

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
| `npm run db:push` | Push Drizzle schema (direct/unpooled `DATABASE_URL`) |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run user:create` | Invite a user (`tsx scripts/create-user.ts`) |
| `npm test` | Run Vitest |

GitHub Actions runs `npm test` and `npm run lint` on main and pull requests.

## Stack

Next.js (App Router), TypeScript, Tailwind CSS, Auth.js, Drizzle ORM, Neon Postgres, Vercel Blob, OpenRouter.
