export const GO_INACTIVE_EXPIRY_MS = 24 * 60 * 60_000;

export function canJoinPersistentGoRoom(reservedPlayerIds: string[], playerId: string) {
  return reservedPlayerIds.includes(playerId) || reservedPlayerIds.length < 2;
}

export function latestGoActivityAt(currentAt: string | undefined, candidateAt: string) {
  const currentTime = currentAt ? Date.parse(currentAt) : Number.NaN;
  const candidateTime = Date.parse(candidateAt);
  if (!Number.isFinite(candidateTime)) return currentAt ?? candidateAt;
  return Number.isFinite(currentTime) && currentTime >= candidateTime ? currentAt! : candidateAt;
}

export function isPersistentGoRoomExpired(
  room: { lastActiveAt?: string; updatedAt: string; createdAt: string },
  liveMemberCount: number,
  now = Date.now(),
) {
  if (liveMemberCount > 0) return false;
  const lastActive = Date.parse(room.lastActiveAt ?? room.updatedAt ?? room.createdAt);
  return Number.isFinite(lastActive) && now - lastActive >= GO_INACTIVE_EXPIRY_MS;
}
