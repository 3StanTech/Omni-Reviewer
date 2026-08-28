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
| **Source** | An uploaded file (PDF, image, text, video, audio) with an ingest status. |
| **Study mode** | One of four persisted study surfaces for a reviewer (Locked In, Summary, Test Me, Carded). |

## Information architecture

- `/login` - email + password. No public signup, no roles.
- `/` - topic tabs, create/rename/delete topic, list of reviewers in the selected topic, create/rename/delete reviewer.
- `/topics/[topicId]/reviewers/[reviewerId]` - pack workspace: source list and upload, generate/regenerate, four study mode tabs.

Topic tabs are primary navigation. A reviewer is a workspace, not a metrics dashboard.

## Ingest rules (v1)

| Kind | Behavior | UI badge |
| --- | --- | --- |
| PDF, image, text | Fully ingested; used for generation | No badge when Ready; **Failed** with message when ingest fails |
| Video, audio | Stored as blob only; not transcribed | **Not yet processed** |

Failed sources keep an error message. Video/audio-only packs cannot generate in v1.

## Four study modes

Generated only on explicit Generate or Redo. Tab changes never call the model. Study modes reload from persistence.

1. **Locked In** - comprehensive, cohesive, chronological long-form study document (markdown). Source of truth.
2. **Summary** - detailed summary of Locked In for last-minute review (markdown).
3. **Test Me** - questionnaire: optional reveal of answers, optional local score (not persisted).
4. **Carded** - flashcards from Summary: flip, previous / next.

## Generation

- First-time **Generate** writes all four study modes. After that the button is hidden.
- **Redo** lives on the active study mode. Confirm when that mode already has content.
- Redo Locked In rebuilds Locked In, then Summary, Test Me, and Carded from current sources.
- Redo Summary / Test Me / Carded rewrites only that mode from persisted upstream (Locked In or Summary).
- Disabled when the required upstream is missing, or when no source is `ready` for Locked In / Generate.
- Clear error when the pack is video/audio only or has no ingested text.
- Pipeline (server, full pack): ready sources → Locked In → Summary → Test Me → Carded; each mode is saved as it finishes.
- Models are OpenRouter `:free` ids (defaults and optional fallbacks). Do not use `openrouter/auto` as a primary model.

## Auth and security facts

- Auth.js Credentials against the `users` table (scrypt password hashes). Session `user.id` is the user uuid.
- No public register page. Invite with `npm run user:create -- email@x password [name]`.
- Middleware/proxy protects pages and APIs; unauthenticated pages go to `/login`, APIs return 401.
- Every topic/reviewer/source/view/job API is scoped by session user. Cross-user ids return 404 (no existence leak).
- `OPENROUTER_API_KEY` is server-only. Client never reads it.
- Client uploads go direct to Vercel Blob under `users/<userId>/reviewers/<reviewerId>/...`, then `POST` metadata to `/api/reviewers/[id]/sources`. Do not wait on Blob `onUploadCompleted` for source rows.
- Privacy: notes and extracted text are sent to third-party free model providers via OpenRouter. Requests ask for `data_collection: deny` where supported; treat provider policy as best-effort.

## Configuration (names only)

| Variable | Role |
| --- | --- |
| `AUTH_SECRET` | Session signing |
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
2. Create the first invite: `npm run user:create -- you@example.com 'password' 'Name'`.
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
