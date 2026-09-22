import { relations } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  integer,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { GenerateKind } from "@/lib/generation-plan";

export const sourceKindEnum = pgEnum("source_kind", [
  "pdf",
  "image",
  "text",
  "document",
  "presentation",
  "paste",
  "video",
  "audio",
]);

export const ingestStatusEnum = pgEnum("ingest_status", [
  "ready",
  "unprocessed",
  "failed",
]);

export const blobReservationStateEnum = pgEnum("blob_reservation_state", [
  "reserved",
  "released",
  "deleting",
]);

export const viewKindEnum = pgEnum("view_kind", [
  "locked_in",
  "summary",
  "test_me",
  "carded",
]);

/** Study documents that support user annotations. */
export const annotationViewKindEnum = pgEnum("annotation_view_kind", [
  "locked_in",
  "summary",
]);

export const generationJobStatusEnum = pgEnum("generation_job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "partial",
]);

export const generationJobStepEnum = pgEnum("generation_job_step", [
  "locked_in",
  "summary",
  "test_me",
  "carded",
]);

export const generationJobModeEnum = pgEnum("generation_job_mode", [
  "full",
  "single",
]);

export const generationJobIntentEnum = pgEnum("generation_job_intent", [
  "generate_missing",
  "redo",
]);

export const cardRatingEnum = pgEnum("card_rating", ["again", "good"]);

export const testSessionStatusEnum = pgEnum("test_session_status", [
  "active",
  "completed",
  "expired",
]);

