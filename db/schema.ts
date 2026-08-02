import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const players = sqliteTable(
  "players",
  {
    id: text("id").primaryKey(),
    nickname: text("nickname").notNull(),
    lastSeen: text("last_seen").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("players_nickname_idx").on(table.nickname), index("players_last_seen_idx").on(table.lastSeen)],
);

export const rooms = sqliteTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    gameId: text("game_id").notNull(),
    hostId: text("host_id").notNull(),
    status: text("status").notNull().default("waiting"),
    capacity: integer("capacity").notNull().default(10),
    passwordHash: text("password_hash"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("rooms_updated_at_idx").on(table.updatedAt)],
);

export const roomMembers = sqliteTable(
  "room_members",
  {
    roomId: text("room_id").notNull(),
    playerId: text("player_id").notNull(),
    role: text("role").notNull().default("player"),
    joinedAt: text("joined_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.roomId, table.playerId] }), index("room_members_player_idx").on(table.playerId)],
);

export const gameSessions = sqliteTable("game_sessions", {
  roomId: text("room_id").primaryKey(),
  gameId: text("game_id").notNull(),
  stateJson: text("state_json").notNull(),
  revision: integer("revision").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    senderId: text("sender_id").notNull(),
    recipientId: text("recipient_id"),
    scope: text("scope").notNull(),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("messages_scope_created_idx").on(table.scope, table.createdAt), index("messages_recipient_idx").on(table.recipientId)],
);
