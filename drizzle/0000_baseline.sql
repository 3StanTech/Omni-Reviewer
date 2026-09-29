CREATE TYPE "public"."annotation_color" AS ENUM('sun', 'sky', 'mint', 'rose');--> statement-breakpoint
CREATE TYPE "public"."annotation_view_kind" AS ENUM('locked_in', 'summary');--> statement-breakpoint
CREATE TYPE "public"."blob_reservation_state" AS ENUM('reserved', 'released', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."card_rating" AS ENUM('again', 'good');--> statement-breakpoint
CREATE TYPE "public"."generation_job_intent" AS ENUM('generate_missing', 'redo');--> statement-breakpoint
CREATE TYPE "public"."generation_job_mode" AS ENUM('full', 'single');--> statement-breakpoint
CREATE TYPE "public"."generation_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."generation_job_step" AS ENUM('locked_in', 'summary', 'test_me', 'carded');--> statement-breakpoint
CREATE TYPE "public"."ingest_status" AS ENUM('ready', 'unprocessed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('pdf', 'image', 'text', 'document', 'presentation', 'paste', 'video', 'audio');--> statement-breakpoint
CREATE TYPE "public"."test_session_mode" AS ENUM('timed', 'untimed');--> statement-breakpoint
CREATE TYPE "public"."test_session_status" AS ENUM('active', 'completed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."view_kind" AS ENUM('locked_in', 'summary', 'test_me', 'carded');--> statement-breakpoint
CREATE TABLE "study_annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"view_id" uuid NOT NULL,
	"kind" "annotation_view_kind" NOT NULL,
	"content_revision" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"quote" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"suffix" text DEFAULT '' NOT NULL,
	"color" "annotation_color" DEFAULT 'sun' NOT NULL,
	"note" text,
	"archived_at" timestamp with time zone,
	"archive_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_annotations_bounds_valid" CHECK ("study_annotations"."start_offset" >= 0 AND "study_annotations"."end_offset" > "study_annotations"."start_offset" AND length("study_annotations"."quote") > 0 AND length("study_annotations"."quote") <= 10000)
);
--> statement-breakpoint
CREATE TABLE "blob_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"pathname" text NOT NULL,
	"attempt_token" text DEFAULT 'legacy' NOT NULL,
	"state" "blob_reservation_state" DEFAULT 'reserved' NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_reservations_pathname_unique" UNIQUE("pathname")
);
--> statement-breakpoint
CREATE TABLE "card_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"rating" "card_rating" NOT NULL,
	"client_request_id" text,
	"due_at" timestamp with time zone NOT NULL,
	"interval_days" integer NOT NULL,
	"repetitions" integer NOT NULL,
	"ease_factor" integer NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"front" text NOT NULL,
	"back" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"is_edited" boolean DEFAULT false NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"interval_days" integer DEFAULT 0 NOT NULL,
	"repetitions" integer DEFAULT 0 NOT NULL,
	"ease_factor" integer DEFAULT 25 NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"origin_generation_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cards_reviewer_id_source_key_unique" UNIQUE("reviewer_id","source_key")
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"status" "generation_job_status" NOT NULL,
	"step" "generation_job_step",
	"mode" "generation_job_mode" DEFAULT 'full' NOT NULL,
	"intent" "generation_job_intent" DEFAULT 'redo' NOT NULL,
	"target_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completed_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"upstream_revisions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generation_run_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"claim_token" text,
	"claim_expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"model_used" text,
	"force_overwrite" boolean DEFAULT false NOT NULL,
	"expected_protected" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "login_throttles" (
	"email" text PRIMARY KEY NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_generated_at" timestamp with time zone,
	"exam_date" date,
	"deleting_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"blob_url" text,
	"blob_pathname" text,
	"ingest_status" "ingest_status" NOT NULL,
	"extracted_text" text,
	"error_message" text,
	"deleting_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"session_id" uuid,
	"view_revision" integer NOT NULL,
	"item_id" text NOT NULL,
	"selected_answer" text NOT NULL,
	"correct" boolean NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"view_revision" integer NOT NULL,
	"mode" "test_session_mode" DEFAULT 'timed' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin_session_id" uuid,
	"answered_count" integer DEFAULT 0 NOT NULL,
	"status" "test_session_status" DEFAULT 'active' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_sessions_answered_count_nonnegative" CHECK ("test_sessions"."answered_count" >= 0),
	CONSTRAINT "test_sessions_timed_requires_deadline" CHECK (("test_sessions"."mode" = 'timed' AND "test_sessions"."expires_at" IS NOT NULL) OR ("test_sessions"."mode" = 'untimed' AND "test_sessions"."expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleting_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"kind" "view_kind" NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_json" jsonb,
	"model_id" text,
	"generation_run_id" uuid,
	"content_revision" integer DEFAULT 1 NOT NULL,
	"annotation_revision" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"is_edited" boolean DEFAULT false NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "views_reviewer_id_kind_unique" UNIQUE("reviewer_id","kind")
);
--> statement-breakpoint
ALTER TABLE "study_annotations" ADD CONSTRAINT "study_annotations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_annotations" ADD CONSTRAINT "study_annotations_reviewer_id_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_annotations" ADD CONSTRAINT "study_annotations_view_id_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_reservations" ADD CONSTRAINT "blob_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_reservations" ADD CONSTRAINT "blob_reservations_reviewer_id_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_reviews" ADD CONSTRAINT "card_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_reviews" ADD CONSTRAINT "card_reviews_reviewer_id_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_reviews" ADD CONSTRAINT "card_reviews_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_reviewer_id_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_reviewer_id_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewers" ADD CONSTRAINT "reviewers_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_reviewer_id_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_reviewer_id_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_session_id_test_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."test_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_sessions" ADD CONSTRAINT "test_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_sessions" ADD CONSTRAINT "test_sessions_reviewer_id_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_reviewer_id_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "study_annotations_view_active_idx" ON "study_annotations" USING btree ("view_id","archived_at");--> statement-breakpoint
CREATE INDEX "study_annotations_reviewer_idx" ON "study_annotations" USING btree ("reviewer_id","created_at");--> statement-breakpoint
CREATE INDEX "blob_reservations_owner_state_idx" ON "blob_reservations" USING btree ("user_id","reviewer_id","state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "card_reviews_card_idx" ON "card_reviews" USING btree ("card_id","reviewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "card_reviews_request_id_unique" ON "card_reviews" USING btree ("card_id","client_request_id") WHERE "card_reviews"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "cards_reviewer_due_idx" ON "cards" USING btree ("reviewer_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_jobs_active_reviewer_unique" ON "generation_jobs" USING btree ("reviewer_id") WHERE "generation_jobs"."active" = true AND "generation_jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_unique" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_blob_pathname_unique" ON "sources" USING btree ("blob_pathname") WHERE "sources"."blob_pathname" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "test_attempts_reviewer_idx" ON "test_attempts" USING btree ("reviewer_id","attempted_at");--> statement-breakpoint
CREATE INDEX "test_attempts_session_idx" ON "test_attempts" USING btree ("session_id","attempted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "test_attempts_session_item_unique" ON "test_attempts" USING btree ("session_id","item_id") WHERE "test_attempts"."session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "test_sessions_active_owner_mode_unique" ON "test_sessions" USING btree ("user_id","reviewer_id","mode") WHERE "test_sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "test_sessions_expiry_idx" ON "test_sessions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "test_sessions_reviewer_idx" ON "test_sessions" USING btree ("reviewer_id","created_at");