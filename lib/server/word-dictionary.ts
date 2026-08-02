import { env } from "cloudflare:workers";
import { WORD_CHAIN_WORDS } from "../games/word-bank.ts";

function normalizeWord(value: unknown) {
  return String(value ?? "").normalize("NFC").replace(/[^가-힣]/g, "").trim();
}

export async function isKnownWord(value: unknown) {
  const word = normalizeWord(value);
  if (word.length < 2) return false;
  if (WORD_CHAIN_WORDS.has(word)) return true;

  const bindings = env as Record<string, unknown>;
  const baseUrl = String(bindings.SUPABASE_URL ?? "").replace(/\/$/, "");
  const anonKey = String(bindings.SUPABASE_ANON_KEY ?? "");
  if (!baseUrl || !anonKey) return false;

  try {
    const query = new URLSearchParams({ select: "word", word: `eq.${word}`, limit: "1" });
    const headers: Record<string, string> = { apikey: anonKey };
    if (anonKey.split(".").length === 3) headers.authorization = `Bearer ${anonKey}`;
    const response = await fetch(`${baseUrl}/rest/v1/word_dictionary?${query}`, {
      headers,
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const rows = await response.json() as Array<{ word: string }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}
