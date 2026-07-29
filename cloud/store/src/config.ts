/** Store layer configuration. */
export const storeConfig = {
  pgUrl:
    process.env.CLOUD_PG_URL ||
    process.env.POC_PG_URL ||
    "postgres://sensecraft:sensecraft@localhost:25432/piclaw_cloud_poc",
};

/** Advisory lock namespace — do not collide with other apps on shared PG. */
export const LOCK_NAMESPACE = 91525;
