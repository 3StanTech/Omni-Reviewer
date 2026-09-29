ALTER TABLE "card_reviews" ADD COLUMN "fsrs_state" smallint;--> statement-breakpoint
ALTER TABLE "card_reviews" ADD COLUMN "stability" real;--> statement-breakpoint
ALTER TABLE "card_reviews" ADD COLUMN "difficulty" real;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "fsrs_state" smallint;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "stability" real;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "difficulty" real;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "lapses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "scheduled_days" integer;