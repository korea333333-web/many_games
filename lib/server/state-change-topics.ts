type TopicState = {
  players: Record<string, { nickname: string }>;
  rooms: Record<string, unknown>;
  members: Record<string, unknown>;
  sessions: Record<string, unknown>;
  messages: unknown[];
  rankings?: unknown;
};

function publicPlayerDirectory(state: TopicState) {
  return Object.fromEntries(Object.entries(state.players).map(([id, player]) => [id, player.nickname]));
}

export function getStateChangeTopics(previous: TopicState, next: TopicState) {
  const topics = new Set<string>();
  if (
    JSON.stringify(previous.rooms) !== JSON.stringify(next.rooms)
    || JSON.stringify(previous.members) !== JSON.stringify(next.members)
    || JSON.stringify(previous.messages) !== JSON.stringify(next.messages)
    || JSON.stringify(previous.rankings) !== JSON.stringify(next.rankings)
    || JSON.stringify(publicPlayerDirectory(previous)) !== JSON.stringify(publicPlayerDirectory(next))
  ) topics.add("lobby");

  const roomIds = new Set([
    ...Object.keys(previous.rooms), ...Object.keys(next.rooms),
    ...Object.keys(previous.members), ...Object.keys(next.members),
    ...Object.keys(previous.sessions), ...Object.keys(next.sessions),
  ]);
  for (const roomId of roomIds) {
    const before = { room: previous.rooms[roomId], members: previous.members[roomId], session: previous.sessions[roomId] };
    const after = { room: next.rooms[roomId], members: next.members[roomId], session: next.sessions[roomId] };
    if (JSON.stringify(before) !== JSON.stringify(after)) topics.add(`room:${roomId}`);
  }
  return [...topics];
}
