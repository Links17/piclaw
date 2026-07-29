import { sandboxConfig } from "./config.ts";

const domainRe = () =>
  new RegExp(
    `^https?:\\/\\/(\\d+)-([a-f0-9]+)\\.${sandboxConfig.domain.replace(".", "\\.")}(\\/.*)?$`,
    "i",
  );

let installed = false;

export function installProxyFetch(): () => void {
  if (!sandboxConfig.proxyNodeIp || installed) return () => {};
  installed = true;
  const base = globalThis.fetch.bind(globalThis);
  const patched = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const m = url.match(domainRe());
      if (m) {
        const port = m[1];
        const sandboxId = m[2];
        const path = m[3] ?? "/";
        const host = `${port}-${sandboxId}.${sandboxConfig.domain}`;
        const headers = new Headers(init?.headers);
        headers.set("Host", host);
        return base(`http://${sandboxConfig.proxyNodeIp}${path}`, { ...init, headers });
      }
      return base(input, init);
    },
    { preconnect: base.preconnect?.bind(base) },
  );
  globalThis.fetch = patched as typeof fetch;
  return () => {
    globalThis.fetch = base;
    installed = false;
  };
}
