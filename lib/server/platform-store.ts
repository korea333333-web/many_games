import { env } from "cloudflare:workers";
import { GAME_BY_ID, GAME_CATALOG, type GameId } from "../games/catalog.ts";
import { createGame, projectGame, reduceGame, type GameCommand, type GameEnvelope } from "../games/engine.ts";

let schemaReady = false;

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
  schemaReady = true;
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value: unknown, max: number) {
  return String(value ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanId(value: unknown) {
  const id = String(value ?? "");
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(id)) throw new Error("잘못된 사용자 정보입니다.");
  return id;
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
  const playerId = playerIdRaw ? cleanId(playerIdRaw) : null;
  const roomId = cleanText(roomIdRaw, 80);
  const [roomsResult, playersResult, globalResult] = await Promise.all([
    db.prepare(`SELECT r.id, r.title, r.game_id AS gameId, r.host_id AS hostId, p.nickname AS hostName,
      r.status, r.capacity, CASE WHEN r.password_hash IS NULL THEN 0 ELSE 1 END AS locked,
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
    rooms: roomsResult.results.map((room: any) => ({ ...room, locked: Boolean(room.locked), memberCount: Number(room.memberCount), playerCount: Number(room.playerCount) })),
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
    r.status, r.capacity, CASE WHEN r.password_hash IS NULL THEN 0 ELSE 1 END AS locked
    FROM rooms r WHERE r.id = ?`).bind(roomId).first<any>();
  if (!room) return null;
  const members = (await db.prepare(`SELECT rm.player_id AS id, p.nickname AS name, rm.role, rm.joined_at AS joinedAt
    FROM room_members rm JOIN players p ON p.id = rm.player_id
    WHERE rm.room_id = ? ORDER BY rm.role DESC, rm.joined_at`).bind(roomId).all()).results;
  const membership = members.find((member: any) => member.id === viewerId);
  if (!membership) return null;
  const session = await db.prepare("SELECT state_json AS stateJson, revision FROM game_sessions WHERE room_id = ?").bind(roomId).first<any>();
  let game: GameEnvelope | null = null;
  if (session) game = projectGame(JSON.parse(session.stateJson), viewerId);
  return { ...room, locked: Boolean(room.locked), members, viewerRole: membership.role, game, revision: session?.revision ?? 0 };
}

export async function executeCommand(body: Record<string, any>) {
  const actor = await touchPlayer(body.playerId, body.nickname);
  const db = await ensureSchema();
  const type = String(body.type ?? "heartbeat");
  const payload = body.payload ?? {};

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

async function createRoom(db: D1Database, hostId: string, payload: Record<string, any>) {
  const gameId = String(payload.gameId ?? "") as GameId;
  const game = GAME_BY_ID[gameId];
  if (!game) throw new Error("게임을 선택하세요.");
  const id = crypto.randomUUID().replaceAll("-", "");
  const title = cleanText(payload.title, 30) || `${game.name} 같이 해요`;
  const password = cleanText(payload.password, 40);
  const passwordHash = password ? await hashText(password) : null;
  const now = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO rooms(id, title, game_id, host_id, status, capacity, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'waiting', 10, ?, ?, ?)`).bind(id, title, gameId, hostId, passwordHash, now, now),
    db.prepare(`INSERT INTO room_members(room_id, player_id, role, joined_at) VALUES (?, ?, 'player', ?)`)
      .bind(id, hostId, now),
  ]);
  return { ok: true, roomId: id };
}

async function joinRoom(db: D1Database, playerId: string, payload: Record<string, any>) {
  const roomId = cleanText(payload.roomId, 80);
  const room = await db.prepare("SELECT * FROM rooms WHERE id = ?").bind(roomId).first<any>();
  if (!room) throw new Error("방을 찾을 수 없습니다.");
  const count = await db.prepare("SELECT COUNT(*) AS count FROM room_members WHERE room_id = ?").bind(roomId).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= 10) throw new Error("방이 가득 찼습니다.");
  if (room.password_hash) {
    const supplied = await hashText(cleanText(payload.password, 40));
    if (supplied !== room.password_hash) throw new Error("비밀번호가 맞지 않습니다.");
  }
  const game = GAME_BY_ID[room.game_id as GameId];
  const playerCount = await db.prepare("SELECT COUNT(*) AS count FROM room_members WHERE room_id = ? AND role = 'player'").bind(roomId).first<{ count: number }>();
  const role = room.status === "waiting" && Number(playerCount?.count ?? 0) < game.maxPlayers ? "player" : "spectator";
  await db.prepare(`INSERT INTO room_members(room_id, player_id, role, joined_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id, player_id) DO UPDATE SET role = excluded.role`)
    .bind(roomId, playerId, role, nowIso()).run();
  return { ok: true, roomId, role };
}

async function leaveRoom(db: D1Database, playerId: string, payload: Record<string, any>) {
  const roomId = cleanText(payload.roomId, 80);
  const room = await db.prepare("SELECT host_id AS hostId, status FROM rooms WHERE id = ?").bind(roomId).first<any>();
  const membership = await db.prepare("SELECT role FROM room_members WHERE room_id = ? AND player_id = ?")
    .bind(roomId, playerId).first<{ role: string }>();
  await db.prepare("DELETE FROM room_members WHERE room_id = ? AND player_id = ?").bind(roomId, playerId).run();
  const next = await db.prepare("SELECT player_id AS playerId FROM room_members WHERE room_id = ? ORDER BY joined_at LIMIT 1").bind(roomId).first<any>();
  if (!next) {
    await db.batch([
      db.prepare("DELETE FROM game_sessions WHERE room_id = ?").bind(roomId),
      db.prepare("DELETE FROM rooms WHERE id = ?").bind(roomId),
    ]);
  } else {
    if (room?.status === "playing" && membership?.role === "player") {
      await db.batch([
        db.prepare("DELETE FROM game_sessions WHERE room_id = ?").bind(roomId),
        db.prepare("UPDATE rooms SET status = 'waiting', updated_at = ? WHERE id = ?").bind(nowIso(), roomId),
      ]);
    }
    if (room?.hostId === playerId) {
      await db.prepare("UPDATE rooms SET host_id = ?, updated_at = ? WHERE id = ?").bind(next.playerId, nowIso(), roomId).run();
    }
  }
  return { ok: true };
}

async function startGame(db: D1Database, playerId: string, payload: Record<string, any>) {
  const roomId = cleanText(payload.roomId, 80);
  const room = await db.prepare("SELECT game_id AS gameId, host_id AS hostId FROM rooms WHERE id = ?").bind(roomId).first<any>();
  if (!room || room.hostId !== playerId) throw new Error("방장만 시작할 수 있습니다.");
  const members = (await db.prepare(`SELECT rm.player_id AS id, p.nickname AS name FROM room_members rm
    JOIN players p ON p.id = rm.player_id WHERE rm.room_id = ? AND rm.role = 'player' ORDER BY rm.joined_at`)
    .bind(roomId).all()).results as Array<{ id: string; name: string }>;
  const info = GAME_BY_ID[room.gameId as GameId];
  if (members.length < info.minPlayers) throw new Error(`최소 ${info.minPlayers}명이 필요합니다.`);
  const game = createGame(room.gameId, members.slice(0, info.maxPlayers), Date.now());
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

async function applyGameAction(db: D1Database, playerId: string, payload: Record<string, any>) {
  const roomId = cleanText(payload.roomId, 80);
  const membership = await db.prepare("SELECT role FROM room_members WHERE room_id = ? AND player_id = ?")
    .bind(roomId, playerId).first<{ role: string }>();
  if (membership?.role !== "player") throw new Error("참가자만 행동할 수 있습니다.");
  const session = await db.prepare("SELECT state_json AS stateJson, revision FROM game_sessions WHERE room_id = ?").bind(roomId).first<any>();
  if (!session) throw new Error("아직 게임이 시작되지 않았습니다.");
  if (!payload.command || typeof payload.command !== "object" || !cleanText(payload.command.type, 40)) {
    throw new Error("잘못된 게임 행동입니다.");
  }
  const command = { ...payload.command, playerId, now: Date.now() } as GameCommand;
  const next = reduceGame(JSON.parse(session.stateJson), command);
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
