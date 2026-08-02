import { createRemoteJWKSet, jwtVerify } from "npm:jose@6.1.2";

const EXPECTED_SECRET_HASH = "0503285db5590fed55dd835119631b154544245ae3f13d6c55b1d40b2c67716a";
const MAX_STATE_BYTES = 2_000_000;
const VERCEL_TEAM_SLUG = "kikuke-s-projects";
const VERCEL_TEAM_ID = "team_8ctYtJQF3KxopktXrB1MPCip";
const VERCEL_PROJECT_ID = "prj_Lf3GgTgoKLZxGNXgmSMdwceymu8h";
const VERCEL_PROJECT_NAME = "many-games";
const VERCEL_AUDIENCE = `https://vercel.com/${VERCEL_TEAM_SLUG}`;
const VERCEL_TEAM_ISSUER = `https://oidc.vercel.com/${VERCEL_TEAM_SLUG}`;
const VERCEL_GLOBAL_ISSUER = "https://oidc.vercel.com";
const TEAM_JWKS = createRemoteJWKSet(new URL(`${VERCEL_TEAM_ISSUER}/.well-known/jwks`));
const GLOBAL_JWKS = createRemoteJWKSet(new URL(`${VERCEL_GLOBAL_ISSUER}/.well-known/jwks`));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function hasValidVercelIdentity(token: string) {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, TEAM_JWKS, {
      issuer: VERCEL_TEAM_ISSUER,
      audience: VERCEL_AUDIENCE,
    }));
  } catch {
    try {
      ({ payload } = await jwtVerify(token, GLOBAL_JWKS, {
        issuer: VERCEL_GLOBAL_ISSUER,
        audience: VERCEL_AUDIENCE,
      }));
    } catch {
      return false;
    }
  }
  return payload.owner === VERCEL_TEAM_SLUG
    && payload.owner_id === VERCEL_TEAM_ID
    && payload.project === VERCEL_PROJECT_NAME
    && payload.project_id === VERCEL_PROJECT_ID
    && (payload.environment === "production" || payload.environment === "preview");
}

async function isAuthorized(request: Request) {
  const suppliedSecret = request.headers.get("x-game-state-secret") ?? "";
  if (suppliedSecret && safeEqual(await sha256(suppliedSecret), EXPECTED_SECRET_HASH)) return true;
  const oidcToken = request.headers.get("x-vercel-oidc-token") ?? "";
  return oidcToken ? hasValidVercelIdentity(oidcToken) : false;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!await isAuthorized(request)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server configuration error" }, 500);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const headers = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
  };

  if (body.action === "read") {
    const query = new URLSearchParams({ select: "revision,data", id: "eq.global", limit: "1" });
    const response = await fetch(`${supabaseUrl}/rest/v1/game_platform_state?${query}`, {
      headers,
      cache: "no-store",
    });
    if (!response.ok) return json({ error: "State read failed" }, 502);
    const rows = await response.json() as Array<{ revision: number; data: unknown }>;
    return rows[0] ? json(rows[0]) : json({ error: "State is not initialized" }, 500);
  }

  if (body.action === "cas") {
    const expectedRevision = Number(body.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return json({ error: "Invalid revision" }, 400);
    }
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
      return json({ error: "Invalid state" }, 400);
    }
    const serialized = JSON.stringify(body.data);
    if (new TextEncoder().encode(serialized).byteLength > MAX_STATE_BYTES) {
      return json({ error: "State is too large" }, 413);
    }

    const query = new URLSearchParams({ id: "eq.global", revision: `eq.${expectedRevision}` });
    const response = await fetch(`${supabaseUrl}/rest/v1/game_platform_state?${query}`, {
      method: "PATCH",
      headers: { ...headers, prefer: "return=representation" },
      body: JSON.stringify({
        revision: expectedRevision + 1,
        data: body.data,
        updated_at: new Date().toISOString(),
      }),
      cache: "no-store",
    });
    if (!response.ok) return json({ error: "State update failed" }, 502);
    const rows = await response.json() as Array<{ revision: number }>;
    return json({ updated: rows.length > 0 });
  }

  return json({ error: "Unknown action" }, 400);
});
