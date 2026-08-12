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
import { canJoinPersistentGoRoom, GO_INACTIVE_EXPIRY_MS, isPersistentGoRoomExpired, latestGoActivityAt } from "./go-room-policy.ts";
import {
  buildLeaderboard,
  emptyRankingState,
  isAuthenticatedPlayerId,
  isRankedGame,
  normalizeRankingState,
  recordCompletedMatch,
  type RankingState,
} from "../rankings.ts";
import {
  COSMETIC_CATALOG,
  ANNOUNCEMENT_COOLDOWN_MS,
  MAX_SECONDARY_ADMINS,
  adminRoleFor,
  cosmeticById,
  createDefaultProfile,
  emptyModerationState,
  normalizeModerationState,
  normalizeProfiles,
  type AdminRole,
  type FeedbackRecord,
  type ModerationState,
  type ProfileRecord,
} from "../community.ts";

type JsonRecord = Record<string, unknown>;
type MemberRole = "player" | "spectator";
type RoomSettings = GameOptions & { ranked?: boolean };

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
  settings: RoomSettings;
  createdAt: string;
  updatedAt: string;
  reservedPlayerIds?: string[];
  lastActiveAt?: string;
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
  matchId?: string;
  resultRecorded?: boolean;
};

type MessageRecord = {
  id: number;
  senderId: string;
  recipientId: string | null;
  scope: "global" | "direct";
  body: string;
  createdAt: string;
  deletedAt?: string;
  deletedBy?: string;
};

