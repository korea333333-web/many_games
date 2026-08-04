import { createClient } from "@supabase/supabase-js";

const DEFAULT_SUPABASE_URL = "https://uhvjxyenxqqgyjwihhlc.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_hcZh8ZTVeqnyBQVphaspnQ_AIx1_5lX";

export class AuthenticationError extends Error {}

function claimedPlayerId(value: unknown) {
  return String(value ?? "");
}

export async function resolvePlayerId(request: Request, claimedValue: unknown) {
  const claimed = claimedPlayerId(claimedValue);
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    if (claimed.startsWith("user_")) throw new AuthenticationError("로그인이 만료되었습니다. 다시 로그인해 주세요.");
    return claimed;
  }

  const url = String(process.env.SUPABASE_URL ?? DEFAULT_SUPABASE_URL).replace(/\/$/, "");
  const key = String(
    process.env.SUPABASE_PUBLISHABLE_KEY
    ?? process.env.SUPABASE_ANON_KEY
    ?? DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  );
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabase.auth.getClaims(token);
  const subject = data?.claims.sub;
  if (error || typeof subject !== "string" || !subject) {
    throw new AuthenticationError("로그인이 만료되었습니다. 다시 로그인해 주세요.");
  }

  return `user_${subject.replaceAll("-", "")}`;
}
