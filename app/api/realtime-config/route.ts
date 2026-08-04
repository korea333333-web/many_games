const DEFAULT_SUPABASE_URL = "https://stusvfgazqxieybufdlc.supabase.co";
// Publishable keys identify the project in browser clients; RLS and the protected API enforce data access.
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Qdumvzg4LKRakWqNRD-W2A_KaAhAoTF";

export const dynamic = "force-dynamic";

export function GET() {
  const url = String(process.env.SUPABASE_URL ?? DEFAULT_SUPABASE_URL).replace(/\/$/, "");
  const key = String(
    process.env.SUPABASE_PUBLISHABLE_KEY
    ?? process.env.SUPABASE_ANON_KEY
    ?? DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  );

  return Response.json(
    { url, key },
    { headers: { "cache-control": "public, max-age=300, s-maxage=3600" } },
  );
}
