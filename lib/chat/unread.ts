type MessageMarker = { id: number; senderId: string };

export function latestMessageId(messages: MessageMarker[]) {
  return messages.reduce((latest, message) => Math.max(latest, message.id), 0);
}

export function hasUnreadMessage(messages: MessageMarker[], lastSeenId: number | null, viewerId: string) {
  return lastSeenId !== null && messages.some((message) => message.id > lastSeenId && message.senderId !== viewerId);
}
