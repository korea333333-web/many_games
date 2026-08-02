CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`nickname` text NOT NULL,
	`last_seen` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_nickname_idx` ON `players` (`nickname`);
--> statement-breakpoint
CREATE INDEX `players_last_seen_idx` ON `players` (`last_seen`);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`game_id` text NOT NULL,
	`host_id` text NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`capacity` integer DEFAULT 10 NOT NULL,
	`password_hash` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rooms_updated_at_idx` ON `rooms` (`updated_at`);
--> statement-breakpoint
CREATE TABLE `room_members` (
	`room_id` text NOT NULL,
	`player_id` text NOT NULL,
	`role` text DEFAULT 'player' NOT NULL,
	`joined_at` text NOT NULL,
	PRIMARY KEY(`room_id`, `player_id`)
);
--> statement-breakpoint
CREATE INDEX `room_members_player_idx` ON `room_members` (`player_id`);
--> statement-breakpoint
CREATE TABLE `game_sessions` (
	`room_id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`state_json` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sender_id` text NOT NULL,
	`recipient_id` text,
	`scope` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_scope_created_idx` ON `messages` (`scope`, `created_at`);
--> statement-breakpoint
CREATE INDEX `messages_recipient_idx` ON `messages` (`recipient_id`, `created_at`);
