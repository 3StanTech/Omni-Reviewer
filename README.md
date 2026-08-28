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
3. **Test Me**. Questionnaire / quiz of the material.
4. **Carded**. Flashcards derived from Summary.

Study modes are persisted. Generate or regenerate only on an explicit action.

### v1 ingest rules

| Upload kind | Behavior |
| --- | --- |
| PDF, image, text | Fully ingested and used as generation input |
| Video, audio | Stored (blob reference only); **not** transcribed or parsed in v1 |

## Local setup

```bash
npm install
cp .env.example .env.local
# fill in values in .env.local
# use Neon direct/unpooled DATABASE_URL for schema push
npm run db:push
npm run user:create -- you@example.com 'your-password' 'Your Name'
npm run dev
```

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
| `AUTH_SECRET` | Session signing secret |
| `AUTH_TRUST_HOST` | Set to `true` so the first production host is accepted |
| `AUTH_URL` | Canonical app URL (set after first production deploy) |

See `.env.example` for the full list.

`db:push` must use Neon’s **direct / unpooled** connection string. The pooler endpoint cannot run migrations.

## Login and invites

- Sign in at `/login` with email + password.
- Create invites (no public register):

```bash
npm run user:create -- friend@example.com 'password' 'Friend Name'
# optional: assign orphaned rows after a nullable user_id migration
npm run user:create -- friend@example.com 'password' 'Friend Name' --bootstrap
```

Do not print or commit passwords.

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

## Stack

Next.js (App Router), TypeScript, Tailwind CSS, Auth.js, Drizzle ORM, Neon Postgres, Vercel Blob, OpenRouter.
