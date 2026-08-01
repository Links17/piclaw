import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { getCloudConfig } from "@piclaw-cloud/shared/cloud-config";

export interface ObjectStorage {
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export type ObjectStorageOptions =
  | { backend: "local"; localDir: string }
  | { backend: "cos"; localDir: string };

function assertKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error(`Invalid object key: ${key}`);
  }
  return normalized;
}

function localStorage(root: string): ObjectStorage {
  const absoluteRoot = resolve(root);
  const pathFor = (key: string) => {
    const normalized = assertKey(key);
    const path = resolve(absoluteRoot, normalized);
    if (relative(absoluteRoot, path).startsWith("..")) throw new Error(`Invalid object key: ${key}`);
    return path;
  };
  return {
    async put(key, data) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    },
    async get(key) {
      return new Uint8Array(await readFile(pathFor(key)));
    },
    async exists(key) {
      try {
        await stat(pathFor(key));
        return true;
      } catch {
        return false;
      }
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

export function createObjectStorage(options: ObjectStorageOptions): ObjectStorage {
  if (options.backend === "local") return localStorage(options.localDir);
  return {
    async put() {
      throw new Error("COS object storage is configured but no COS client is available");
    },
    async get() {
      throw new Error("COS object storage is configured but no COS client is available");
    },
    async exists() {
      throw new Error("COS object storage is configured but no COS client is available");
    },
    async delete() {
      throw new Error("COS object storage is configured but no COS client is available");
    },
  };
}

export function getObjectStorage(): ObjectStorage {
  const storage = getCloudConfig().storage;
  return createObjectStorage({
    backend: storage.backend,
    localDir: storage.localDir,
  });
}
