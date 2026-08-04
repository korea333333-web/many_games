import type { SupabaseClient } from "@supabase/supabase-js";

let clientPromise: Promise<SupabaseClient> | null = null;

export function getRealtimeClient() {
  if (!clientPromise) {
    const configPromise = fetch("/api/realtime-config")
      .then(async (response) => {
        const config = await response.json() as { url?: string; key?: string; error?: string };
        if (!response.ok || !config.url || !config.key) throw new Error(config.error || "실시간 연결 설정을 읽지 못했습니다.");
        return { url: config.url, key: config.key };
      });
    clientPromise = Promise.all([configPromise, import("@supabase/supabase-js")])
      .then(([config, { createClient }]) => createClient(config.url, config.key, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          realtime: { params: { eventsPerSecond: 10 } },
        }))
      .catch((error) => {
        clientPromise = null;
        throw error;
      });
  }
  return clientPromise;
}
