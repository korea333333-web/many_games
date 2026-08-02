import { env } from "cloudflare:workers";
import { GAME_BY_ID, GAME_CATALOG, type GameId } from "../games/catalog.ts";
import { advanceTimedGame, createGame, projectGame, reduceGame, removePlayerFromGame, type GameCommand, type GameEnvelope, type GameOptions } from "../games/engine.ts";
import { isKnownWord } from "./word-dictionary.ts";

let schemaReady = false;
let lastMembershipCleanupAt = 0;

type JsonRecord = Record<string, unknown>;
type RoomListRow = JsonRecord & { settingsJson?: unknown; locked?: unknown; memberCount?: unknown; playerCount?: unknown };
type RoomSnapshotRow = JsonRecord & { settingsJson?: unknown; locked?: unknown; status: string };
type SessionRow = { stateJson: string; revision: number };

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS players_nickname_idx ON players(nickname)`,
  `CREATE INDEX IF NOT EXISTS players_last_seen_idx ON players(last_seen)`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    game_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting',
    capacity INTEGER NOT NULL DEFAULT 10,
    password_hash TEXT,
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS rooms_updated_at_idx ON rooms(updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'player',
    joined_at TEXT NOT NULL,
    PRIMARY KEY (room_id, player_id)
  )`,
  `CREATE INDEX IF NOT EXISTS room_members_player_idx ON room_members(player_id)`,
  `CREATE TABLE IF NOT EXISTS game_sessions (
    room_id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    state_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL,
    recipient_id TEXT,
    scope TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS messages_scope_created_idx ON messages(scope, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages(recipient_id, created_at DESC)`,
];

function getD1(): D1Database {
  if (!env.DB) throw new Error("온라인 저장소가 준비되지 않았습니다.");
  return env.DB;
}

