import { sandboxConfig } from "./config.ts";

export interface CubeSession {
  accessToken: string;
  expiresAt: number;
}

let cached: CubeSession | null = null;

export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 30_000) {
    return cached.accessToken;
  }
  const res = await fetch(`${sandboxConfig.opsUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: sandboxConfig.opsUser, password: sandboxConfig.opsPassword }),
  });
  if (!res.ok) {
    throw new Error(`CubeSandbox login failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken: string; expiresInSecs?: number };
  cached = {
    accessToken: body.accessToken,
    expiresAt: Date.now() + (body.expiresInSecs ?? 900) * 1000,
  };
  return cached.accessToken;
}

export async function cubeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-API-KEY", sandboxConfig.apiKey);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${sandboxConfig.apiUrl.replace(/\/$/, "")}${path}`, { ...init, headers });
}
