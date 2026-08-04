import { GAME_CATALOG, type GameId } from "./games/catalog.ts";

export const RANKED_GAME_IDS = ["gomoku", "connect-four", "chess"] as const satisfies readonly GameId[];
export type RankedGameId = typeof RANKED_GAME_IDS[number];

export type GameRecord = {
  played: number;
  wins: number;
  losses: number;
  draws: number;
};

export type RankedGameRecord = GameRecord & {
  rating: number;
};

export type PlayerCareer = {
  playerId: string;
  games: Partial<Record<GameId, GameRecord>>;
  ranked: Partial<Record<RankedGameId, RankedGameRecord>>;
  updatedAt: string;
};

export type RankingState = {
  players: Record<string, PlayerCareer>;
  recordedMatches: string[];
};

export type LeaderboardEntry = {
  playerId: string;
  nickname: string;
  total: GameRecord;
  games: Partial<Record<GameId, GameRecord>>;
  ranked: Partial<Record<RankedGameId, RankedGameRecord>>;
};

export type CompletedMatch = {
  matchId: string;
  gameId: GameId;
  playerIds: string[];
  winnerIds: string[];
  ranked: boolean;
  completedAt: string;
};

const GAME_IDS = new Set<GameId>(GAME_CATALOG.map((game) => game.id));
const RANKED_IDS = new Set<GameId>(RANKED_GAME_IDS);
const INITIAL_RATING = 1_000;
const MAX_RECORDED_MATCHES = 1_500;

function cleanCount(value: unknown) {
  const count = Math.floor(Number(value) || 0);
  return Math.max(0, count);
}

function normalizeGameRecord(value: unknown): GameRecord {
  const source = value && typeof value === "object" ? value as Partial<GameRecord> : {};
  return {
    played: cleanCount(source.played),
    wins: cleanCount(source.wins),
    losses: cleanCount(source.losses),
    draws: cleanCount(source.draws),
  };
}

function normalizeRankedRecord(value: unknown): RankedGameRecord {
  const source = value && typeof value === "object" ? value as Partial<RankedGameRecord> : {};
  return {
    ...normalizeGameRecord(source),
    rating: Math.max(100, Math.floor(Number(source.rating) || INITIAL_RATING)),
  };
}

export function emptyRankingState(): RankingState {
  return { players: {}, recordedMatches: [] };
}

export function normalizeRankingState(value: unknown): RankingState {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<RankingState>
    : {};
  const rawPlayers = source.players && typeof source.players === "object" && !Array.isArray(source.players)
    ? source.players
    : {};
  const players: Record<string, PlayerCareer> = {};

  for (const [playerId, rawCareer] of Object.entries(rawPlayers)) {
    if (!isAuthenticatedPlayerId(playerId) || !rawCareer || typeof rawCareer !== "object") continue;
    const career = rawCareer as Partial<PlayerCareer>;
    const games: Partial<Record<GameId, GameRecord>> = {};
    const ranked: Partial<Record<RankedGameId, RankedGameRecord>> = {};
    for (const [gameId, record] of Object.entries(career.games ?? {})) {
      if (GAME_IDS.has(gameId as GameId)) games[gameId as GameId] = normalizeGameRecord(record);
    }
    for (const [gameId, record] of Object.entries(career.ranked ?? {})) {
      if (RANKED_IDS.has(gameId as GameId)) ranked[gameId as RankedGameId] = normalizeRankedRecord(record);
    }
    players[playerId] = {
      playerId,
      games,
      ranked,
      updatedAt: typeof career.updatedAt === "string" ? career.updatedAt : new Date(0).toISOString(),
    };
  }

  return {
    players,
    recordedMatches: Array.isArray(source.recordedMatches)
      ? source.recordedMatches.filter((id): id is string => typeof id === "string").slice(-MAX_RECORDED_MATCHES)
      : [],
  };
}

export function isAuthenticatedPlayerId(playerId: string) {
  return /^user_[a-fA-F0-9]{32}$/.test(playerId);
}

export function isRankedGame(gameId: GameId): gameId is RankedGameId {
  return RANKED_IDS.has(gameId);
}