export const testSessionModeEnum = pgEnum("test_session_mode", [
  "timed",
  "untimed",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const loginThrottles = pgTable("login_throttles", {
  email: text("email").primaryKey(),
  failedCount: integer("failed_count").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("password_reset_tokens_token_hash_unique").on(table.tokenHash),
    index("password_reset_tokens_user_idx").on(table.userId, table.createdAt),
  ],
);

export const topics = pgTable("topics", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Set before external Blob cleanup so source creation cannot race deletion. */
  deletingAt: timestamp("deleting_at", { withTimezone: true }),
});

export const reviewers = pgTable("reviewers", {
  id: uuid("id").defaultRandom().primaryKey(),
  topicId: uuid("topic_id")
    .notNull()
    .references(() => topics.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastGeneratedAt: timestamp("last_generated_at", { withTimezone: true }),
  examDate: date("exam_date", { mode: "string" }),
  /** Set before external Blob cleanup so source creation cannot race deletion. */
  deletingAt: timestamp("deleting_at", { withTimezone: true }),
});

export const sources = pgTable("sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  reviewerId: uuid("reviewer_id")
    .notNull()
    .references(() => reviewers.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  kind: sourceKindEnum("kind").notNull(),
  blobUrl: text("blob_url"),
  blobPathname: text("blob_pathname"),
  ingestStatus: ingestStatusEnum("ingest_status").notNull(),
  extractedText: text("extracted_text"),
  errorMessage: text("error_message"),
  /** Set before provider deletion; retained for retry if Blob cleanup fails. */
  deletingAt: timestamp("deleting_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  // A pathname is the Blob identity. A second source must never be able to
  // claim the same object, including across reviewers/tenants.
  uniqueIndex("sources_blob_pathname_unique")
    .on(table.blobPathname)
    .where(sql`${table.blobPathname} IS NOT NULL`),
]);

/**
 * Durable protection for a direct upload between token minting and source
 * registration, and for provider cleanup after a source is deleted. The
 * pathname is globally unique so a delayed/duplicate registration cannot be
 * confused with another owner or cleanup attempt.
 */
export const blobReservations = pgTable("blob_reservations", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  reviewerId: uuid("reviewer_id")
    .notNull()
    .references(() => reviewers.id, { onDelete: "cascade" }),
  pathname: text("pathname").notNull().unique(),
  /** Opaque upload/cleanup attempt identity used for every lifecycle CAS. */
  attemptToken: text("attempt_token").notNull().default("legacy"),
  state: blobReservationStateEnum("state").notNull().default("reserved"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("blob_reservations_owner_state_idx").on(
    table.userId,
    table.reviewerId,
    table.state,
    table.leaseExpiresAt,
  ),
]);

export const views = pgTable(
  "views",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => reviewers.id, { onDelete: "cascade" }),
    kind: viewKindEnum("kind").notNull(),
    content: text("content").notNull().default(""),
  contentJson: jsonb("content_json"),
  modelId: text("model_id"),
  /** The generation run that produced this view. Null is retained for pre-run rows. */
  generationRunId: uuid("generation_run_id"),
  /** Canonical document revision; annotation anchors refer to this value. */
  contentRevision: integer("content_revision").notNull().default(1),
  /** Monotonic annotation-set revision used by batch-save compare-and-set. */
  annotationRevision: integer("annotation_revision").notNull().default(1),
  revision: integer("revision").notNull().default(1),
    isEdited: boolean("is_edited").notNull().default(false),
    isPinned: boolean("is_pinned").notNull().default(false),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique("views_reviewer_id_kind_unique").on(table.reviewerId, table.kind)],
);

export const annotationColorEnum = pgEnum("annotation_color", [
  "sun",
  "sky",
  "mint",
  "rose",
]);

/** User-created highlights/notes are separate from generated Markdown. */
export const annotations = pgTable("study_annotations", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  reviewerId: uuid("reviewer_id")
    .notNull()
    .references(() => reviewers.id, { onDelete: "cascade" }),
  viewId: uuid("view_id")
    .notNull()
    .references(() => views.id, { onDelete: "cascade" }),
  kind: annotationViewKindEnum("kind").notNull(),
  contentRevision: integer("content_revision").notNull(),
  startOffset: integer("start_offset").notNull(),
  endOffset: integer("end_offset").notNull(),
  quote: text("quote").notNull(),
  prefix: text("prefix").notNull().default(""),
  suffix: text("suffix").notNull().default(""),
  color: annotationColorEnum("color").notNull().default("sun"),
  note: text("note"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archiveReason: text("archive_reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("study_annotations_view_active_idx").on(table.viewId, table.archivedAt),
  index("study_annotations_reviewer_idx").on(table.reviewerId, table.createdAt),
  check(
    "study_annotations_bounds_valid",
    sql`${table.startOffset} >= 0 AND ${table.endOffset} > ${table.startOffset} AND length(${table.quote}) > 0 AND length(${table.quote}) <= 10000`,
  ),
]);

export const generationJobs = pgTable("generation_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  reviewerId: uuid("reviewer_id")
    .notNull()
    .references(() => reviewers.id, { onDelete: "cascade" }),
  status: generationJobStatusEnum("status").notNull(),
  step: generationJobStepEnum("step"),
  mode: generationJobModeEnum("mode").notNull().default("full"),
  /** Explicit user action. Legacy rows default to redo and are reconstructed by mode/step. */
  intent: generationJobIntentEnum("intent").notNull().default("redo"),
  /** Frozen server-computed targets. Empty means a legacy row awaiting reconstruction. */
  targetKinds: jsonb("target_kinds")
    .$type<GenerateKind[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  /** Steps whose view/card persistence completed before the latest response. */
  completedKinds: jsonb("completed_kinds")
    .$type<GenerateKind[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  /** Revisions for upstream inputs that existed when the run was created. */
  upstreamRevisions: jsonb("upstream_revisions")
    .$type<Partial<Record<GenerateKind, number>>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  /** Stable identity shared by every step in one full generation run. */
  generationRunId: uuid("generation_run_id").defaultRandom().notNull(),
  /** Active jobs are unique per reviewer; terminal jobs are retained for history. */
  active: boolean("active").notNull().default(true),
  claimToken: text("claim_token"),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  modelUsed: text("model_used"),
  forceOverwrite: boolean("force_overwrite").notNull().default(false),
  /** Protected view/card revisions confirmed by the user for a force overwrite. */
  expectedProtected: jsonb("expected_protected").$type<Array<{ key: string; revision: number }>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("generation_jobs_active_reviewer_unique")
    .on(table.reviewerId)
    .where(
      sql`${table.active} = true AND ${table.status} IN ('queued', 'running')`,
    ),
]);

export const cards = pgTable(
  "cards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => reviewers.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    front: text("front").notNull(),
    back: text("back").notNull(),
    revision: integer("revision").notNull().default(1),
    isEdited: boolean("is_edited").notNull().default(false),
    isPinned: boolean("is_pinned").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull().defaultNow(),
    intervalDays: integer("interval_days").notNull().default(0),
    repetitions: integer("repetitions").notNull().default(0),
    easeFactor: integer("ease_factor").notNull().default(25),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    originGenerationRunId: uuid("origin_generation_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("cards_reviewer_id_source_key_unique").on(
      table.reviewerId,
      table.sourceKey,
    ),
    index("cards_reviewer_due_idx").on(table.reviewerId, table.dueAt),
  ],
);

/** Durable timed and untimed Test Me sitting state. */
export const testSessions = pgTable("test_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  reviewerId: uuid("reviewer_id")
    .notNull()
    .references(() => reviewers.id, { onDelete: "cascade" }),
  viewRevision: integer("view_revision").notNull(),
  mode: testSessionModeEnum("mode").notNull().default("timed"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  /** Required for timed runs; null only for untimed sittings. */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** Ordered item-id snapshot for untimed sittings; empty for timed runs. */
  itemIds: jsonb("item_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  originSessionId: uuid("origin_session_id"),
  /** Monotonic count of unique answers committed for this session. */
  answeredCount: integer("answered_count").notNull().default(0),
  status: testSessionStatusEnum("status").notNull().default("active"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  uniqueIndex("test_sessions_active_owner_mode_unique")
    .on(table.userId, table.reviewerId, table.mode)
    .where(sql`${table.status} = 'active'`),
  index("test_sessions_expiry_idx").on(table.status, table.expiresAt),
  index("test_sessions_reviewer_idx").on(table.reviewerId, table.createdAt),
  check("test_sessions_answered_count_nonnegative", sql`${table.answeredCount} >= 0`),
  check(
    "test_sessions_timed_requires_deadline",
    sql`(${table.mode} = 'timed' AND ${table.expiresAt} IS NOT NULL) OR (${table.mode} = 'untimed' AND ${table.expiresAt} IS NULL)`,
  ),
]);

export const testAttempts = pgTable("test_attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  reviewerId: uuid("reviewer_id")
    .notNull()
    .references(() => reviewers.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => testSessions.id, { onDelete: "cascade" }),
  viewRevision: integer("view_revision").notNull(),
  itemId: text("item_id").notNull(),
  selectedAnswer: text("selected_answer").notNull(),
  correct: boolean("correct").notNull(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("test_attempts_reviewer_idx").on(table.reviewerId, table.attemptedAt),
  index("test_attempts_session_idx").on(table.sessionId, table.attemptedAt),
  uniqueIndex("test_attempts_session_item_unique")
    .on(table.sessionId, table.itemId)
    .where(sql`${table.sessionId} IS NOT NULL`),
]);

export const cardReviews = pgTable("card_reviews", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  reviewerId: uuid("reviewer_id")
    .notNull()
    .references(() => reviewers.id, { onDelete: "cascade" }),
  cardId: uuid("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  rating: cardRatingEnum("rating").notNull(),
  clientRequestId: text("client_request_id"),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  intervalDays: integer("interval_days").notNull(),
  repetitions: integer("repetitions").notNull(),
  easeFactor: integer("ease_factor").notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("card_reviews_card_idx").on(table.cardId, table.reviewedAt),
  uniqueIndex("card_reviews_request_id_unique")
    .on(table.cardId, table.clientRequestId)
    .where(sql`${table.clientRequestId} IS NOT NULL`),
]);

export const usersRelations = relations(users, ({ many }) => ({
  topics: many(topics),
  generationJobs: many(generationJobs),
  testSessions: many(testSessions),
  testAttempts: many(testAttempts),
  cardReviews: many(cardReviews),
  annotations: many(annotations),
}));

export const topicsRelations = relations(topics, ({ one, many }) => ({
  user: one(users, {
    fields: [topics.userId],
    references: [users.id],
  }),
  reviewers: many(reviewers),
}));

export const reviewersRelations = relations(reviewers, ({ one, many }) => ({
  topic: one(topics, {
    fields: [reviewers.topicId],
    references: [topics.id],
  }),
  sources: many(sources),
  views: many(views),
  annotations: many(annotations),
  generationJobs: many(generationJobs),
  testSessions: many(testSessions),
  cards: many(cards),
  testAttempts: many(testAttempts),
  cardReviews: many(cardReviews),
}));

export const sourcesRelations = relations(sources, ({ one }) => ({
  reviewer: one(reviewers, {
    fields: [sources.reviewerId],
    references: [reviewers.id],
  }),
}));

export const viewsRelations = relations(views, ({ one, many }) => ({
  reviewer: one(reviewers, {
    fields: [views.reviewerId],
    references: [reviewers.id],
  }),
  annotations: many(annotations),
}));

export const annotationsRelations = relations(annotations, ({ one }) => ({
  user: one(users, {
    fields: [annotations.userId],
    references: [users.id],
  }),
  reviewer: one(reviewers, {
    fields: [annotations.reviewerId],
    references: [reviewers.id],
  }),
  view: one(views, {
    fields: [annotations.viewId],
    references: [views.id],
  }),
}));

export const cardsRelations = relations(cards, ({ one, many }) => ({
  reviewer: one(reviewers, {
    fields: [cards.reviewerId],
    references: [reviewers.id],
  }),
  reviews: many(cardReviews),
}));

export const testAttemptsRelations = relations(testAttempts, ({ one }) => ({
  user: one(users, {
    fields: [testAttempts.userId],
    references: [users.id],
  }),
  reviewer: one(reviewers, {
    fields: [testAttempts.reviewerId],
    references: [reviewers.id],
  }),
  session: one(testSessions, {
    fields: [testAttempts.sessionId],
    references: [testSessions.id],
  }),
}));

export const testSessionsRelations = relations(testSessions, ({ one, many }) => ({
  user: one(users, {
    fields: [testSessions.userId],
    references: [users.id],
  }),
  reviewer: one(reviewers, {
    fields: [testSessions.reviewerId],
    references: [reviewers.id],
  }),
  attempts: many(testAttempts),
}));

export const cardReviewsRelations = relations(cardReviews, ({ one }) => ({
  user: one(users, {
    fields: [cardReviews.userId],
    references: [users.id],
  }),
  reviewer: one(reviewers, {
    fields: [cardReviews.reviewerId],
    references: [reviewers.id],
  }),
  card: one(cards, {
    fields: [cardReviews.cardId],
    references: [cards.id],
  }),
}));

export const generationJobsRelations = relations(generationJobs, ({ one }) => ({
  user: one(users, {
    fields: [generationJobs.userId],
    references: [users.id],
  }),
  reviewer: one(reviewers, {
    fields: [generationJobs.reviewerId],
    references: [reviewers.id],
  }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type LoginThrottle = typeof loginThrottles.$inferSelect;
export type NewLoginThrottle = typeof loginThrottles.$inferInsert;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
export type Topic = typeof topics.$inferSelect;
export type NewTopic = typeof topics.$inferInsert;
export type Reviewer = typeof reviewers.$inferSelect;
export type NewReviewer = typeof reviewers.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type BlobReservation = typeof blobReservations.$inferSelect;
export type StudyView = typeof views.$inferSelect;
export type NewStudyView = typeof views.$inferInsert;
export type StudyAnnotation = typeof annotations.$inferSelect;
export type NewStudyAnnotation = typeof annotations.$inferInsert;
export type GenerationJob = typeof generationJobs.$inferSelect;
export type NewGenerationJob = typeof generationJobs.$inferInsert;
export type Card = typeof cards.$inferSelect;
export type NewCard = typeof cards.$inferInsert;
export type TestAttempt = typeof testAttempts.$inferSelect;
export type NewTestAttempt = typeof testAttempts.$inferInsert;
export type TestSession = typeof testSessions.$inferSelect;
export type NewTestSession = typeof testSessions.$inferInsert;
export type CardReview = typeof cardReviews.$inferSelect;
export type NewCardReview = typeof cardReviews.$inferInsert;
