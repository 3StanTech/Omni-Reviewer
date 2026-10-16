CREATE TABLE "free_request_days" (
	"day" date PRIMARY KEY NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"exhausted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
