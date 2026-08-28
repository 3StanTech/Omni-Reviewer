import { relations } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const sourceKindEnum = pgEnum("source_kind", [
  "pdf",
  "image",
  "text",
  "video",
  "audio",
]);

export const ingestStatusEnum = pgEnum("ingest_status", [
  "ready",
  "unprocessed",
  "failed",
]);

export const viewKindEnum = pgEnum("view_kind", [
  "locked_in",
  "summary",
  "test_me",
  "carded",
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

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
});

export const sources = pgTable("sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  reviewerId: uuid("reviewer_id")
    .notNull()
    .references(() => reviewers.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  kind: sourceKindEnum("kind").notNull(),
  blobUrl: text("blob_url").notNull(),
  blobPathname: text("blob_pathname").notNull(),
  ingestStatus: ingestStatusEnum("ingest_status").notNull(),
  extractedText: text("extracted_text"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique("views_reviewer_id_kind_unique").on(table.reviewerId, table.kind)],
);

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
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  modelUsed: text("model_used"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const usersRelations = relations(users, ({ many }) => ({
  topics: many(topics),
  generationJobs: many(generationJobs),
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
  generationJobs: many(generationJobs),
}));

export const sourcesRelations = relations(sources, ({ one }) => ({
  reviewer: one(reviewers, {
    fields: [sources.reviewerId],
    references: [reviewers.id],
  }),
}));

export const viewsRelations = relations(views, ({ one }) => ({
  reviewer: one(reviewers, {
    fields: [views.reviewerId],
    references: [reviewers.id],
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
export type Topic = typeof topics.$inferSelect;
export type NewTopic = typeof topics.$inferInsert;
export type Reviewer = typeof reviewers.$inferSelect;
export type NewReviewer = typeof reviewers.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type StudyView = typeof views.$inferSelect;
export type NewStudyView = typeof views.$inferInsert;
export type GenerationJob = typeof generationJobs.$inferSelect;
export type NewGenerationJob = typeof generationJobs.$inferInsert;
