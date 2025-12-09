CREATE TABLE "analyzed_listings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" text NOT NULL,
	"search_query_id" varchar,
	"analyzed_at" timestamp DEFAULT now() NOT NULL,
	"confidence_score" integer NOT NULL,
	"is_valuable" boolean NOT NULL,
	"lot_type" text DEFAULT 'single' NOT NULL,
	CONSTRAINT "analyzed_listings_listing_id_unique" UNIQUE("listing_id")
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" text NOT NULL,
	"listing_url" text NOT NULL,
	"listing_title" text NOT NULL,
	"price" text NOT NULL,
	"confidence_score" integer NOT NULL,
	"ai_reasoning" text NOT NULL,
	"detected_materials" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"is_valuable" boolean DEFAULT false NOT NULL,
	"lot_type" text DEFAULT 'single' NOT NULL,
	"search_query_id" varchar,
	"found_at" timestamp DEFAULT now() NOT NULL,
	"telegram_sent" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_scanned_at" timestamp,
	"scan_interval_minutes" integer DEFAULT 90 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_scans" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_url" text NOT NULL,
	"listing_title" text NOT NULL,
	"confidence_score" integer NOT NULL,
	"ai_reasoning" text NOT NULL,
	"detected_materials" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"is_valuable" boolean DEFAULT false NOT NULL,
	"lot_type" text DEFAULT 'single' NOT NULL,
	"price" text,
	"scanned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_queries" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vinted_url" text NOT NULL,
	"search_label" text NOT NULL,
	"scan_frequency_hours" integer DEFAULT 3 NOT NULL,
	"confidence_threshold" integer DEFAULT 70 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_scanned_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analyzed_listings" ADD CONSTRAINT "analyzed_listings_search_query_id_search_queries_id_fk" FOREIGN KEY ("search_query_id") REFERENCES "public"."search_queries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_search_query_id_search_queries_id_fk" FOREIGN KEY ("search_query_id") REFERENCES "public"."search_queries"("id") ON DELETE no action ON UPDATE no action;