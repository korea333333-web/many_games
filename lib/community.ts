import type { GameId } from "./games/catalog.ts";

export type AdminRole = "master" | "admin" | null;
export type CosmeticKind = "badge" | "trophy" | "background";

export type CosmeticItem = {
  id: string;
  name: string;
  description: string;
  kind: CosmeticKind;
  price: number;
  icon: string;
  accent: string;
  gameId?: GameId;
};

export const COSMETIC_CATALOG: CosmeticItem[] = [
  { id: "badge-rookie", name: "첫 발걸음", description: "모든 로그인 계정의 기본 배지", kind: "badge", price: 0, icon: "✦", accent: "#94a3b8" },
  { id: "badge-gomoku", name: "오목 돌", description: "오목판에서 온 흑돌 배지", kind: "badge", price: 60, icon: "●", accent: "#facc15", gameId: "gomoku" },
  { id: "badge-chess", name: "나이트", description: "체스 기사 배지", kind: "badge", price: 90, icon: "♞", accent: "#60a5fa", gameId: "chess" },
  { id: "badge-go", name: "바둑 고수", description: "바둑을 좋아하는 플레이어의 배지", kind: "badge", price: 110, icon: "◎", accent: "#84a98c", gameId: "go" },
  { id: "trophy-bronze", name: "브론즈 트로피", description: "프로필에 놓는 작은 트로피", kind: "trophy", price: 120, icon: "🏆", accent: "#d97706" },
  { id: "trophy-crown", name: "게임 왕관", description: "승부사를 위한 반짝이는 왕관", kind: "trophy", price: 260, icon: "♛", accent: "#facc15" },
  { id: "background-grid", name: "네온 격자", description: "보드게임 판을 닮은 배경", kind: "background", price: 80, icon: "▦", accent: "#2563eb" },
  { id: "background-sunset", name: "승리의 노을", description: "주황빛 그라데이션 배경", kind: "background", price: 140, icon: "◒", accent: "#fb7185" },
  { id: "background-galaxy", name: "게임 은하", description: "별이 흐르는 최고급 배경", kind: "background", price: 240, icon: "✧", accent: "#8b5cf6" },
];

export type ProfileRecord = {
  statusMessage: string;
  coins: number;
  inventoryIds: string[];
  equipped: Partial<Record<CosmeticKind, string>>;
  updatedAt: string;
};

export type WarningRecord = {
  id: string;
  playerId: string;
  issuerId: string;
  message: string;
  createdAt: string;
  acknowledgedAt: string | null;
};

export type BanRecord = {
  playerId: string;
  issuerId: string;
  reason: string;
  createdAt: string;
};

export type ModerationState = {
  passwordHash: string | null;
  masterId: string | null;
  secondaryAdminIds: string[];
  warnings: WarningRecord[];
  bans: Record<string, BanRecord>;
};

export type FeedbackRecord = {
  id: string;
  playerId: string;
  category: "bug" | "idea" | "other";
  body: string;
  createdAt: string;
  resolvedAt: string | null;
};

const COSMETIC_IDS = new Set(COSMETIC_CATALOG.map((item) => item.id));

function sourceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function emptyModerationState(): ModerationState {
  return { passwordHash: null, masterId: null, secondaryAdminIds: [], warnings: [], bans: {} };
}

export function normalizeModerationState(value: unknown): ModerationState {
  const source = sourceRecord(value);
  const bans: Record<string, BanRecord> = {};
  for (const [playerId, raw] of Object.entries(sourceRecord(source.bans))) {
    const item = sourceRecord(raw);
    if (typeof item.reason !== "string" || typeof item.issuerId !== "string") continue;
    bans[playerId] = {
      playerId,
      issuerId: item.issuerId,
      reason: item.reason.slice(0, 120),
      createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date(0).toISOString(),
    };
  }
  return {
    passwordHash: typeof source.passwordHash === "string" ? source.passwordHash : null,
    masterId: typeof source.masterId === "string" ? source.masterId : null,
    secondaryAdminIds: Array.isArray(source.secondaryAdminIds)
      ? [...new Set(source.secondaryAdminIds.filter((id): id is string => typeof id === "string"))].slice(0, 30)
      : [],
    warnings: Array.isArray(source.warnings) ? source.warnings.flatMap((raw) => {
      const item = sourceRecord(raw);
      if (typeof item.id !== "string" || typeof item.playerId !== "string" || typeof item.issuerId !== "string" || typeof item.message !== "string") return [];
      return [{
        id: item.id,
        playerId: item.playerId,
        issuerId: item.issuerId,
        message: item.message.slice(0, 120),
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date(0).toISOString(),
        acknowledgedAt: typeof item.acknowledgedAt === "string" ? item.acknowledgedAt : null,
      } satisfies WarningRecord];
    }).slice(-500) : [],
    bans,
  };
}

export function normalizeProfiles(value: unknown): Record<string, ProfileRecord> {
  const profiles: Record<string, ProfileRecord> = {};
  for (const [playerId, raw] of Object.entries(sourceRecord(value))) {
    const item = sourceRecord(raw);
    const inventoryIds = Array.isArray(item.inventoryIds)
      ? [...new Set(item.inventoryIds.filter((id): id is string => typeof id === "string" && COSMETIC_IDS.has(id)))]
      : [];
    if (!inventoryIds.includes("badge-rookie")) inventoryIds.unshift("badge-rookie");
    const rawEquipped = sourceRecord(item.equipped);
    const equipped: ProfileRecord["equipped"] = {};
    for (const kind of ["badge", "trophy", "background"] as const) {
      const id = rawEquipped[kind];
      if (typeof id === "string" && inventoryIds.includes(id) && COSMETIC_CATALOG.some((cosmetic) => cosmetic.id === id && cosmetic.kind === kind)) equipped[kind] = id;
    }
    profiles[playerId] = {
      statusMessage: typeof item.statusMessage === "string" ? item.statusMessage.slice(0, 60) : "",
      coins: Math.max(0, Math.floor(Number(item.coins) || 0)),
      inventoryIds,
      equipped: { badge: equipped.badge ?? "badge-rookie", ...equipped },
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date(0).toISOString(),
    };
  }
  return profiles;
}

export function createDefaultProfile(now: string): ProfileRecord {
  return { statusMessage: "", coins: 0, inventoryIds: ["badge-rookie"], equipped: { badge: "badge-rookie" }, updatedAt: now };
}

export function adminRoleFor(state: ModerationState, playerId: string): AdminRole {
  if (state.masterId === playerId) return "master";
  return state.secondaryAdminIds.includes(playerId) ? "admin" : null;
}

export function cosmeticById(id: string) {
  return COSMETIC_CATALOG.find((item) => item.id === id);
}
