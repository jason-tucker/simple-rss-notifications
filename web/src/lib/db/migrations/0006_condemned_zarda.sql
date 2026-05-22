CREATE TABLE IF NOT EXISTS "sinks_ntfy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"server_url" text DEFAULT 'https://ntfy.sh' NOT NULL,
	"topic" text NOT NULL,
	"token_ciphertext" "bytea",
	"token_iv" "bytea",
	"token_tag" "bytea",
	"token_key_version" integer DEFAULT 1,
	"default_priority" integer DEFAULT 3 NOT NULL,
	"default_tags" text,
	"include_link" boolean DEFAULT true NOT NULL,
	"incomplete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routes" ALTER COLUMN "destination" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sinks_ntfy" ADD CONSTRAINT "sinks_ntfy_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sinks_ntfy_user_idx" ON "sinks_ntfy" USING btree ("user_id");