type PlatformState = {
  players: Record<string, PlayerRecord>;
  rooms: Record<string, RoomRecord>;
  members: Record<string, MemberRecord[]>;
  sessions: Record<string, SessionRecord>;
  messages: MessageRecord[];
  pinnedDirects: Record<string, string[]>;
  rankings: RankingState;
  profiles: Record<string, ProfileRecord>;
  moderation: ModerationState;
  feedback: FeedbackRecord[];
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
const GO_FINISHED_RETURN_DELAY_MS = 12_000;
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
    pinnedDirects: {},
    rankings: emptyRankingState(),
    profiles: {},
    moderation: emptyModerationState(),
    feedback: [],
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
    pinnedDirects: Object.fromEntries(
      Object.entries(asRecord(state.pinnedDirects)).map(([id, targets]) => [id, Array.isArray(targets) ? targets.filter((target): target is string => typeof target === "string") : []]),
    ),
    rankings: normalizeRankingState(state.rankings),
    profiles: normalizeProfiles(state.profiles),
    moderation: normalizeModerationState(state.moderation),
    feedback: Array.isArray(state.feedback) ? state.feedback as FeedbackRecord[] : [],
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

function parseSettings(value: unknown): RoomSettings {
  try {
    const raw = typeof value === "string" ? JSON.parse(value) : value;
    const rounds = Number((raw as { rounds?: unknown } | null)?.rounds);
    const ranked = (raw as { ranked?: unknown } | null)?.ranked === true;
    return { ...(ALLOWED_ROUND_COUNTS.has(rounds) ? { rounds } : {}), ...(ranked ? { ranked: true } : {}) };
  } catch {
    return {};
  }
}

function sanitizeSettings(gameId: GameId, value: unknown): RoomSettings {
  const parsed = parseSettings(value);
  const ranked = isRankedGame(gameId) && parsed.ranked === true;
  if (!ROUND_GAMES.has(gameId)) return ranked ? { ranked: true } : {};
  const rounds = gameId === "same-answer" ? (parsed.rounds === 10 ? 10 : 5) : (parsed.rounds ?? 5);
  return { rounds, ...(ranked ? { ranked: true } : {}) };
}

async function hashText(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashAdminPassword(value: string) {
  const pepper = String(process.env.GAME_STATE_SECRET ?? "many-games-admin");
  return hashText(`${pepper}:${value}`);
}

function ensureProfile(state: PlatformState, playerId: string) {
  if (!isAuthenticatedPlayerId(playerId)) return null;
  state.profiles[playerId] ??= createDefaultProfile(nowIso());
  return state.profiles[playerId];
}

function requireLogin(playerId: string) {
  if (!isAuthenticatedPlayerId(playerId)) throw new Error("Google 로그인 후 사용할 수 있습니다.");
}

function requireAdmin(state: PlatformState, playerId: string, masterOnly = false): AdminRole {
  requireLogin(playerId);
  const role = adminRoleFor(state.moderation, playerId);
  if (!role || (masterOnly && role !== "master")) throw new Error(masterOnly ? "최고관리자만 사용할 수 있습니다." : "관리자 권한이 필요합니다.");
  return role;
}

function publicCareer(state: PlatformState, playerId: string) {
  const career = state.rankings.players[playerId];
  const total = Object.values(career?.games ?? {}).reduce((sum, record) => ({
    played: sum.played + record.played,
    wins: sum.wins + record.wins,
    losses: sum.losses + record.losses,
    draws: sum.draws + record.draws,
  }), { played: 0, wins: 0, losses: 0, draws: 0 });
  return { total, games: career?.games ?? {}, ranked: career?.ranked ?? {} };
}

function makePublicProfile(state: PlatformState, playerId: string) {
  const player = state.players[playerId];
  if (!player) return null;
  const profile = state.profiles[playerId];
  return {
    id: playerId,
    nickname: player.nickname,
    createdAt: player.createdAt,
    updatedAt: profile?.updatedAt ?? player.createdAt,
    statusMessage: profile?.statusMessage ?? "",
    coins: profile?.coins ?? 0,
    infiniteCoins: adminRoleFor(state.moderation, playerId) === "master",
    equipped: profile?.equipped ?? {},
    adminRole: adminRoleFor(state.moderation, playerId),
    career: publicCareer(state, playerId),
  };
}

function upsertPlayer(state: PlatformState, playerIdRaw: unknown, nicknameRaw: unknown, force = false) {
  const id = cleanId(playerIdRaw);
  const requested = cleanText(nicknameRaw, 14) || `플레이어${id.slice(-4)}`;
  const now = Date.now();
  const existing = state.players[id];
  const profileMissing = isAuthenticatedPlayerId(id) && !state.profiles[id];
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
  if (profileMissing) ensureProfile(state, id);
  return { player: state.players[id] ?? { id, nickname, lastSeen: nowIso(now), createdAt: nowIso(now) }, changed: shouldWrite || profileMissing };
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

function isPersistentGoRoom(room: RoomRecord | undefined) {
  return room?.gameId === "go";
}

function activeGoPlayerIds(state: PlatformState, roomId: string) {
  return new Set(roomMembers(state, roomId).map((member) => member.playerId));
}

function removeMemberFromRoom(state: PlatformState, playerId: string, roomId: string, departedAt = nowIso()) {
  const room = state.rooms[roomId];
  if (!room) return { interrupted: false };
  const membership = roomMembers(state, roomId).find((member) => member.playerId === playerId);
  if (!membership) return { interrupted: false };

  const remaining = roomMembers(state, roomId).filter((member) => member.playerId !== playerId);
  if (isPersistentGoRoom(room) && room.reservedPlayerIds?.includes(playerId)) {
    const session = state.sessions[roomId];
    if (!remaining.length && session?.state.phase === "finished") {
      delete state.members[roomId];
      delete state.sessions[roomId];
      delete state.rooms[roomId];
      return { interrupted: false, saved: false };
    }
    state.members[roomId] = remaining;
    room.lastActiveAt = latestGoActivityAt(room.lastActiveAt, departedAt);
    room.updatedAt = nowIso();
    return { interrupted: false, saved: true };
  }
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
    if (session.state.phase === "finished") changed = recordSessionCompletion(state, roomId, session) || changed;
    const returnDelay = session.state.gameId === "chess"
      ? CHESS_FINISHED_RETURN_DELAY_MS
      : session.state.gameId === "go"
        ? GO_FINISHED_RETURN_DELAY_MS
        : FINISHED_RETURN_DELAY_MS;
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
        removeMemberFromRoom(state, member.playerId, roomId, player?.lastSeen ?? nowIso(now));
      }
    }
  }

  for (const room of Object.values(state.rooms)) {
    if (room.status !== "playing") continue;
    if (isPersistentGoRoom(room) && state.sessions[room.id]) continue;
    const playerCount = roomMembers(state, room.id).filter((member) => member.role === "player").length;
    if (playerCount >= GAME_BY_ID[room.gameId].minPlayers && state.sessions[room.id]) continue;
    delete state.sessions[room.id];
    room.status = "waiting";
    room.updatedAt = nowIso(now);
    rebalanceRoomSeats(state, room.id, room.gameId);
  }


  for (const [roomId, room] of Object.entries(state.rooms)) {
    if (!isPersistentGoRoom(room) || !isPersistentGoRoomExpired(room, roomMembers(state, roomId).length, now)) continue;
    delete state.members[roomId];
    delete state.sessions[roomId];
    delete state.rooms[roomId];
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
  recordSessionCompletion(state, roomId, session);
  return true;
}

function recordSessionCompletion(state: PlatformState, roomId: string, session: SessionRecord) {
  if (session.state.phase !== "finished" || session.resultRecorded) return false;
  const room = state.rooms[roomId];
  const matchId = session.matchId ?? crypto.randomUUID().replaceAll("-", "");
  const recorded = recordCompletedMatch(state.rankings, {
    matchId,
    gameId: session.state.gameId,
    playerIds: session.state.players.map((player) => player.id),
    winnerIds: session.state.winnerIds,
    ranked: Boolean(room?.settings.ranked),
    completedAt: session.updatedAt,
  });
  if (recorded) {
    for (const winnerId of session.state.winnerIds.filter(isAuthenticatedPlayerId)) {
      const profile = ensureProfile(state, winnerId);
      if (profile) {
        profile.coins += 30;
        profile.updatedAt = session.updatedAt;
      }
    }
  }
  session.matchId = matchId;
  session.resultRecorded = true;
  return true;
}

function makeRoomListItem(state: PlatformState, room: RoomRecord, viewerId?: string | null) {
  const members = roomMembers(state, room.id);
  const reservedPlayerIds = isPersistentGoRoom(room) ? (room.reservedPlayerIds ?? []) : [];
  const memberCount = isPersistentGoRoom(room) ? reservedPlayerIds.length : members.length;
  const lastActiveAt = room.lastActiveAt ?? room.updatedAt;
  return {
    id: room.id,
    title: room.title,
    gameId: room.gameId,
    hostId: room.hostId,
    hostName: state.players[room.hostId]?.nickname ?? "알 수 없음",
    status: room.status,
    capacity: room.capacity,
    locked: Boolean(room.passwordHash),
    memberCount,
    playerCount: isPersistentGoRoom(room) ? reservedPlayerIds.length : members.filter((member) => member.role === "player").length,
    onlineCount: members.length,
    persistent: isPersistentGoRoom(room),
    reservedForViewer: Boolean(viewerId && reservedPlayerIds.includes(viewerId)),
    participantLocked: isPersistentGoRoom(room) && reservedPlayerIds.length >= 2,
    lastActiveAt,
    expiresAt: isPersistentGoRoom(room) && members.length === 0
      ? nowIso(Date.parse(lastActiveAt) + GO_INACTIVE_EXPIRY_MS)
      : null,
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
    .map((room) => makeRoomListItem(state, room, playerId));
  const onlinePlayers = Object.values(state.players)
    .filter((player) => now - Date.parse(player.lastSeen) <= ONLINE_WINDOW_MS)
    .sort((a, b) => a.nickname.localeCompare(b.nickname, "ko"))
    .slice(0, 100)
    .map(({ id, nickname, lastSeen }) => ({ id, nickname, lastSeen, adminRole: adminRoleFor(state.moderation, id) }));

  const hydrateMessage = (message: MessageRecord) => ({
    ...message,
    senderName: state.players[message.senderId]?.nickname ?? "알 수 없음",
    recipientName: message.recipientId ? state.players[message.recipientId]?.nickname : undefined,
    senderAdminRole: adminRoleFor(state.moderation, message.senderId),
    body: message.deletedAt ? "관리자에 의해 삭제된 메시지입니다." : message.body,
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
  const pinnedDirectIds = playerId ? (state.pinnedDirects[playerId] ?? []) : [];
  const onlineIds = new Set(onlinePlayers.map((player) => player.id));
  const directContactIds = new Set([
    ...pinnedDirectIds,
    ...onlinePlayers.map((player) => player.id),
    ...Object.keys(state.players),
    ...directMessages.flatMap((message) => [message.senderId, message.recipientId].filter((id): id is string => Boolean(id))),
  ]);
  if (playerId) directContactIds.delete(playerId);
  const directContacts = [...directContactIds]
    .map((id) => state.players[id])
    .filter((player): player is PlayerRecord => Boolean(player))
    .map((player) => ({
      id: player.id,
      nickname: player.nickname,
      lastSeen: player.lastSeen,
      online: onlineIds.has(player.id),
      pinned: pinnedDirectIds.includes(player.id),
      adminRole: adminRoleFor(state.moderation, player.id),
    }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.online) - Number(a.online) || a.nickname.localeCompare(b.nickname, "ko"))
    .slice(0, 200);

  let activeRoom = null;
  const room = roomId ? state.rooms[roomId] : undefined;
  if (room && isGameAvailable(room.gameId) && playerId) {
    const membership = roomMembers(state, roomId).find((member) => member.playerId === playerId);
    if (membership) {
      const liveMemberIds = activeGoPlayerIds(state, roomId);
      const members = isPersistentGoRoom(room)
        ? (room.reservedPlayerIds ?? []).map((id) => ({
          id,
          name: state.players[id]?.nickname ?? "알 수 없음",
          role: "player" as const,
          joinedAt: roomMembers(state, roomId).find((member) => member.playerId === id)?.joinedAt ?? room.createdAt,
          online: liveMemberIds.has(id),
          adminRole: adminRoleFor(state.moderation, id),
        }))
        : roomMembers(state, roomId)
          .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
          .map((member) => ({
            id: member.playerId,
            name: state.players[member.playerId]?.nickname ?? "알 수 없음",
            role: member.role,
            joinedAt: member.joinedAt,
            online: true,
            adminRole: adminRoleFor(state.moderation, member.playerId),
          }));
      const session = state.sessions[roomId];
      activeRoom = {
        ...makeRoomListItem(state, room, playerId),
        members,
        viewerRole: membership.role,
        game: session ? projectGame(session.state, playerId) : null,
        revision: session?.revision ?? 0,
      };
    }
  }

  const viewerAdminRole = playerId ? adminRoleFor(state.moderation, playerId) : null;
  const playerDirectory = Object.values(state.players)
    .sort((left, right) => right.lastSeen.localeCompare(left.lastSeen))
    .slice(0, 200)
    .map((player) => makePublicProfile(state, player.id))
    .filter((profile): profile is NonNullable<ReturnType<typeof makePublicProfile>> => Boolean(profile));
  const viewerWarnings = playerId
    ? state.moderation.warnings.filter((warning) => warning.playerId === playerId).slice(-10)
    : [];
  const feedback = viewerAdminRole
    ? state.feedback.slice(-200).reverse().map((item) => ({ ...item, nickname: state.players[item.playerId]?.nickname ?? "알 수 없음" }))
    : playerId
      ? state.feedback.filter((item) => item.playerId === playerId).slice(-20).reverse()
      : [];
  const activeAnnouncement = state.moderation.announcement && Date.parse(state.moderation.announcement.expiresAt) > now
    ? {
      ...state.moderation.announcement,
      issuerName: state.players[state.moderation.announcement.issuerId]?.nickname ?? "관리자",
      issuerAdminRole: adminRoleFor(state.moderation, state.moderation.announcement.issuerId),
    }
    : null;
  const serverPresence = viewerAdminRole ? onlinePlayers.map((player) => {
    const roomEntry = Object.entries(state.members).find(([, members]) => members.some((member) => member.playerId === player.id));
    const room = roomEntry ? state.rooms[roomEntry[0]] : null;
    return {
      ...player,
      loggedIn: isAuthenticatedPlayerId(player.id),
      room: room ? { id: room.id, title: room.title, gameId: room.gameId, status: room.status } : null,
    };
  }) : [];

  return {
    rooms,
    leaderboard: buildLeaderboard(state.rankings, (id) => state.players[id]?.nickname ?? `플레이어${id.slice(-4)}`),
    onlinePlayers,
    directContacts,
    pinnedDirectIds,
    globalMessages,
    directMessages,
    activeRoom,
    games: GAME_CATALOG,
    playerDirectory,
    viewerProfile: playerId ? makePublicProfile(state, playerId) : null,
    viewerInventoryIds: playerId ? (state.profiles[playerId]?.inventoryIds ?? []) : [],
    cosmetics: COSMETIC_CATALOG,
    adminRole: viewerAdminRole,
    viewerWarnings,
    ban: playerId ? state.moderation.bans[playerId] ?? null : null,
    moderationPlayers: viewerAdminRole ? playerDirectory.map((profile) => ({
      ...profile,
      warningCount: state.moderation.warnings.filter((warning) => warning.playerId === profile.id).length,
      banned: Boolean(state.moderation.bans[profile.id]),
    })) : [],
    feedback,
    announcement: activeAnnouncement,
    serverPresence,
    secondaryAdminCount: state.moderation.secondaryAdminIds.length,
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

    if (type === "heartbeat") return { value: { ok: true, player: actor } };
    if (state.moderation.bans[actor.id]) throw new Error(`이용이 제한된 계정입니다: ${state.moderation.bans[actor.id].reason}`);
    if (type === "setNickname") return { value: { ok: true, player: actor } };
    if (type === "createRoom") return { value: await createRoom(state, actor.id, payload) };
    if (type === "joinRoom") return { value: await joinRoom(state, actor.id, payload) };
    if (type === "leaveRoom") return { value: leaveRoom(state, actor.id, payload) };
    if (type === "startGame") return { value: startGame(state, actor.id, payload) };
    if (type === "gameAction") return { value: await applyGameAction(state, actor.id, payload) };
    if (type === "sendGlobal") return { value: sendMessage(state, actor.id, null, "global", payload.body) };
    if (type === "sendDirect") return { value: sendMessage(state, actor.id, cleanId(payload.recipientId), "direct", payload.body) };
    if (type === "toggleDirectPin") return { value: toggleDirectPin(state, actor.id, cleanId(payload.targetId)) };
    if (type === "claimMasterAdmin") return { value: await claimMasterAdmin(state, actor.id, payload.password) };
    if (type === "changeAdminPassword") return { value: await changeAdminPassword(state, actor.id, payload.currentPassword, payload.newPassword) };
    if (type === "setSecondaryAdmin") return { value: setSecondaryAdmin(state, actor.id, payload) };
    if (type === "grantCoins") return { value: grantCoins(state, actor.id, payload) };
    if (type === "sendAnnouncement") return { value: sendAnnouncement(state, actor.id, payload) };
    if (type === "warnPlayer") return { value: warnPlayer(state, actor.id, payload) };
    if (type === "setPlayerBan") return { value: setPlayerBan(state, actor.id, payload) };
    if (type === "deleteMessage") return { value: deleteMessage(state, actor.id, payload) };
    if (type === "acknowledgeWarning") return { value: acknowledgeWarning(state, actor.id, payload) };
    if (type === "updateProfile") return { value: updateProfile(state, actor.id, payload) };
    if (type === "purchaseCosmetic") return { value: purchaseCosmetic(state, actor.id, payload) };
    if (type === "submitFeedback") return { value: submitFeedback(state, actor.id, payload) };
    if (type === "resolveFeedback") return { value: resolveFeedback(state, actor.id, payload) };
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
  const settings = sanitizeSettings(gameId, payload.settings);
  if (gameId === "go" && !isAuthenticatedPlayerId(hostId)) throw new Error("바둑의 이어두기 방은 Google 로그인 후 만들 수 있습니다.");
  if (settings.ranked && !isAuthenticatedPlayerId(hostId)) throw new Error("랭크전은 Google 로그인 후 만들 수 있습니다.");
  if (settings.ranked && password) throw new Error("랭크전은 누구나 참가할 수 있는 공개방으로 만들어 주세요.");
  const now = nowIso();
  leaveOtherRooms(state, hostId);
  state.rooms[id] = {
    id,
    title,
    gameId,
    hostId,
    status: "waiting",
    capacity: gameId === "go" ? 2 : 10,
    passwordHash: password ? await hashText(password) : null,
    settings,
    createdAt: now,
    updatedAt: now,
    ...(gameId === "go" ? { reservedPlayerIds: [hostId], lastActiveAt: now } : {}),
  };
  state.members[id] = [{ playerId: hostId, role: "player", joinedAt: now }];
  return { ok: true, roomId: id };
}

async function joinRoom(state: PlatformState, playerId: string, payload: JsonRecord) {
  const roomId = cleanText(payload.roomId, 80);
  const room = state.rooms[roomId];
  if (!room) throw new Error("방을 찾을 수 없습니다.");
  if (!isGameAvailable(room.gameId)) throw new Error("현재 이용할 수 없는 게임의 방입니다.");
  if (room.settings.ranked && !isAuthenticatedPlayerId(playerId)) throw new Error("랭크전은 Google 로그인 후 참가할 수 있습니다.");
  if (isPersistentGoRoom(room) && !isAuthenticatedPlayerId(playerId)) throw new Error("바둑 이어두기는 Google 로그인 후 참가할 수 있습니다.");
  const reservedPlayerIds = room.reservedPlayerIds ?? [];
  if (isPersistentGoRoom(room) && !canJoinPersistentGoRoom(reservedPlayerIds, playerId)) {
    throw new Error("이 바둑방은 처음 참가한 두 사람만 다시 들어올 수 있습니다.");
  }
  const existing = roomMembers(state, roomId).find((member) => member.playerId === playerId);
  if (!existing && roomMembers(state, roomId).length >= room.capacity) throw new Error("방이 가득 찼습니다.");
  if (room.passwordHash) {
    const supplied = await hashText(cleanText(payload.password, 40));
    if (supplied !== room.passwordHash) throw new Error("비밀번호가 맞지 않습니다.");
  }
  leaveOtherRooms(state, playerId, roomId);
  if (existing) {
    if (isPersistentGoRoom(room)) room.lastActiveAt = nowIso();
    return { ok: true, roomId, role: existing.role };
  }
  const playerCount = roomMembers(state, roomId).filter((member) => member.role === "player").length;
  const role: MemberRole = isPersistentGoRoom(room) && (room.reservedPlayerIds ?? []).includes(playerId)
    ? "player"
    : room.status === "waiting" && playerCount < GAME_BY_ID[room.gameId].maxPlayers
      ? "player"
      : "spectator";
  state.members[roomId] = [...roomMembers(state, roomId), { playerId, role, joinedAt: nowIso() }];
  room.updatedAt = nowIso();
  if (isPersistentGoRoom(room)) {
    if (!reservedPlayerIds.includes(playerId)) room.reservedPlayerIds = [...reservedPlayerIds, playerId];
    room.lastActiveAt = room.updatedAt;
  }
  return { ok: true, roomId, role };
}

function leaveRoom(state: PlatformState, playerId: string, payload: JsonRecord) {
  const roomId = cleanText(payload.roomId, 80);
  return { ok: true, ...removeMemberFromRoom(state, playerId, roomId) };
}

function startGame(state: PlatformState, playerId: string, payload: JsonRecord) {
  const roomId = cleanText(payload.roomId, 80);
  const room = state.rooms[roomId];
  if (!room || (room.hostId !== playerId && !(isPersistentGoRoom(room) && room.reservedPlayerIds?.includes(playerId)))) throw new Error("방장만 시작할 수 있습니다.");
  if (!isGameAvailable(room.gameId)) throw new Error("현재 이용할 수 없는 게임입니다.");
  const members = isPersistentGoRoom(room)
    ? (room.reservedPlayerIds ?? []).map((id) => ({ id, name: state.players[id]?.nickname ?? "플레이어" }))
    : roomMembers(state, roomId)
      .filter((member) => member.role === "player")
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
      .map((member) => ({ id: member.playerId, name: state.players[member.playerId]?.nickname ?? "플레이어" }));
  const info = GAME_BY_ID[room.gameId];
  if (members.length < info.minPlayers) throw new Error(`최소 ${info.minPlayers}명이 필요합니다.`);
  if (room.settings.ranked && (members.length !== 2 || !members.every((member) => isAuthenticatedPlayerId(member.id)))) {
    throw new Error("랭크전은 로그인한 플레이어 2명이 필요합니다.");
  }
  const game = createGame(room.gameId, members.slice(0, info.maxPlayers), Date.now(), sanitizeSettings(room.gameId, room.settings));
  const previousRevision = state.sessions[roomId]?.revision ?? 0;
  state.sessions[roomId] = {
    gameId: room.gameId,
    state: game,
    revision: previousRevision + 1,
    updatedAt: nowIso(),
    matchId: crypto.randomUUID().replaceAll("-", ""),
    resultRecorded: false,
  };
  room.status = "playing";
  room.updatedAt = nowIso();
  if (isPersistentGoRoom(room)) room.lastActiveAt = room.updatedAt;
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
  const room = state.rooms[roomId];
  if (room?.settings.ranked && rawCommand.type === "REMATCH") throw new Error("랭크전은 대기방에서 새 경기로 시작해 주세요.");
  const command = {
    ...rawCommand,
    payload: { ...asRecord(rawCommand.payload) },
    playerId,
    now: Date.now(),
  } as GameCommand;
  if (session.state.gameId === "word-chain" && command.type === "SUBMIT_WORD") {
    command.payload!.dictionaryValid = await isKnownWord(command.payload?.word);
  }
  const previousPhase = session.state.phase;
  const next = reduceGame(session.state, command);
  if (previousPhase === "finished" && next.phase === "playing") {
    session.matchId = crypto.randomUUID().replaceAll("-", "");
    session.resultRecorded = false;
  }
  session.state = next;
  session.revision += 1;
  session.updatedAt = nowIso();
  if (room && isPersistentGoRoom(room)) {
    room.lastActiveAt = session.updatedAt;
    room.updatedAt = session.updatedAt;
  }
  if (previousPhase !== "finished" && next.phase === "finished") recordSessionCompletion(state, roomId, session);
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

function toggleDirectPin(state: PlatformState, playerId: string, targetId: string) {
  if (!isAuthenticatedPlayerId(playerId)) throw new Error("개인 메시지 고정은 Google 로그인 후 사용할 수 있습니다.");
  if (playerId === targetId || !state.players[targetId]) throw new Error("고정할 사용자를 찾을 수 없습니다.");
  const pins = new Set(state.pinnedDirects[playerId] ?? []);
  const pinned = !pins.has(targetId);
  if (pinned) pins.add(targetId);
  else pins.delete(targetId);
  state.pinnedDirects[playerId] = [...pins].slice(0, 30);
  return { ok: true, targetId, pinned };
}

async function claimMasterAdmin(state: PlatformState, playerId: string, rawPassword: unknown) {
  requireLogin(playerId);
  const password = cleanText(rawPassword, 64);
  const expected = state.moderation.passwordHash ?? await hashAdminPassword(String(process.env.INITIAL_ADMIN_PASSWORD ?? "1111"));
  if (!password || await hashAdminPassword(password) !== expected) throw new Error("관리자 비밀번호가 맞지 않습니다.");
  const previousMasterId = state.moderation.masterId;
  state.moderation.masterId = playerId;
  state.moderation.passwordHash = expected;
  state.moderation.secondaryAdminIds = state.moderation.secondaryAdminIds.filter((id) => id !== playerId && id !== previousMasterId);
  return { ok: true, transferred: Boolean(previousMasterId && previousMasterId !== playerId), message: "최고관리자 권한이 이 계정으로 이전되었습니다." };
}

async function changeAdminPassword(state: PlatformState, playerId: string, currentRaw: unknown, nextRaw: unknown) {
  requireAdmin(state, playerId, true);
  const current = cleanText(currentRaw, 64);
  const next = cleanText(nextRaw, 64);
  if (next.length < 4) throw new Error("새 비밀번호는 4글자 이상이어야 합니다.");
  const expected = state.moderation.passwordHash ?? await hashAdminPassword(String(process.env.INITIAL_ADMIN_PASSWORD ?? "1111"));
  if (await hashAdminPassword(current) !== expected) throw new Error("현재 관리자 비밀번호가 맞지 않습니다.");
  state.moderation.passwordHash = await hashAdminPassword(next);
  return { ok: true, message: "관리자 비밀번호를 변경했습니다." };
}

function setSecondaryAdmin(state: PlatformState, playerId: string, payload: JsonRecord) {
  requireAdmin(state, playerId, true);
  const targetId = cleanId(payload.targetId);
  requireLogin(targetId);
  if (!state.players[targetId]) throw new Error("플레이어를 찾을 수 없습니다.");
  if (targetId === playerId) throw new Error("최고관리자는 이미 모든 권한을 가지고 있습니다.");
  const enabled = payload.enabled === true;
  const ids = new Set(state.moderation.secondaryAdminIds);
  if (enabled) {
    if (!ids.has(targetId) && ids.size >= MAX_SECONDARY_ADMINS) throw new Error(`일반 관리자는 최대 ${MAX_SECONDARY_ADMINS}명까지 지정할 수 있습니다.`);
    ids.add(targetId);
  }
  else ids.delete(targetId);
  state.moderation.secondaryAdminIds = [...ids].slice(0, MAX_SECONDARY_ADMINS);
  return { ok: true, message: enabled ? "관리자로 지정했습니다." : "관리자 권한을 해제했습니다." };
}

function grantCoins(state: PlatformState, playerId: string, payload: JsonRecord) {
  requireAdmin(state, playerId, true);
  const targetId = cleanId(payload.targetId);
  requireLogin(targetId);
  if (!state.players[targetId]) throw new Error("플레이어를 찾을 수 없습니다.");
  const amount = Math.floor(Number(payload.amount));
  if (!Number.isFinite(amount) || amount < 1 || amount > 100_000) throw new Error("코인은 1~100,000개 사이로 지급해 주세요.");
  const profile = ensureProfile(state, targetId)!;
  profile.coins = Math.min(Number.MAX_SAFE_INTEGER, profile.coins + amount);
  profile.updatedAt = nowIso();
  return { ok: true, message: `${state.players[targetId].nickname}님에게 ${amount.toLocaleString("ko-KR")}코인을 지급했습니다.` };
}

function sendAnnouncement(state: PlatformState, playerId: string, payload: JsonRecord) {
  requireAdmin(state, playerId);
  const body = cleanText(payload.body, 200);
  if (body.length < 2) throw new Error("공지 내용을 2글자 이상 입력해 주세요.");
  const now = Date.now();
  const lastAt = state.moderation.lastAnnouncementAt ? Date.parse(state.moderation.lastAnnouncementAt) : 0;
  const waitMs = ANNOUNCEMENT_COOLDOWN_MS - (now - lastAt);
  if (waitMs > 0) throw new Error(`다음 공지는 ${Math.ceil(waitMs / 1_000)}초 뒤에 보낼 수 있습니다.`);
  const createdAt = nowIso(now);
  state.moderation.announcement = {
    id: crypto.randomUUID().replaceAll("-", ""),
    body,
    issuerId: playerId,
    createdAt,
    expiresAt: nowIso(now + ANNOUNCEMENT_COOLDOWN_MS),
  };
  state.moderation.lastAnnouncementAt = createdAt;
  return { ok: true, message: "서버 공지를 보냈습니다." };
}

function warnPlayer(state: PlatformState, playerId: string, payload: JsonRecord) {
  requireAdmin(state, playerId);
  const targetId = cleanId(payload.targetId);
  const message = cleanText(payload.message, 120);
  if (!state.players[targetId]) throw new Error("플레이어를 찾을 수 없습니다.");
  if (!message) throw new Error("경고 사유를 입력해 주세요.");
  state.moderation.warnings.push({
    id: crypto.randomUUID().replaceAll("-", ""),
    playerId: targetId,
    issuerId: playerId,
    message,
    createdAt: nowIso(),
    acknowledgedAt: null,
  });
  state.moderation.warnings = state.moderation.warnings.slice(-500);
  return { ok: true, message: "플레이어에게 경고를 보냈습니다." };
}

function setPlayerBan(state: PlatformState, playerId: string, payload: JsonRecord) {
  requireAdmin(state, playerId, true);
  const targetId = cleanId(payload.targetId);
  const banned = payload.banned === true;
  if (!state.players[targetId]) throw new Error("플레이어를 찾을 수 없습니다.");
  if (targetId === playerId) throw new Error("자기 계정은 밴할 수 없습니다.");
  if (adminRoleFor(state.moderation, targetId) === "master") throw new Error("최고관리자는 밴할 수 없습니다.");
  if (banned) {
    const reason = cleanText(payload.reason, 120) || "관리자에 의해 이용이 제한되었습니다.";
    state.moderation.bans[targetId] = { playerId: targetId, issuerId: playerId, reason, createdAt: nowIso() };
    state.moderation.secondaryAdminIds = state.moderation.secondaryAdminIds.filter((id) => id !== targetId);
    for (const roomId of Object.keys(state.members)) removeMemberFromRoom(state, targetId, roomId);
  } else delete state.moderation.bans[targetId];
  return { ok: true, message: banned ? "플레이어를 밴했습니다." : "밴을 해제했습니다." };
}

function deleteMessage(state: PlatformState, playerId: string, payload: JsonRecord) {
  requireAdmin(state, playerId);
  const messageId = Math.floor(Number(payload.messageId));
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) throw new Error("메시지를 찾을 수 없습니다.");
  message.body = "";
  message.deletedAt = nowIso();
  message.deletedBy = playerId;
  return { ok: true, message: "채팅을 삭제했습니다." };
}

function acknowledgeWarning(state: PlatformState, playerId: string, payload: JsonRecord) {
  const warningId = cleanText(payload.warningId, 80);
  const warning = state.moderation.warnings.find((item) => item.id === warningId && item.playerId === playerId);
  if (!warning) throw new Error("경고를 찾을 수 없습니다.");
  warning.acknowledgedAt = nowIso();
  return { ok: true };
}

function updateProfile(state: PlatformState, playerId: string, payload: JsonRecord) {
  requireLogin(playerId);
  const profile = ensureProfile(state, playerId)!;
  profile.statusMessage = cleanText(payload.statusMessage, 60);
  const equipped = asRecord(payload.equipped);
  for (const kind of ["badge", "trophy", "background"] as const) {
    const id = cleanText(equipped[kind], 80);
    if (!id) {
      delete profile.equipped[kind];
      continue;
    }
    const cosmetic = cosmeticById(id);
    if (!cosmetic || cosmetic.kind !== kind || !profile.inventoryIds.includes(id)) throw new Error("보유하지 않은 치장품입니다.");
    profile.equipped[kind] = id;
  }
  profile.updatedAt = nowIso();
  return { ok: true, message: "프로필을 저장했습니다." };
}

function purchaseCosmetic(state: PlatformState, playerId: string, payload: JsonRecord) {
  requireLogin(playerId);
  const itemId = cleanText(payload.itemId, 80);
  const item = cosmeticById(itemId);
  if (!item) throw new Error("치장품을 찾을 수 없습니다.");
  const profile = ensureProfile(state, playerId)!;
  if (profile.inventoryIds.includes(itemId)) throw new Error("이미 보유한 치장품입니다.");
  const isMaster = adminRoleFor(state.moderation, playerId) === "master";
  if (!isMaster && profile.coins < item.price) throw new Error("코인이 부족합니다.");
  if (!isMaster) profile.coins -= item.price;
  profile.inventoryIds.push(itemId);
  profile.equipped[item.kind] = itemId;
  profile.updatedAt = nowIso();
  return { ok: true, message: `${item.name}을(를) 구입하고 착용했습니다.` };
}

function submitFeedback(state: PlatformState, playerId: string, payload: JsonRecord) {
  const body = cleanText(payload.body, 500);
  const category = ["bug", "idea", "other"].includes(String(payload.category)) ? String(payload.category) as FeedbackRecord["category"] : "other";
  if (body.length < 4) throw new Error("피드백을 4글자 이상 입력해 주세요.");
  state.feedback.push({ id: crypto.randomUUID().replaceAll("-", ""), playerId, category, body, createdAt: nowIso(), resolvedAt: null });
  state.feedback = state.feedback.slice(-500);
  return { ok: true, message: "피드백을 보냈습니다. 고마워요!" };
}

function resolveFeedback(state: PlatformState, playerId: string, payload: JsonRecord) {
  requireAdmin(state, playerId);
  const feedbackId = cleanText(payload.feedbackId, 80);
  const item = state.feedback.find((feedback) => feedback.id === feedbackId);
  if (!item) throw new Error("피드백을 찾을 수 없습니다.");
  item.resolvedAt = payload.resolved === false ? null : nowIso();
  return { ok: true };
}

export { emptyState };