function ensureCareer(state: RankingState, playerId: string, completedAt: string) {
  state.players[playerId] ??= { playerId, games: {}, ranked: {}, updatedAt: completedAt };
  return state.players[playerId];
}

function applyOutcome(record: GameRecord, won: boolean, draw: boolean) {
  record.played += 1;
  if (draw) record.draws += 1;
  else if (won) record.wins += 1;
  else record.losses += 1;
}

function expectedScore(rating: number, opponentRating: number) {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

export function recordCompletedMatch(state: RankingState, match: CompletedMatch) {
  if (!match.matchId || state.recordedMatches.includes(match.matchId) || match.playerIds.length < 2) return false;
  const authenticatedPlayers = match.playerIds.filter(isAuthenticatedPlayerId);
  if (!authenticatedPlayers.length) return false;
  const winnerSet = new Set(match.winnerIds);
  const draw = match.winnerIds.length === 0;

  for (const playerId of authenticatedPlayers) {
    const career = ensureCareer(state, playerId, match.completedAt);
    const record = career.games[match.gameId] ?? { played: 0, wins: 0, losses: 0, draws: 0 };
    applyOutcome(record, winnerSet.has(playerId), draw);
    career.games[match.gameId] = record;
    career.updatedAt = match.completedAt;
  }

  if (match.ranked && isRankedGame(match.gameId) && match.playerIds.length === 2 && authenticatedPlayers.length === 2) {
    const [firstId, secondId] = match.playerIds;
    const firstCareer = ensureCareer(state, firstId, match.completedAt);
    const secondCareer = ensureCareer(state, secondId, match.completedAt);
    const first = firstCareer.ranked[match.gameId] ?? { played: 0, wins: 0, losses: 0, draws: 0, rating: INITIAL_RATING };
    const second = secondCareer.ranked[match.gameId] ?? { played: 0, wins: 0, losses: 0, draws: 0, rating: INITIAL_RATING };
    const firstActual = draw ? 0.5 : winnerSet.has(firstId) ? 1 : 0;
    const secondActual = draw ? 0.5 : winnerSet.has(secondId) ? 1 : 0;
    const firstDelta = Math.round(32 * (firstActual - expectedScore(first.rating, second.rating)));
    const secondDelta = Math.round(32 * (secondActual - expectedScore(second.rating, first.rating)));
    applyOutcome(first, firstActual === 1, draw);
    applyOutcome(second, secondActual === 1, draw);
    first.rating = Math.max(100, first.rating + firstDelta);
    second.rating = Math.max(100, second.rating + secondDelta);
    firstCareer.ranked[match.gameId] = first;
    secondCareer.ranked[match.gameId] = second;
  }

  state.recordedMatches.push(match.matchId);
  if (state.recordedMatches.length > MAX_RECORDED_MATCHES) {
    state.recordedMatches = state.recordedMatches.slice(-MAX_RECORDED_MATCHES);
  }
  return true;
}

function totalRecord(games: PlayerCareer["games"]): GameRecord {
  return Object.values(games).reduce<GameRecord>((total, record) => ({
    played: total.played + record.played,
    wins: total.wins + record.wins,
    losses: total.losses + record.losses,
    draws: total.draws + record.draws,
  }), { played: 0, wins: 0, losses: 0, draws: 0 });
}

export function buildLeaderboard(state: RankingState, nicknameFor: (playerId: string) => string): LeaderboardEntry[] {
  return Object.values(state.players)
    .map((career) => ({
      playerId: career.playerId,
      nickname: nicknameFor(career.playerId),
      total: totalRecord(career.games),
      games: career.games,
      ranked: career.ranked,
    }))
    .filter((entry) => entry.total.played > 0)
    .sort((left, right) => right.total.wins - left.total.wins
      || right.total.played - left.total.played
      || left.nickname.localeCompare(right.nickname, "ko"))
    .slice(0, 100);
}

export function rankTier(rating: number) {
  if (rating >= 1_600) return "다이아";
  if (rating >= 1_400) return "플래티넘";
  if (rating >= 1_200) return "골드";
  if (rating >= 1_000) return "실버";
  return "브론즈";
}
