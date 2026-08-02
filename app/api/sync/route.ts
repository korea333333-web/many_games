import { executeCommand, getSnapshot, touchPlayer } from "@/lib/server/platform-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const playerId = url.searchParams.get("playerId");
    const nickname = url.searchParams.get("nickname");
    const roomId = url.searchParams.get("roomId");
    if (playerId) await touchPlayer(playerId, nickname);
    return Response.json(await getSnapshot(playerId, roomId));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "서버 오류" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    return Response.json(await executeCommand(body));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "서버 오류" }, { status: 400 });
  }
}
