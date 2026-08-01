import * as store from "@piclaw-cloud/store";
import { getObjectStorage } from "../storage/object-storage.ts";

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
]);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function normalizeContentType(value: string | undefined, fallback?: string): string {
  const type = (value || fallback || "application/octet-stream").toLowerCase();
  return type || "application/octet-stream";
}

export async function handleMediaRoutes(
  req: Request,
  pathname: string,
  userId = "default-user",
): Promise<Response | null> {
  if (req.method === "POST" && pathname === "/media/upload") {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: "Invalid form data" }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "Missing file" }, 400);
    if (file.size > MAX_UPLOAD_BYTES) {
      return json({ error: `File too large (max ${MAX_UPLOAD_BYTES} bytes)` }, 413);
    }
    const data = new Uint8Array(await file.arrayBuffer());
    const contentType = normalizeContentType(file.type, undefined);
    const objectKey = `media/${encodeURIComponent(userId)}/${crypto.randomUUID()}/${encodeURIComponent(file.name || "upload.bin")}`;
    const storage = getObjectStorage();
    await storage.put(objectKey, data, contentType);
    const id = await store.createMedia({
      userId,
      filename: file.name || "upload.bin",
      contentType,
      objectKey,
      objectSize: data.byteLength,
      metadata: { storage_backend: "object", object_key: objectKey },
    });
    const info = await store.getMediaInfoByIdForUser(id, userId);
    return json({
      id,
      filename: info?.filename ?? file.name,
      content_type: info?.content_type ?? contentType,
      size: info?.size ?? data.byteLength,
      url: `/media/${id}`,
      thumbnail_url: info?.has_thumbnail ? `/media/${id}/thumbnail` : null,
    });
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "media" || !parts[1]) return null;
  const id = Number(parts[1]);
  if (!Number.isFinite(id)) return json({ error: "Invalid media id" }, 400);

  if (req.method === "GET" && parts.length === 2) {
    const row = await store.getMediaByIdForUser(id, userId);
    if (!row) return json({ error: "Media not found" }, 404);
    const headers: Record<string, string> = { "Content-Type": row.content_type };
    if (!INLINE_SAFE_TYPES.has(row.content_type)) {
      headers["Content-Disposition"] = "attachment";
    }
    if (!row.object_key) return json({ error: "Media object not found" }, 404);
    let data: Uint8Array;
    try {
      data = await getObjectStorage().get(row.object_key);
    } catch {
      return json({ error: "Media object not found" }, 404);
    }
    return new Response(Buffer.from(data), { status: 200, headers });
  }

  if (req.method === "GET" && parts[2] === "thumbnail") {
    const row = await store.getMediaByIdForUser(id, userId);
    if (!row?.thumbnail_object_key) return json({ error: "Thumbnail not found" }, 404);
    let thumbnail: Uint8Array;
    try {
      thumbnail = await getObjectStorage().get(row.thumbnail_object_key);
    } catch {
      return json({ error: "Thumbnail not found" }, 404);
    }
    return new Response(Buffer.from(thumbnail), {
      status: 200,
      headers: { "Content-Type": "image/jpeg" },
    });
  }

  if (req.method === "GET" && parts[2] === "info") {
    const info = await store.getMediaInfoByIdForUser(id, userId);
    if (!info) return json({ error: "Media not found" }, 404);
    return json(info);
  }

  return null;
}
