import { getCloudConfig } from "@piclaw-cloud/shared/cloud-config";

/** Store layer configuration. */
export const storeConfig = {
  pgUrl: getCloudConfig().pg.url,
};

/** Advisory lock namespace — do not collide with other apps on shared PG. */
export const LOCK_NAMESPACE = 91525;
