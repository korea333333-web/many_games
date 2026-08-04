import { GAME_BY_ID, GAME_CATALOG, isGameAvailable, type GameId } from "../games/catalog.ts";
import {
  advanceTimedGame,
  createGame,
  projectGame,
  reduceGame,
  removePlayerFromGame,
  type GameCommand,
  type GameEnvelope,
  type GameOptions,
} from "../games/engine.ts";
import { isKnownWord } from "./word-dictionary.ts";
import { getStateChangeTopics } from "./state-change-topics.ts";

type JsonRecord = Record<string, unknown>;
type MemberRole = "player" | "spectator";

type PlayerRecord = {
  id: string;
  nickname: string;
  lastSeen: string;
  createdAt: string;
};

type RoomRecord = {
  id: string;
  title: string;
  gameId: GameId;
  hostId: string;
  status: "waiting" | "playing";
  capacity: number;
  passwordHash: string | null;
  settings: GameOptions;
  createdAt: string;
  updatedAt: string;
};

type MemberRecord = {
  playerId: string;
  role: MemberRole;
  joinedAt: string;
};

type SessionRecord = {
  gameId: GameId;
  state: GameEnvelope;
  revision: number;
  updatedAt: string;
};

type MessageRecord = {
  id: number;
  senderId: string;
  recipientId: string | null;
  scope: "global" | "direct";
  body: string;
  createdAt: string;
};

type PlatformState = {
  players: Record<string, PlayerRecord>;
  rooms: Record<string, RoomRecord>;
  members: Record<string, MemberRecord[]>;
  sessions: Record<string, SessionRecord>;
  messages: MessageRecord[];
  nextMessageId: number;
  lastMaintenanceAt: number;
};

type StoredState = {
  revision: number;
  data: PlatformState;
};

export type StateAuth = {
  vercelOidcToken?: string | null;
};

type MutationResult<T> = { value: T; changed?: boolean };

const FINISHED_RETURN_DELAY_MS = 3_600;
const CHESS_FINISHED_RETURN_DELAY_MS = 12_000;
const ONLINE_WINDOW_MS = 2 * 60_000;
const HEARTBEAT_WRITE_INTERVAL_MS = 10_000;
const MAINTENANCE_INTERVAL_MS = 15_000;
const MAX_MESSAGES = 500;
const DEFAULT_SUPABASE_URL = "https://uhvjxyenxqqgyjwihhlc.supabase.co";
const ROUND_GAMES = new Set<GameId>(["drawing", "chosung", "same-answer"]);
const ALLOWED_ROUND_COUNTS = new Set([3, 5, 7, 10]);

function emptyState(): PlatformState {
  return {
    players: {},
    rooms: {},
    members: {},
    sessions: {},
    messages: [],
    nextMessageId: 1,
    lastMaintenanceAt: 0,
  };
}

