import * as store from "@piclaw-cloud/store";
import { config } from "../config.ts";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function keychainEncryptionKey(): string {
  return config.devApiKey || "piclaw-cloud-keychain-dev";
}

export async function handleKeychainRoutes(
  req: Request,
  pathname: string,
  userId: string,
): Promise<Response | null> {
  if (!pathname.startsWith("/agent/keychain")) return null;
  const encryptionKey = keychainEncryptionKey();

  if (req.method === "GET" && pathname === "/agent/keychain") {
    const entries = await store.listKeychainEntries(userId);
    return json({ ok: true, entries });
  }

  if (req.method === "POST" && pathname === "/agent/keychain") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const secret = typeof body.secret === "string" ? body.secret : "";
    if (!name || !secret) return json({ error: "Provide name and secret." }, 400);
    const type = (["token", "password", "basic", "secret"] as const).includes(body.type as store.KeychainEntryType)
      ? body.type as store.KeychainEntryType
      : "secret";
    await store.setKeychainEntry({
      name,
      type,
      secret,
      username: typeof body.username === "string" ? body.username.trim() : undefined,
      userNote: typeof body.userNote === "string" ? body.userNote : undefined,
      agentNote: typeof body.agentNote === "string" ? body.agentNote : undefined,
    }, userId, encryptionKey);
    return json({ ok: true, name, type });
  }

  if (req.method === "DELETE" && pathname === "/agent/keychain") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return json({ error: "Provide name." }, 400);
    const removed = await store.deleteKeychainEntry(name, userId);
    return json({ ok: true, removed });
  }

  if (req.method === "POST" && pathname === "/agent/keychain/notes") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return json({ error: "Provide name." }, 400);
    const updated = await store.updateKeychainNotes(name, {
      userNote: typeof body.userNote === "string" ? body.userNote : undefined,
      agentNote: typeof body.agentNote === "string" ? body.agentNote : undefined,
    }, userId);
    if (!updated) return json({ error: "Entry not found." }, 404);
    return json({ ok: true });
  }

  if (req.method === "POST" && pathname === "/agent/keychain/reveal") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return json({ error: "Provide name." }, 400);
    const secret = await store.revealKeychainSecret(name, userId, encryptionKey);
    if (secret == null) return json({ error: "Entry not found." }, 404);
    return json({ ok: true, name, secret });
  }

  return json({ error: "Not found" }, 404);
}
