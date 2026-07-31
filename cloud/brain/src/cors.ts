import { config } from "./config.ts";

function parseAllowedOrigins(): string[] {
  const raw = config.webAllowedOrigins;
  if (!raw || raw.length === 0) return [];
  return raw.map((entry) => entry.trim()).filter(Boolean);
}

function isOriginAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin) return false;
  if (allowed.includes("*")) return true;
  return allowed.some((entry) => entry === origin);
}

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin || !isOriginAllowed(origin, allowed)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

export function applyCors(req: Request, response: Response): Response {
  const allowed = parseAllowedOrigins();
  if (allowed.length === 0) return response;
  const origin = req.headers.get("Origin");
  const headers = corsHeaders(origin, allowed);
  if (Object.keys(headers).length === 0) return response;
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) {
    next.headers.set(key, value);
  }
  const existing = response.headers.get("Access-Control-Allow-Methods");
  if (!existing) {
    next.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  }
  const allowHeaders = response.headers.get("Access-Control-Allow-Headers");
  if (!allowHeaders) {
    next.headers.set(
      "Access-Control-Allow-Headers",
      req.headers.get("Access-Control-Request-Headers") || "Content-Type, Authorization, X-Api-Key",
    );
  }
  if (req.method === "GET" && response.headers.get("Content-Type")?.includes("text/event-stream")) {
    next.headers.set("Access-Control-Expose-Headers", "Content-Type");
  }
  return next;
}

export function handleCorsPreflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  const allowed = parseAllowedOrigins();
  if (allowed.length === 0) return null;
  const origin = req.headers.get("Origin");
  const headers = corsHeaders(origin, allowed);
  if (Object.keys(headers).length === 0) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": req.headers.get("Access-Control-Request-Headers") || "Content-Type, Authorization, X-Api-Key",
      "Access-Control-Max-Age": "86400",
    },
  });
}
