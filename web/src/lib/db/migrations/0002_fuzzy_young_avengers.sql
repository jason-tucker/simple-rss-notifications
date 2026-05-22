CREATE TABLE IF NOT EXISTS "sinks_resend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"api_key_ciphertext" "bytea",
	"api_key_iv" "bytea",
	"api_key_tag" "bytea",
	"api_key_key_version" integer DEFAULT 1,
	"from_email" text NOT NULL,
	"from_name" text,
	"incomplete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sinks_smtp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 587 NOT NULL,
	"username" text NOT NULL,
	"password_ciphertext" "bytea",
	"password_iv" "bytea",
	"password_tag" "bytea",
	"password_key_version" integer DEFAULT 1,
	"from_email" text NOT NULL,
	"from_name" text,
	"use_tls" boolean DEFAULT true NOT NULL,
	"incomplete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sinks_resend" ADD CONSTRAINT "sinks_resend_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sinks_smtp" ADD CONSTRAINT "sinks_smtp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sinks_resend_user_idx" ON "sinks_resend" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sinks_smtp_user_idx" ON "sinks_smtp" USING btree ("user_id");