function normalizeState(value: unknown): PlatformState {
  const state = asRecord(value);
  return {
    players: asRecord(state.players) as Record<string, PlayerRecord>,
    rooms: asRecord(state.rooms) as Record<string, RoomRecord>,
    members: asRecord(state.members) as Record<string, MemberRecord[]>,
    sessions: asRecord(state.sessions) as Record<string, SessionRecord>,
    messages: Array.isArray(state.messages) ? state.messages as MessageRecord[] : [],
    nextMessageId: Math.max(1, Number(state.nextMessageId) || 1),
    lastMaintenanceAt: Number(state.lastMaintenanceAt) || 0,
  };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function getSupabaseConfig() {
  const baseUrl = String(process.env.SUPABASE_URL ?? DEFAULT_SUPABASE_URL).replace(/\/$/, "");
  const stateSecret = String(process.env.GAME_STATE_SECRET ?? "");
  return { baseUrl, stateSecret };
}

function supabaseHeaders(auth?: StateAuth) {
  const { stateSecret } = getSupabaseConfig();
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (stateSecret) headers["x-game-state-secret"] = stateSecret;
  if (auth?.vercelOidcToken) headers["x-vercel-oidc-token"] = auth.vercelOidcToken;
  return headers;
}

async function readState(auth?: StateAuth): Promise<StoredState> {
  const { baseUrl } = getSupabaseConfig();
  const response = await fetch(`${baseUrl}/functions/v1/game-platform-state`, {
    method: "POST",
    headers: supabaseHeaders(auth),
    body: JSON.stringify({ action: "read" }),
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`게임 저장소를 읽지 못했습니다. (${response.status}: ${detail.slice(0, 120)})`);
  }
  const row = await response.json() as { revision: number; data: unknown };
  if (!row || typeof row.revision !== "number") throw new Error("게임 저장소가 초기화되지 않았습니다.");
  return { revision: Number(row.revision), data: normalizeState(row.data) };
}

async function compareAndSwap(
  expectedRevision: number,
  data: PlatformState,
  auth?: StateAuth,
  topics: string[] = [],
  origin?: string | null,
) {
  const { baseUrl } = getSupabaseConfig();
  const response = await fetch(`${baseUrl}/functions/v1/game-platform-state`, {
    method: "POST",
    headers: supabaseHeaders(auth),
    body: JSON.stringify({
      action: "cas",
      expectedRevision,
      data,
      topics,
      origin,
    }),
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`게임 저장소를 갱신하지 못했습니다. (${response.status}: ${detail.slice(0, 120)})`);
  }
  const result = await response.json() as { updated?: boolean };
  return result.updated === true;
}

async function mutateState<T>(
  mutator: (state: PlatformState) => Promise<MutationResult<T>> | MutationResult<T>,
  auth?: StateAuth,
  origin?: string | null,
  attempts = 5,
): Promise<{ value: T; state: PlatformState }> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const stored = await readState(auth);
    const next = structuredClone(stored.data);
    const result = await mutator(next);
    if (result.changed === false) return { value: result.value, state: stored.data };
    const topics = getStateChangeTopics(stored.data, next);
    if (await compareAndSwap(stored.revision, next, auth, topics, origin)) return { value: result.value, state: next };
  }
  throw new Error("다른 플레이어의 행동과 겹쳤습니다. 다시 시도해 주세요.");
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function cleanText(value: unknown, max: number) {
  return String(value ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanId(value: unknown) {
  const id = String(value ?? "");
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(id)) throw new Error("올바르지 않은 사용자 정보입니다.");
  return id;
}

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
  if (gameId === "same-answer") return { rounds: parsed.rounds === 10 ? 10 : 5 };
  return { rounds: parsed.rounds ?? 5 };
}

