import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function cssRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] || "";
}

const THEME_WORKSPACE_CSS = [
  "../../web/static/classic/css/workspace.css",
];

test("timeline hamburger dropdown uses fixed coordinates from the button anchor", () => {
  const settingsCss = readFileSync(join(import.meta.dir, "../../web/static/classic/css/settings.css"), "utf8");
  expect(settingsCss).toContain(".timeline-menu-dropdown-fixed");
  expect(settingsCss).toContain("position: fixed");
});

test("timeline hamburger dropdown uses available viewport height without a fixed desktop cap", () => {
  for (const relativePath of THEME_WORKSPACE_CSS) {
    const css = readFileSync(join(import.meta.dir, relativePath), "utf8");
    const body = cssRuleBody(css, ".timeline-menu-dropdown");

    expect(body).toContain("max-height: calc(100dvh - 48px);");
    expect(body).not.toContain("520px");
  }
});
