CREATE TYPE "public"."chat_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TABLE "pack_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"role" "chat_role" NOT NULL,
	"content" text NOT NULL,
	"content_json" jsonb,
	"model_id" text,
	"reply_to_id" uuid,
	"origin_key" text,
	"saved_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pack_chat_messages_content_length" CHECK (char_length("pack_chat_messages"."content") <= 20000)
);
--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', front || ' ' || back)) STORED;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', left(coalesce(extracted_text, ''), 150000))) STORED;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', left(content, 150000))) STORED;--> statement-breakpoint
ALTER TABLE "pack_chat_messages" ADD CONSTRAINT "pack_chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_chat_messages" ADD CONSTRAINT "pack_chat_messages_reviewer_id_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_chat_messages" ADD CONSTRAINT "pack_chat_messages_reply_to_id_pack_chat_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."pack_chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pack_chat_messages_reviewer_created_idx" ON "pack_chat_messages" USING btree ("reviewer_id","created_at");--> statement-breakpoint
CREATE INDEX "pack_chat_messages_reviewer_origin_idx" ON "pack_chat_messages" USING btree ("reviewer_id","origin_key") WHERE "pack_chat_messages"."origin_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pack_chat_messages_reviewer_saved_idx" ON "pack_chat_messages" USING btree ("reviewer_id","saved_at") WHERE "pack_chat_messages"."saved_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "cards_search_tsv_idx" ON "cards" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "sources_search_tsv_idx" ON "sources" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "views_search_tsv_idx" ON "views" USING gin ("search_tsv");