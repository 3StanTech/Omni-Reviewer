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
| **Source** | An uploaded file (PDF, DOCX, PPTX, image, text, video, audio) or pasted notes with an ingest status. |
| **Study mode** | One of four persisted study surfaces for a reviewer (Locked In, Summary, Test Me, Carded). |

## Information architecture

- `/login` - email + password. No public signup, no roles.
- `/` - topic tabs, create/rename/delete topic, list of reviewers in the selected topic, create/rename/delete reviewer.
- `/topics/[topicId]/reviewers/[reviewerId]` - pack workspace: source list and upload, generate/regenerate, four study mode tabs.

Topic tabs are primary navigation. A reviewer is a workspace, not a metrics dashboard.

## Ingest rules (v1)

| Kind | Behavior | UI badge |
| --- | --- | --- |
| Text PDF, DOCX, PPTX, image, text, pasted notes | Fully ingested; used for generation | No badge when Ready; **Failed** with message when ingest fails |
| Video, audio | Stored as blob only; not transcribed | **Not yet processed** |

DOCX and PPTX are parsed as bounded ZIP/XML text without a native canvas inside a
killable server worker. Text PDFs use the same killable worker boundary. Scanned
PDF vision fallback is explicitly unavailable in this deployment because the
available PDF.js image API enumerates/decodes a complete page before returning
it; enabling it requires a worker renderer with hard page, operator, image,
pixel, byte, and CPU limits. Pasted notes are plain text in the database and
have no Blob object to delete. File sources retain private Blob lifecycle
handling, with a single 55-second route deadline beginning before Blob
verification.
Failed sources keep an error message. Video/audio-only packs cannot generate in v1.

## Four study modes

Generated only on explicit Generate or Redo. Tab changes never call the model. Study modes reload from persistence.

1. **Locked In** - comprehensive, cohesive, chronological long-form study document (sanitized Markdown with tables and KaTeX). Source of truth.
2. **Summary** - detailed summary of Locked In for last-minute review (sanitized Markdown with tables and KaTeX).
3. **Test Me** - generated multiple-choice questionnaire with optional answer reveal and persisted attempts/misses; legacy open-ended items remain answerable. An optional server-timed run presents one question at a time.
4. **Carded** - durable flashcards from Summary: flip, rate Again / Good, previous / next. A front using `{{answer}}` placeholders is shown as a cloze card with an explicit reveal step.

Test Me answer attempts and misses are persisted per reviewer so missed items can
be revisited. Card ratings use a small two-button SM-2 schedule and are stored
as review history. An optional exam date caps future card due dates.

## Generation

- First-time **Generate** writes all four study modes. After that the button is hidden.
- **Redo** lives on the active study mode. Confirm when that mode already has content.
- Redo Locked In rebuilds Locked In, then Summary, Test Me, and Carded from current sources.
- Redo Summary / Test Me / Carded rewrites only that mode from persisted upstream (Locked In or Summary).
- Disabled when the required upstream is missing, or when no source is `ready` for Locked In / Generate.
- Locked In and individual card faces can be edited. A saved edit increments its
  revision and can be pinned; edited or pinned content is never silently
  overwritten. Redo requires an explicit confirmation and reports downstream
  modes as stale after a Locked In edit.
- Clear error when the pack is video/audio only or has no ingested text.
- Pipeline (server, full pack): ready sources → Locked In → Summary → Test Me → Carded; each mode is saved as it finishes.
- Models are OpenRouter `:free` ids (defaults and optional fallbacks). Do not use `openrouter/auto` as a primary model.

## Auth and security facts

- Auth.js Credentials against the `users` table (scrypt password hashes). Session `user.id` is the user uuid.
- No public register page. Invite with `npm run user:create -- email@x [name]`; the script reads the password from hidden stdin.
- Middleware/proxy protects pages and APIs; unauthenticated pages go to `/login`, APIs return 401.
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
| `DATABASE_URL` | Neon Postgres (use direct/unpooled URL for `db:push`) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob |
| `OPENROUTER_API_KEY` | Generation (server only) |
| `AI_MODEL_LOCKED_IN` | Locked In model id (`:free`) |
| `AI_MODEL_SUMMARY` | Summary model id (`:free`) |
| `AI_MODEL_JSON` | Test Me / Carded model id (`:free`) |
| `AI_MODEL_VISION` | Vision model id for images (`:free`) |
| `AI_MODEL_FALLBACKS` | Comma-separated `:free` fallbacks |

## Operator notes

1. Push schema with Neon **direct / unpooled** `DATABASE_URL` (`npm run db:push`). The Neon pooler cannot run migrations.
2. Create the first invite: `npm run user:create -- you@example.com 'Name'` and enter its password at the hidden stdin prompt.
3. Sign in; create topics only after a user exists (`topics.user_id` is required).
4. Optional migrate path: if existing rows lack owners, add `user_id` nullable first, run `user:create` with `--bootstrap`, then tighten to not null.

Stay on Neon. Friends cannot see each other's packs.

## Product principles

- Operate UI: task first, chrome quiet, reading surface warm.
- Empty states teach the model (topic → reviewer → sources → generate).
- Full control states: empty, loading, error, disabled, hover, focus.
- Copy never uses an em dash.
- Icons: Phosphor only.
- Mobile: single column below 768px; no horizontal overflow at 390px.
