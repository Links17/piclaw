/**
 * Stamp cache-buster query strings in cloud/web static index.html.
 */
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const INDEX = resolve(WEB_ROOT, "static/classic/index.html");
const CLASSIC_DIST = resolve(WEB_ROOT, "static/classic/dist");
const COMMON_DIST = resolve(WEB_ROOT, "static/common/dist");

function computeBundleContentHash(): string {
  const bundleFiles = [
    resolve(CLASSIC_DIST, "app.bundle.js"),
    resolve(CLASSIC_DIST, "app.bundle.css"),
    resolve(CLASSIC_DIST, "editor.bundle.js"),
    resolve(COMMON_DIST, "login.bundle.js"),
    resolve(COMMON_DIST, "login.bundle.css"),
  ];
  const hash = createHash("sha256");
  for (const file of bundleFiles) {
    try {
      hash.update(readFileSync(file));
    } catch (e) {
      if (existsSync(file)) {
        console.warn(`[cache-buster] failed to read ${file}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return hash.digest("hex").slice(0, 12);
}

const stamp = computeBundleContentHash();

const original = readFileSync(INDEX, "utf-8");
let html = original;

html = html.replace(/\?v=(?:[\da-f]+|__APP_ASSET_VERSION__)/g, `?v=${stamp}`);

const VENDOR_META = resolve(WEB_ROOT, "extensions/viewers/editor/vendor/codemirror.meta.json");
let vendorStamp = stamp;
try {
  if (existsSync(VENDOR_META)) {
    const meta = JSON.parse(readFileSync(VENDOR_META, "utf-8"));
    if (meta.sha256) vendorStamp = meta.sha256.slice(0, 12);
  }
} catch (e) {
  console.warn(`[cache-buster] failed to read vendor metadata: ${e instanceof Error ? e.message : e}`);
}
html = html.replace(
  /(\/editor-vendor\/codemirror\.js)(\?v=[^"]*)?/g,
  `$1?v=${vendorStamp}`,
);

if (html !== original) {
  writeFileSync(INDEX, html, "utf-8");
  console.log(`[cache-buster] stamped index.html → v=${stamp}, vendor=${vendorStamp}`);
} else {
  console.log(`[cache-buster] no tokens changed in index.html`);
}