async function hashText(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function upsertPlayer(state: PlatformState, playerIdRaw: unknown, nicknameRaw: unknown, force = false) {
  const id = cleanId(playerIdRaw);
  const requested = cleanText(nicknameRaw, 14) || `플레이어${id.slice(-4)}`;
  const now = Date.now();
  const existing = state.players[id];
  const duplicate = Object.values(state.players).some(
    (player) => player.id !== id && player.nickname === requested,
  );
  const nickname = duplicate ? `${requested.slice(0, 10)}${id.slice(-3)}` : requested;
  const shouldWrite = force
    || !existing
    || existing.nickname !== nickname
    || now - Date.parse(existing.lastSeen) >= HEARTBEAT_WRITE_INTERVAL_MS;
  if (shouldWrite) {
    state.players[id] = {
      id,
      nickname,
      lastSeen: nowIso(now),
      createdAt: existing?.createdAt ?? nowIso(now),
    };
  }
  return { player: state.players[id] ?? { id, nickname, lastSeen: nowIso(now), createdAt: nowIso(now) }, changed: shouldWrite };
}

function roomMembers(state: PlatformState, roomId: string) {
  return state.members[roomId] ?? [];
}

function rebalanceRoomSeats(state: PlatformState, roomId: string, gameId: GameId) {
  const maxPlayers = GAME_BY_ID[gameId].maxPlayers;
  state.members[roomId] = roomMembers(state, roomId)
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
    .map((member, index) => ({ ...member, role: index < maxPlayers ? "player" : "spectator" }));
}

function removeMemberFromRoom(state: PlatformState, playerId: string, roomId: string) {
  const room = state.rooms[roomId];
  if (!room) return { interrupted: false };
  const membership = roomMembers(state, roomId).find((member) => member.playerId === playerId);
  if (!membership) return { interrupted: false };

  const remaining = roomMembers(state, roomId).filter((member) => member.playerId !== playerId);
  if (!remaining.length) {
    delete state.members[roomId];
    delete state.sessions[roomId];
    delete state.rooms[roomId];
    return { interrupted: room.status === "playing" };
  }
  state.members[roomId] = remaining;
  if (room.hostId === playerId) room.hostId = remaining[0].playerId;

  let interrupted = false;
  if (room.status === "playing" && membership.role === "player") {
    const playerCount = remaining.filter((member) => member.role === "player").length;
    const session = state.sessions[roomId];
    if (!session || playerCount < GAME_BY_ID[room.gameId].minPlayers) {
      interrupted = true;
      delete state.sessions[roomId];
      room.status = "waiting";
      room.updatedAt = nowIso();
      rebalanceRoomSeats(state, roomId, room.gameId);
    } else {
      session.state = removePlayerFromGame(session.state, playerId);
      session.revision += 1;
      session.updatedAt = nowIso();
    }
  } else if (room.status === "waiting") {
    rebalanceRoomSeats(state, roomId, room.gameId);
  }
  return { interrupted };
}

function leaveOtherRooms(state: PlatformState, playerId: string, keepRoomId?: string) {
  for (const [roomId, members] of Object.entries(state.members)) {
    if (roomId !== keepRoomId && members.some((member) => member.playerId === playerId)) {
      removeMemberFromRoom(state, playerId, roomId);
    }
  }
}

function runMaintenance(state: PlatformState, now = Date.now()) {
  let changed = false;

  for (const [roomId, session] of Object.entries(state.sessions)) {
    const returnDelay = session.state.gameId === "chess" ? CHESS_FINISHED_RETURN_DELAY_MS : FINISHED_RETURN_DELAY_MS;
    if (session.state.phase !== "finished" || now - Date.parse(session.updatedAt) < returnDelay) continue;
    const room = state.rooms[roomId];
    delete state.sessions[roomId];
    if (room) {
      room.status = "waiting";
      room.updatedAt = nowIso(now);
      rebalanceRoomSeats(state, roomId, room.gameId);
    }
    changed = true;
  }

  if (now - state.lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return changed;
  state.lastMaintenanceAt = now;
  changed = true;

  const staleCutoff = now - ONLINE_WINDOW_MS;
  for (const [roomId, members] of Object.entries(state.members)) {
    for (const member of [...members]) {
      const player = state.players[member.playerId];
      if (!player || Date.parse(player.lastSeen) < staleCutoff) {
        removeMemberFromRoom(state, member.playerId, roomId);
      }
    }
  }

  for (const room of Object.values(state.rooms)) {
    if (room.status !== "playing") continue;
    const playerCount = roomMembers(state, room.id).filter((member) => member.role === "player").length;
    if (playerCount >= GAME_BY_ID[room.gameId].minPlayers && state.sessions[room.id]) continue;
    delete state.sessions[room.id];
    room.status = "waiting";
    room.updatedAt = nowIso(now);
    rebalanceRoomSeats(state, room.id, room.gameId);
  }
  return changed;
}

function advanceRoomGame(state: PlatformState, roomId: string, now = Date.now()) {
  const session = state.sessions[roomId];
  if (!session) return false;
  const advanced = advanceTimedGame(session.state, now);
  if (JSON.stringify(advanced) === JSON.stringify(session.state)) return false;
  session.state = advanced;
  session.revision += 1;
  session.updatedAt = nowIso(now);
  return true;
}

function makeRoomListItem(state: PlatformState, room: RoomRecord) {
  const members = roomMembers(state, room.id);
  return {
    id: room.id,
    title: room.title,
    gameId: room.gameId,
    hostId: room.hostId,
    hostName: state.players[room.hostId]?.nickname ?? "알 수 없음",
    status: room.status,
    capacity: room.capacity,
    locked: Boolean(room.passwordHash),
    memberCount: members.length,
    playerCount: members.filter((member) => member.role === "player").length,
    settings: room.settings,
  };
}

function makeSnapshot(state: PlatformState, playerId: string | null, roomId: string) {
  const now = Date.now();
  const rooms = Object.values(state.rooms)
    .filter((room) => isGameAvailable(room.gameId))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "waiting" ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, 60)
    .map((room) => makeRoomListItem(state, room));
  const onlinePlayers = Object.values(state.players)
    .filter((player) => now - Date.parse(player.lastSeen) <= ONLINE_WINDOW_MS)
    .sort((a, b) => a.nickname.localeCompare(b.nickname, "ko"))
    .slice(0, 100)
    .map(({ id, nickname, lastSeen }) => ({ id, nickname, lastSeen }));

  const hydrateMessage = (message: MessageRecord) => ({
    ...message,
    senderName: state.players[message.senderId]?.nickname ?? "알 수 없음",
    recipientName: message.recipientId ? state.players[message.recipientId]?.nickname : undefined,
  });
  const globalMessages = state.messages
    .filter((message) => message.scope === "global")
    .slice(-50)
    .map(hydrateMessage);
  const directMessages = playerId
    ? state.messages
      .filter((message) => message.scope === "direct" && (message.senderId === playerId || message.recipientId === playerId))
      .slice(-100)
      .map(hydrateMessage)
    : [];

  let activeRoom = null;
  const room = roomId ? state.rooms[roomId] : undefined;
  if (room && isGameAvailable(room.gameId) && playerId) {
    const membership = roomMembers(state, roomId).find((member) => member.playerId === playerId);
    if (membership) {
      const members = roomMembers(state, roomId)
        .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
        .map((member) => ({
          id: member.playerId,
          name: state.players[member.playerId]?.nickname ?? "알 수 없음",
          role: member.role,
          joinedAt: member.joinedAt,
        }));
      const session = state.sessions[roomId];
      activeRoom = {
        ...makeRoomListItem(state, room),
        members,
        viewerRole: membership.role,
        game: session ? projectGame(session.state, playerId) : null,
        revision: session?.revision ?? 0,
      };
    }
  }

  return {
    rooms,
    onlinePlayers,
    globalMessages,
    directMessages,
    activeRoom,
    games: GAME_CATALOG,
    serverTime: nowIso(now),
  };
}

export async function touchPlayer(playerIdRaw: unknown, nicknameRaw: unknown, auth?: StateAuth) {
  const playerId = cleanId(playerIdRaw);
  const result = await mutateState((state) => {
    const actor = upsertPlayer(state, playerId, nicknameRaw, true);
    return { value: actor.player, changed: actor.changed };
  }, auth, playerId);
  return result.value;
}

export async function getSnapshot(playerIdRaw: unknown, roomIdRaw?: unknown, nicknameRaw?: unknown, auth?: StateAuth) {
  const playerId = playerIdRaw ? cleanId(playerIdRaw) : null;
  const roomId = cleanText(roomIdRaw, 80);
  const result = await mutateState((state) => {
    let changed = runMaintenance(state);
    if (playerId) changed = upsertPlayer(state, playerId, nicknameRaw).changed || changed;
    if (roomId) changed = advanceRoomGame(state, roomId) || changed;
    return { value: null, changed };
  }, auth, playerId);
  return makeSnapshot(result.state, playerId, roomId);
}

export async function executeCommand(body: JsonRecord, auth?: StateAuth) {
  const type = String(body.type ?? "heartbeat");
  const payload = asRecord(body.payload);
  const playerId = cleanId(body.playerId);
  const requestedRoomId = cleanText(body.roomId, 80);

  const result = await mutateState(async (state) => {
    const actor = upsertPlayer(state, playerId, body.nickname, true).player;
    runMaintenance(state);

    if (type === "heartbeat" || type === "setNickname") return { value: { ok: true, player: actor } };
    if (type === "createRoom") return { value: await createRoom(state, actor.id, payload) };
    if (type === "joinRoom") return { value: await joinRoom(state, actor.id, payload) };
    if (type === "leaveRoom") return { value: leaveRoom(state, actor.id, payload) };
    if (type === "startGame") return { value: startGame(state, actor.id, payload) };
    if (type === "gameAction") return { value: await applyGameAction(state, actor.id, payload) };
    if (type === "sendGlobal") return { value: sendMessage(state, actor.id, null, "global", payload.body) };
    if (type === "sendDirect") return { value: sendMessage(state, actor.id, cleanId(payload.recipientId), "direct", payload.body) };
    throw new Error("지원하지 않는 요청입니다.");
  }, auth, playerId);
  const value = asRecord(result.value);
  const valueRoomId = cleanText(value.roomId, 80);
  const snapshotRoomId = type === "leaveRoom" ? "" : valueRoomId || requestedRoomId || cleanText(payload.roomId, 80);
  return {
    ...value,
    snapshot: makeSnapshot(result.state, playerId, snapshotRoomId),
  };
}

async function createRoom(state: PlatformState, hostId: string, payload: JsonRecord) {
  const gameId = String(payload.gameId ?? "") as GameId;
  const game = GAME_BY_ID[gameId];
  if (!game || !isGameAvailable(gameId)) throw new Error("현재 선택할 수 없는 게임입니다.");
  const id = crypto.randomUUID().replaceAll("-", "");
  const title = cleanText(payload.title, 30) || `${game.name} 같이 해요`;
  const password = cleanText(payload.password, 40);
  const now = nowIso();
  leaveOtherRooms(state, hostId);
  state.rooms[id] = {
    id,
    title,
    gameId,
    hostId,
    status: "waiting",
    capacity: 10,
    passwordHash: password ? await hashText(password) : null,
    settings: sanitizeSettings(gameId, payload.settings),
    createdAt: now,
    updatedAt: now,
  };
  state.members[id] = [{ playerId: hostId, role: "player", joinedAt: now }];
  return { ok: true, roomId: id };
}

async function joinRoom(state: PlatformState, playerId: string, payload: JsonRecord) {
  const roomId = cleanText(payload.roomId, 80);
  const room = state.rooms[roomId];
  if (!room) throw new Error("방을 찾을 수 없습니다.");
  if (!isGameAvailable(room.gameId)) throw new Error("현재 이용할 수 없는 게임의 방입니다.");
  const existing = roomMembers(state, roomId).find((member) => member.playerId === playerId);
  if (!existing && roomMembers(state, roomId).length >= room.capacity) throw new Error("방이 가득 찼습니다.");
  if (room.passwordHash) {
    const supplied = await hashText(cleanText(payload.password, 40));
    if (supplied !== room.passwordHash) throw new Error("비밀번호가 맞지 않습니다.");
  }
  leaveOtherRooms(state, playerId, roomId);
  if (existing) return { ok: true, roomId, role: existing.role };
  const playerCount = roomMembers(state, roomId).filter((member) => member.role === "player").length;
  const role: MemberRole = room.status === "waiting" && playerCount < GAME_BY_ID[room.gameId].maxPlayers
    ? "player"
    : "spectator";
  state.members[roomId] = [...roomMembers(state, roomId), { playerId, role, joinedAt: nowIso() }];
  room.updatedAt = nowIso();
  return { ok: true, roomId, role };
}

function leaveRoom(state: PlatformState, playerId: string, payload: JsonRecord) {
  const roomId = cleanText(payload.roomId, 80);
  return { ok: true, ...removeMemberFromRoom(state, playerId, roomId) };
}

function startGame(state: PlatformState, playerId: string, payload: JsonRecord) {
  const roomId = cleanText(payload.roomId, 80);
  const room = state.rooms[roomId];
  if (!room || room.hostId !== playerId) throw new Error("방장만 시작할 수 있습니다.");
  if (!isGameAvailable(room.gameId)) throw new Error("현재 이용할 수 없는 게임입니다.");
  const members = roomMembers(state, roomId)
    .filter((member) => member.role === "player")
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
    .map((member) => ({ id: member.playerId, name: state.players[member.playerId]?.nickname ?? "플레이어" }));
  const info = GAME_BY_ID[room.gameId];
  if (members.length < info.minPlayers) throw new Error(`최소 ${info.minPlayers}명이 필요합니다.`);
  const game = createGame(room.gameId, members.slice(0, info.maxPlayers), Date.now(), sanitizeSettings(room.gameId, room.settings));
  const previousRevision = state.sessions[roomId]?.revision ?? 0;
  state.sessions[roomId] = {
    gameId: room.gameId,
    state: game,
    revision: previousRevision + 1,
    updatedAt: nowIso(),
  };
  room.status = "playing";
  room.updatedAt = nowIso();
  return { ok: true };
}

async function applyGameAction(state: PlatformState, playerId: string, payload: JsonRecord) {
  const roomId = cleanText(payload.roomId, 80);
  const membership = roomMembers(state, roomId).find((member) => member.playerId === playerId);
  if (membership?.role !== "player") throw new Error("참가자만 행동할 수 있습니다.");
  const session = state.sessions[roomId];
  if (!session) throw new Error("아직 게임이 시작되지 않았습니다.");
  const rawCommand = asRecord(payload.command);
  if (!cleanText(rawCommand.type, 40)) throw new Error("올바르지 않은 게임 행동입니다.");
  const command = {
    ...rawCommand,
    payload: { ...asRecord(rawCommand.payload) },
    playerId,
    now: Date.now(),
  } as GameCommand;
  if (session.state.gameId === "word-chain" && command.type === "SUBMIT_WORD") {
    command.payload!.dictionaryValid = await isKnownWord(command.payload?.word);
  }
  const next = reduceGame(session.state, command);
  session.state = next;
  session.revision += 1;
  session.updatedAt = nowIso();
  return { ok: true, message: next.message };
}

function sendMessage(
  state: PlatformState,
  senderId: string,
  recipientId: string | null,
  scope: "global" | "direct",
  rawBody: unknown,
) {
  const body = cleanText(rawBody, 200);
  if (!body) throw new Error("메시지를 입력해 주세요.");
  if (recipientId && !state.players[recipientId]) throw new Error("사용자를 찾을 수 없습니다.");
  state.messages.push({
    id: state.nextMessageId,
    senderId,
    recipientId,
    scope,
    body,
    createdAt: nowIso(),
  });
  state.nextMessageId += 1;
  if (state.messages.length > MAX_MESSAGES) state.messages = state.messages.slice(-MAX_MESSAGES);
  return { ok: true };
}

export { emptyState };