async function ensureSchema() {
  if (schemaReady) return getD1();
  const db = getD1();
  for (const statement of TABLE_STATEMENTS) await db.prepare(statement).run();
  const roomColumns = (await db.prepare("PRAGMA table_info(rooms)").all()).results as Array<{ name: string }>;
  if (!roomColumns.some((column) => column.name === "settings_json")) {
    await db.prepare("ALTER TABLE rooms ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'").run();
  }
  schemaReady = true;
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

const FINISHED_RETURN_DELAY_MS = 3_600;

async function cleanupFinishedGames(db: D1Database) {
  const cutoff = new Date(Date.now() - FINISHED_RETURN_DELAY_MS).toISOString();
  const candidates = (await db.prepare(`SELECT room_id AS roomId, state_json AS stateJson
    FROM game_sessions WHERE updated_at <= ?`).bind(cutoff).all()).results as Array<{ roomId: string; stateJson: string }>;
  for (const candidate of candidates) {
    try {
      const game = JSON.parse(candidate.stateJson) as GameEnvelope;
      if (game.phase !== "finished") continue;
      const now = nowIso();
      await db.batch([
        db.prepare("DELETE FROM game_sessions WHERE room_id = ?").bind(candidate.roomId),
        db.prepare("UPDATE rooms SET status = 'waiting', updated_at = ? WHERE id = ?").bind(now, candidate.roomId),
      ]);
      const room = await db.prepare("SELECT game_id AS gameId FROM rooms WHERE id = ?").bind(candidate.roomId).first<{ gameId: GameId }>();
      if (room) await rebalanceRoomSeats(db, candidate.roomId, room.gameId);
    } catch {
      // A malformed session is left untouched for diagnosis instead of deleting user data.
    }
  }
}

async function rebalanceRoomSeats(db: D1Database, roomId: string, gameId: GameId) {
  const members = (await db.prepare("SELECT player_id AS id FROM room_members WHERE room_id = ? ORDER BY joined_at")
    .bind(roomId).all()).results as Array<{ id: string }>;
  const maxPlayers = GAME_BY_ID[gameId].maxPlayers;
  const updates = members.map((member, index) => db.prepare("UPDATE room_members SET role = ? WHERE room_id = ? AND player_id = ?")
    .bind(index < maxPlayers ? "player" : "spectator", roomId, member.id));
  if (updates.length) await db.batch(updates);
}

async function removeMemberFromRoom(db: D1Database, playerId: string, roomId: string) {
  const room = await db.prepare("SELECT host_id AS hostId, status, game_id AS gameId FROM rooms WHERE id = ?")
    .bind(roomId).first<{ hostId: string; status: string; gameId: GameId }>();
  if (!room) return { interrupted: false };
  const membership = await db.prepare("SELECT role FROM room_members WHERE room_id = ? AND player_id = ?")
    .bind(roomId, playerId).first<{ role: string }>();
  if (!membership) return { interrupted: false };

  await db.prepare("DELETE FROM room_members WHERE room_id = ? AND player_id = ?").bind(roomId, playerId).run();
  const members = (await db.prepare("SELECT player_id AS id, role FROM room_members WHERE room_id = ? ORDER BY joined_at")
    .bind(roomId).all()).results as Array<{ id: string; role: string }>;
  if (!members.length) {
    await db.batch([
      db.prepare("DELETE FROM game_sessions WHERE room_id = ?").bind(roomId),
      db.prepare("DELETE FROM rooms WHERE id = ?").bind(roomId),
    ]);
    return { interrupted: room.status === "playing" };
  }

  if (room.hostId === playerId) {
    await db.prepare("UPDATE rooms SET host_id = ?, updated_at = ? WHERE id = ?").bind(members[0].id, nowIso(), roomId).run();
  }

  let interrupted = false;
  if (room.status === "playing" && membership.role === "player") {
    const playerCount = members.filter((member) => member.role === "player").length;
    const session = await db.prepare("SELECT state_json AS stateJson, revision FROM game_sessions WHERE room_id = ?")
      .bind(roomId).first<{ stateJson: string; revision: number }>();
    if (!session || playerCount < GAME_BY_ID[room.gameId].minPlayers) {
      interrupted = true;
      await db.batch([
        db.prepare("DELETE FROM game_sessions WHERE room_id = ?").bind(roomId),
        db.prepare("UPDATE rooms SET status = 'waiting', updated_at = ? WHERE id = ?").bind(nowIso(), roomId),
      ]);
      await rebalanceRoomSeats(db, roomId, room.gameId);
    } else {
      const nextGame = removePlayerFromGame(JSON.parse(session.stateJson), playerId);
      await db.prepare("UPDATE game_sessions SET state_json = ?, revision = revision + 1, updated_at = ? WHERE room_id = ? AND revision = ?")
        .bind(JSON.stringify(nextGame), nowIso(), roomId, session.revision).run();
    }
  } else if (room.status === "waiting") {
    await rebalanceRoomSeats(db, roomId, room.gameId);
  }
  return { interrupted };
}

async function leaveOtherRooms(db: D1Database, playerId: string, keepRoomId?: string) {
  const memberships = (await db.prepare("SELECT room_id AS roomId FROM room_members WHERE player_id = ? ORDER BY joined_at DESC")
    .bind(playerId).all()).results as Array<{ roomId: string }>;
  for (const membership of memberships) if (membership.roomId !== keepRoomId) await removeMemberFromRoom(db, playerId, membership.roomId);
}

async function cleanupStaleMemberships(db: D1Database) {
  const stale = (await db.prepare(`SELECT rm.room_id AS roomId, rm.player_id AS playerId
    FROM room_members rm JOIN players p ON p.id = rm.player_id
    WHERE datetime(p.last_seen) < datetime('now', '-2 minutes') LIMIT 100`).all()).results as Array<{ roomId: string; playerId: string }>;
  for (const member of stale) await removeMemberFromRoom(db, member.playerId, member.roomId);
}

async function cleanupDuplicateMemberships(db: D1Database) {
  const memberships = (await db.prepare(`SELECT player_id AS playerId, room_id AS roomId
    FROM room_members ORDER BY player_id, datetime(joined_at) DESC, rowid DESC`).all()).results as Array<{ playerId: string; roomId: string }>;
  const newestRoomByPlayer = new Map<string, string>();
  for (const membership of memberships) {
    if (!newestRoomByPlayer.has(membership.playerId)) {
      newestRoomByPlayer.set(membership.playerId, membership.roomId);
      continue;
    }
    await removeMemberFromRoom(db, membership.playerId, membership.roomId);
  }
}

async function cleanupInvalidGames(db: D1Database) {
  const playingRooms = (await db.prepare(`SELECT r.id, r.game_id AS gameId,
      SUM(CASE WHEN rm.role = 'player' THEN 1 ELSE 0 END) AS playerCount,
      COUNT(gs.room_id) AS sessionCount
    FROM rooms r
    LEFT JOIN room_members rm ON rm.room_id = r.id
    LEFT JOIN game_sessions gs ON gs.room_id = r.id
    WHERE r.status = 'playing'
    GROUP BY r.id, r.game_id`).all()).results as Array<{ id: string; gameId: GameId; playerCount: number; sessionCount: number }>;
  for (const room of playingRooms) {
    if (Number(room.playerCount) >= GAME_BY_ID[room.gameId].minPlayers && Number(room.sessionCount) > 0) continue;
    await db.batch([
      db.prepare("DELETE FROM game_sessions WHERE room_id = ?").bind(room.id),
      db.prepare("UPDATE rooms SET status = 'waiting', updated_at = ? WHERE id = ?").bind(nowIso(), room.id),
    ]);
    await rebalanceRoomSeats(db, room.id, room.gameId);
  }
}

async function runRoomMaintenance(db: D1Database) {
  if (Date.now() - lastMembershipCleanupAt < 15_000) return;
  lastMembershipCleanupAt = Date.now();
  await cleanupStaleMemberships(db);
  await cleanupDuplicateMemberships(db);
  await cleanupInvalidGames(db);
}

function cleanText(value: unknown, max: number) {
  return String(value ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanId(value: unknown) {
  const id = String(value ?? "");
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(id)) throw new Error("잘못된 사용자 정보입니다.");
  return id;
}

const ROUND_GAMES = new Set<GameId>(["drawing", "chosung"]);
const ALLOWED_ROUND_COUNTS = new Set([3, 5, 7, 10]);

function parseSettings(value: unknown): GameOptions {
  try {
    const raw = typeof value === "string" ? JSON.parse(value) : value;
    const rounds = Number((raw as { rounds?: unknown } | null)?.rounds);
    return ALLOWED_ROUND_COUNTS.has(rounds) ? { rounds } : {};
  } catch {
    return {};
  }
}

function sanitizeSettings(gameId: GameId, value: unknown): GameOptions {
  if (!ROUND_GAMES.has(gameId)) return {};
  const parsed = parseSettings(value);
  return { rounds: parsed.rounds ?? 5 };
}

async function hashText(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function touchPlayer(playerIdRaw: unknown, nicknameRaw: unknown) {
  const db = await ensureSchema();
  const id = cleanId(playerIdRaw);
  const requested = cleanText(nicknameRaw, 14) || `손님${id.slice(-4)}`;
  const now = nowIso();
  const existing = await db.prepare("SELECT nickname FROM players WHERE id = ?").bind(id).first<{ nickname: string }>();
  let nickname = existing?.nickname ?? requested;
  if (!existing || existing.nickname !== requested) {
    const duplicate = await db.prepare("SELECT id FROM players WHERE nickname = ? AND id <> ?").bind(requested, id).first();
    nickname = duplicate ? `${requested.slice(0, 10)}${id.slice(-3)}` : requested;
  }
  await db.prepare(`INSERT INTO players(id, nickname, last_seen, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET nickname = excluded.nickname, last_seen = excluded.last_seen`)
    .bind(id, nickname, now, now).run();
  return { id, nickname };
}

export async function getSnapshot(playerIdRaw: unknown, roomIdRaw?: unknown) {
  const db = await ensureSchema();
  await runRoomMaintenance(db);
  await cleanupFinishedGames(db);
  const playerId = playerIdRaw ? cleanId(playerIdRaw) : null;
  const roomId = cleanText(roomIdRaw, 80);
  const [roomsResult, playersResult, globalResult] = await Promise.all([
    db.prepare(`SELECT r.id, r.title, r.game_id AS gameId, r.host_id AS hostId, p.nickname AS hostName,
      r.status, r.capacity, CASE WHEN r.password_hash IS NULL THEN 0 ELSE 1 END AS locked,
      r.settings_json AS settingsJson,
      COUNT(rm.player_id) AS memberCount,
      SUM(CASE WHEN rm.role = 'player' THEN 1 ELSE 0 END) AS playerCount
      FROM rooms r
      JOIN players p ON p.id = r.host_id
      LEFT JOIN room_members rm ON rm.room_id = r.id
      GROUP BY r.id
      ORDER BY CASE WHEN r.status = 'waiting' THEN 0 ELSE 1 END, r.updated_at DESC
      LIMIT 60`).all(),
    db.prepare(`SELECT id, nickname, last_seen AS lastSeen FROM players
      WHERE datetime(last_seen) >= datetime('now', '-2 minutes')
      ORDER BY nickname LIMIT 100`).all(),
    db.prepare(`SELECT m.id, m.sender_id AS senderId, p.nickname AS senderName, m.body, m.created_at AS createdAt
      FROM messages m JOIN players p ON p.id = m.sender_id
      WHERE m.scope = 'global' ORDER BY m.id DESC LIMIT 50`).all(),
  ]);

  let directMessages: unknown[] = [];
  if (playerId) {
    directMessages = (await db.prepare(`SELECT m.id, m.sender_id AS senderId, sp.nickname AS senderName,
      m.recipient_id AS recipientId, rp.nickname AS recipientName, m.body, m.created_at AS createdAt
      FROM messages m
      JOIN players sp ON sp.id = m.sender_id
      LEFT JOIN players rp ON rp.id = m.recipient_id
      WHERE m.scope = 'direct' AND (m.sender_id = ? OR m.recipient_id = ?)
      ORDER BY m.id DESC LIMIT 100`).bind(playerId, playerId).all()).results;
  }

  let activeRoom = null;
  if (roomId && playerId) activeRoom = await getRoomSnapshot(db, roomId, playerId);

  return {
    rooms: (roomsResult.results as RoomListRow[]).map((room) => ({ ...room, settings: parseSettings(room.settingsJson), locked: Boolean(room.locked), memberCount: Number(room.memberCount), playerCount: Number(room.playerCount) })),
    onlinePlayers: playersResult.results,
    globalMessages: [...globalResult.results].reverse(),
    directMessages: [...directMessages].reverse(),
    activeRoom,
    games: GAME_CATALOG,
    serverTime: nowIso(),
  };
}

async function getRoomSnapshot(db: D1Database, roomId: string, viewerId: string) {
  const room = await db.prepare(`SELECT r.id, r.title, r.game_id AS gameId, r.host_id AS hostId,
    r.status, r.capacity, r.settings_json AS settingsJson, CASE WHEN r.password_hash IS NULL THEN 0 ELSE 1 END AS locked
    FROM rooms r WHERE r.id = ?`).bind(roomId).first<RoomSnapshotRow>();
  if (!room) return null;
  const members = (await db.prepare(`SELECT rm.player_id AS id, p.nickname AS name, rm.role, rm.joined_at AS joinedAt
    FROM room_members rm JOIN players p ON p.id = rm.player_id
    WHERE rm.room_id = ? ORDER BY rm.role DESC, rm.joined_at`).bind(roomId).all()).results as Array<{ id: string; name: string; role: string; joinedAt: string }>;
  const membership = members.find((member) => member.id === viewerId);
  if (!membership) return null;
  const session = await db.prepare("SELECT state_json AS stateJson, revision FROM game_sessions WHERE room_id = ?").bind(roomId).first<SessionRow>();
  let game: GameEnvelope | null = null;
  let revision = Number(session?.revision ?? 0);
  if (session) {
    const storedGame = JSON.parse(session.stateJson) as GameEnvelope;
    const advancedGame = advanceTimedGame(storedGame, Date.now());
    const advancedJson = JSON.stringify(advancedGame);
    if (advancedJson !== session.stateJson) {
      const update = await db.prepare(`UPDATE game_sessions SET state_json = ?, revision = revision + 1, updated_at = ?
        WHERE room_id = ? AND revision = ?`).bind(advancedJson, nowIso(), roomId, revision).run();
      if (update.meta.changes) revision += 1;
    }
    game = projectGame(advancedGame, viewerId);
  }
  return { ...room, settings: parseSettings(room.settingsJson), locked: Boolean(room.locked), members, viewerRole: membership.role, game, revision };
}

export async function executeCommand(body: JsonRecord) {
  const actor = await touchPlayer(body.playerId, body.nickname);
  const db = await ensureSchema();
  const type = String(body.type ?? "heartbeat");
  const payload = asRecord(body.payload);

  if (type === "heartbeat" || type === "setNickname") return { ok: true, player: actor };
  if (type === "createRoom") return createRoom(db, actor.id, payload);
  if (type === "joinRoom") return joinRoom(db, actor.id, payload);
  if (type === "leaveRoom") return leaveRoom(db, actor.id, payload);
  if (type === "startGame") return startGame(db, actor.id, payload);
  if (type === "gameAction") return applyGameAction(db, actor.id, payload);
  if (type === "sendGlobal") return sendMessage(db, actor.id, null, "global", payload.body);
  if (type === "sendDirect") return sendMessage(db, actor.id, cleanId(payload.recipientId), "direct", payload.body);
  throw new Error("지원하지 않는 요청입니다.");
}

async function createRoom(db: D1Database, hostId: string, payload: JsonRecord) {
  const gameId = String(payload.gameId ?? "") as GameId;
  const game = GAME_BY_ID[gameId];
  if (!game) throw new Error("게임을 선택하세요.");
  const id = crypto.randomUUID().replaceAll("-", "");
  const title = cleanText(payload.title, 30) || `${game.name} 같이 해요`;
  const password = cleanText(payload.password, 40);
  const passwordHash = password ? await hashText(password) : null;
  const settings = sanitizeSettings(gameId, payload.settings);
  const now = nowIso();
  await leaveOtherRooms(db, hostId);
  await db.batch([
    db.prepare(`INSERT INTO rooms(id, title, game_id, host_id, status, capacity, password_hash, settings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'waiting', 10, ?, ?, ?, ?)`).bind(id, title, gameId, hostId, passwordHash, JSON.stringify(settings), now, now),
    db.prepare(`INSERT INTO room_members(room_id, player_id, role, joined_at) VALUES (?, ?, 'player', ?)`)
      .bind(id, hostId, now),
  ]);
  return { ok: true, roomId: id };
}

async function joinRoom(db: D1Database, playerId: string, payload: JsonRecord) {
  const roomId = cleanText(payload.roomId, 80);
  const room = await db.prepare("SELECT * FROM rooms WHERE id = ?").bind(roomId).first<{ password_hash: string | null; game_id: GameId; status: string }>();
  if (!room) throw new Error("방을 찾을 수 없습니다.");
  const existing = await db.prepare("SELECT role FROM room_members WHERE room_id = ? AND player_id = ?").bind(roomId, playerId).first<{ role: string }>();
  const count = await db.prepare("SELECT COUNT(*) AS count FROM room_members WHERE room_id = ?").bind(roomId).first<{ count: number }>();
  if (!existing && Number(count?.count ?? 0) >= 10) throw new Error("방이 가득 찼습니다.");
  if (room.password_hash) {
    const supplied = await hashText(cleanText(payload.password, 40));
    if (supplied !== room.password_hash) throw new Error("비밀번호가 맞지 않습니다.");
  }
  await leaveOtherRooms(db, playerId, roomId);
  if (existing) return { ok: true, roomId, role: existing.role };
  const game = GAME_BY_ID[room.game_id as GameId];
  const playerCount = await db.prepare("SELECT COUNT(*) AS count FROM room_members WHERE room_id = ? AND role = 'player'").bind(roomId).first<{ count: number }>();
  const role = room.status === "waiting" && Number(playerCount?.count ?? 0) < game.maxPlayers ? "player" : "spectator";
  await db.prepare(`INSERT INTO room_members(room_id, player_id, role, joined_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id, player_id) DO UPDATE SET role = excluded.role`)
    .bind(roomId, playerId, role, nowIso()).run();
  return { ok: true, roomId, role };
}

async function leaveRoom(db: D1Database, playerId: string, payload: JsonRecord) {
  const roomId = cleanText(payload.roomId, 80);
  const result = await removeMemberFromRoom(db, playerId, roomId);
  return { ok: true, ...result };
}

async function startGame(db: D1Database, playerId: string, payload: JsonRecord) {
  const roomId = cleanText(payload.roomId, 80);
  const room = await db.prepare("SELECT game_id AS gameId, host_id AS hostId, settings_json AS settingsJson FROM rooms WHERE id = ?").bind(roomId).first<{ gameId: GameId; hostId: string; settingsJson: string }>();
  if (!room || room.hostId !== playerId) throw new Error("방장만 시작할 수 있습니다.");
  const members = (await db.prepare(`SELECT rm.player_id AS id, p.nickname AS name FROM room_members rm
    JOIN players p ON p.id = rm.player_id WHERE rm.room_id = ? AND rm.role = 'player' ORDER BY rm.joined_at`)
    .bind(roomId).all()).results as Array<{ id: string; name: string }>;
  const info = GAME_BY_ID[room.gameId as GameId];
  if (members.length < info.minPlayers) throw new Error(`최소 ${info.minPlayers}명이 필요합니다.`);
  const game = createGame(room.gameId, members.slice(0, info.maxPlayers), Date.now(), sanitizeSettings(room.gameId, room.settingsJson));
  const now = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO game_sessions(room_id, game_id, state_json, revision, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(room_id) DO UPDATE SET game_id = excluded.game_id, state_json = excluded.state_json,
        revision = game_sessions.revision + 1, updated_at = excluded.updated_at`)
      .bind(roomId, room.gameId, JSON.stringify(game), now),
    db.prepare("UPDATE rooms SET status = 'playing', updated_at = ? WHERE id = ?").bind(now, roomId),
  ]);
  return { ok: true };
}

async function applyGameAction(db: D1Database, playerId: string, payload: JsonRecord) {
  const roomId = cleanText(payload.roomId, 80);
  const membership = await db.prepare("SELECT role FROM room_members WHERE room_id = ? AND player_id = ?")
    .bind(roomId, playerId).first<{ role: string }>();
  if (membership?.role !== "player") throw new Error("참가자만 행동할 수 있습니다.");
  const session = await db.prepare("SELECT state_json AS stateJson, revision FROM game_sessions WHERE room_id = ?").bind(roomId).first<SessionRow>();
  if (!session) throw new Error("아직 게임이 시작되지 않았습니다.");
  const rawCommand = asRecord(payload.command);
  if (!cleanText(rawCommand.type, 40)) {
    throw new Error("잘못된 게임 행동입니다.");
  }
  const currentGame = JSON.parse(session.stateJson) as GameEnvelope;
  const command = { ...rawCommand, payload: { ...asRecord(rawCommand.payload) }, playerId, now: Date.now() } as GameCommand;
  if (currentGame.gameId === "word-chain" && command.type === "SUBMIT_WORD") {
    command.payload!.dictionaryValid = await isKnownWord(command.payload?.word);
  }
  const next = reduceGame(currentGame, command);
  const result = await db.prepare(`UPDATE game_sessions SET state_json = ?, revision = revision + 1, updated_at = ?
    WHERE room_id = ? AND revision = ?`).bind(JSON.stringify(next), nowIso(), roomId, session.revision).run();
  if (!result.meta.changes) throw new Error("동시에 행동이 들어왔습니다. 다시 시도하세요.");
  return { ok: true, message: next.message };
}

async function sendMessage(db: D1Database, senderId: string, recipientId: string | null, scope: string, rawBody: unknown) {
  const body = cleanText(rawBody, 200);
  if (!body) throw new Error("메시지를 입력하세요.");
  if (recipientId) {
    const target = await db.prepare("SELECT id FROM players WHERE id = ?").bind(recipientId).first();
    if (!target) throw new Error("사용자를 찾을 수 없습니다.");
  }
  await db.prepare("INSERT INTO messages(sender_id, recipient_id, scope, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(senderId, recipientId, scope, body, nowIso()).run();
  return { ok: true };
}
