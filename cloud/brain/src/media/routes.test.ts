import { beforeEach, describe, expect, mock, test } from "bun:test";

const createMediaRoute = mock(async () => 42);
const getMediaById = mock(async () => ({
  id: 42,
  user_id: "default-user",
  filename: "demo.bin",
  content_type: "application/octet-stream",
  object_key: "media/default-user/42/demo.bin",
  data: undefined,
  thumbnail_object_key: null,
  metadata: null,
  created_at: "2026-01-01T00:00:00.000Z",
}));
const getMediaInfoById = mock(async () => ({
  id: 42,
  filename: "demo.bin",
  content_type: "application/octet-stream",
  size: 4,
  has_thumbnail: false,
  created_at: "2026-01-01T00:00:00.000Z",
}));
const readMediaObject = mock(async () => new Uint8Array([1, 2, 3, 4]));

mock.module("@piclaw-cloud/store", () => ({
  createMedia: createMediaRoute,
  getMediaByIdForUser: getMediaById,
  getMediaInfoByIdForUser: getMediaInfoById,
}));

mock.module("../storage/object-storage.ts", () => ({
  getObjectStorage: () => ({ put: mock(async () => {}), get: readMediaObject }),
}));

describe("media object storage routes", () => {
  beforeEach(() => {
    createMediaRoute.mockClear();
    getMediaById.mockClear();
    getMediaInfoById.mockClear();
    readMediaObject.mockClear();
  });

  test("uploads media metadata and serves its backend object", async () => {
    const { handleMediaRoutes } = await import("./routes.ts");
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "demo.bin", { type: "application/octet-stream" }));

    const upload = await handleMediaRoutes(
      new Request("http://brain.test/media/upload", { method: "POST", body: form }),
      "/media/upload",
      "default-user",
    );
    const download = await handleMediaRoutes(
      new Request("http://brain.test/media/42"),
      "/media/42",
      "default-user",
    );

    expect(createMediaRoute).toHaveBeenCalledWith(expect.objectContaining({
      filename: "demo.bin",
      objectKey: expect.stringContaining("media/default-user/"),
      objectSize: 4,
      metadata: expect.objectContaining({ storage_backend: "object" }),
    }));
    const storedMedia = (createMediaRoute as unknown as {
      mock: { calls: Array<[Record<string, unknown>]> };
    }).mock.calls[0]?.[0];
    expect(storedMedia).not.toHaveProperty("data");
    expect(storedMedia).not.toHaveProperty("thumbnail");
    expect(upload?.status).toBe(200);
    expect(await download?.bytes()).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(readMediaObject).toHaveBeenCalledWith("media/default-user/42/demo.bin");
  });
});
