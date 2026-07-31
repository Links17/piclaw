#!/usr/bin/env bun
/**
 * SCRIPT_JDOC:
 * {
 *   "summary": "Collect GitHub issues and pull requests into normalized JSON and Markdown digests, while maintaining a SQLite repository metrics history.",
 *   "aliases": ["github digest", "collate issues prs", "github metrics history"],
 *   "domains": ["github", "reporting", "issues", "pull-requests", "analytics"],
 *   "verbs": ["collect", "collate", "report", "trend", "history"],
 *   "nouns": ["issues", "pull requests", "repos", "digest", "history", "stars"],
 *   "keywords": ["github", "issues", "prs", "markdown", "json", "sqlite", "snapshot", "star", "trend"],
 *   "guidance": [
 *     "Skips private repositories by default; pass --include-private to opt in.",
 *     "Writes normalized JSON, Markdown, SQLite history, and optional YAML compatibility artifacts.",
 *     "History is incremental: each scheduled run appends one metric snapshot per repository."
 *   ],
 *   "examples": [
 *     "bun run scripts/github-collate-issues-prs.ts --state open",
 *     "bun run scripts/github-collate-issues-prs.ts --state all --owner rcarmo --include-private",
 *     "bun run scripts/github-collate-issues-prs.ts --history-yaml /workspace/notes/reference/github-repo-metrics-history.yml"
 *   ],
 *   "kind": "read-only",
 *   "weight": "standard",
 *   "role": "entrypoint"
 * }
 */
/**
 * github-collate-issues-prs.ts
 *
 * Collect issues + pull requests across GitHub repositories visible to the
 * current token, write a normalized JSON snapshot, render a Markdown report,
 * and maintain a SQLite-backed rolling history of issue/PR/star metrics for
 * trend charting. YAML history output is kept as a compatibility artifact.
 *
 * Auth sources (first match wins):
 * - GITHUB_TOKEN
 * - GITHUB_PICLAW_BOT_PAT
 * - GH_TOKEN
 * - gh auth token
 */

import Database from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as YAML from "js-yaml";

type RepoRecord = {
  id: number;
  full_name: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  html_url: string;
  default_branch: string;
  stargazers_count: number;
  owner: { login: string };
  permissions?: Record<string, boolean>;
};

type IssueApiRecord = {
  id?: number;
  node_id?: string;
  number: number;
  title: string;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  user?: { login?: string } | null;
  labels?: Array<{ name?: string } | null>;
  assignees?: Array<{ login?: string } | null>;
  body?: string | null;
  pull_request?: unknown;
};

type PullApiRecord = {
  id?: number;
  node_id?: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
  user?: { login?: string } | null;
  labels?: Array<{ name?: string } | null>;
  assignees?: Array<{ login?: string } | null>;
  body?: string | null;
  head?: { ref?: string } | null;
  base?: { ref?: string } | null;
};

type CollatedItem = {
  repo: string;
  repo_url: string;
  repo_private: boolean;
  repo_archived: boolean;
  type: "issue" | "pull_request";
  github_id?: number;
  node_id?: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  url: string;
  author: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  labels: string[];
  assignees: string[];
  body_preview: string;
  head_ref?: string;
  base_ref?: string;
  raw_json?: string;
};

type RepoSummary = {
  full_name: string;
  html_url: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  default_branch: string;
  stars: number;
  issues: number;
  pull_requests: number;
  total: number;
};

type MetricDeltas = {
  issues: number;
  pull_requests: number;
  stars: number;
};

type HistorySnapshot = {
  at: string;
  issues: number;
  pull_requests: number;
  stars: number;
  deltas: MetricDeltas;
};

type RepoHistoryRecord = {
  full_name: string;
  html_url: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  default_branch: string;
  points: HistorySnapshot[];
};

type RepoMetricsHistory = {
  generated_at: string;
  version: number;
  points: number;
  repos: RepoHistoryRecord[];
};

type RepoTrend = {
  full_name: string;
  html_url: string;
  stars: number;
  issues: number;
  pull_requests: number;
  deltas: MetricDeltas;
  points: HistorySnapshot[];
};

type CollectedRepo = {
  repo: RepoSummary;
  all_items: CollatedItem[];
  items: CollatedItem[];
};

type SyncRunRowResult = {
  id: number;
  started_at: string;
};

type RepoSnapshotRow = {
  collected_at: string;
  stars: number;
  issues: number;
  pull_requests: number;
};

type Report = {
  generated_at: string;
  state: "open" | "closed" | "all";
  include_archived: boolean;
  include_forks: boolean;
  include_private: boolean;
  owner_filters: string[];
  recent_activity_hours: number | null;
  totals: {
    repos_scanned: number;
    repos_with_items: number;
    total_items: number;
    total_issues: number;
    total_pull_requests: number;
    repos_with_star_changes: number;
    repos_with_star_gains: number;
  };
  repos: RepoSummary[];
  items: CollatedItem[];
};

type Options = {
  state: "open" | "closed" | "all";
  outputDir: string;
  outputJson?: string;
  outputMarkdown?: string;
  historyYaml?: string;
  dbPath: string;
  includeArchived: boolean;
  includeForks: boolean;
  includePrivate: boolean;
  ownerFilters: string[];
  maxRepos?: number;
  activeWithinHours?: number;
  historyPoints: number;
  chartPoints: number;
};

const DEFAULT_HISTORY_POINTS = 120;
const DEFAULT_CHART_POINTS = 30;
const DEFAULT_DB_PATH = "/workspace/.seeed/analytics/github-metrics.sqlite";

function readOption(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) return undefined;
  return next;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptions(argv: string[]): Options {
  const stateCandidate = readOption(argv, "--state");
  const state = stateCandidate === "closed" || stateCandidate === "all" ? stateCandidate : "open";
  const outputDir = resolve(readOption(argv, "--output-dir") || "/workspace/tmp/github-collate");
  const outputJson = readOption(argv, "--output-json");
  const outputMarkdown = readOption(argv, "--output-markdown");
  const historyYaml = readOption(argv, "--history-yaml");
  const dbPath = resolve(readOption(argv, "--db-path") || DEFAULT_DB_PATH);
  const includeArchived = argv.includes("--include-archived");
  const includeForks = argv.includes("--include-forks");
  const includePrivate = argv.includes("--include-private");
  const ownerFilters = argv
    .flatMap((arg, index) => arg === "--owner" ? [argv[index + 1]] : [])
    .filter((value): value is string => Boolean(value && !value.startsWith("--")))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const maxReposRaw = readOption(argv, "--max-repos");
  const maxRepos = parsePositiveInt(maxReposRaw, Infinity);
  const activeWithinHours = Number.parseInt(readOption(argv, "--active-within-hours") ?? "", 10);
  const historyPoints = parsePositiveInt(readOption(argv, "--history-points"), DEFAULT_HISTORY_POINTS);
  const chartPoints = parsePositiveInt(readOption(argv, "--chart-points") ?? readOption(argv, "--chart-days"), DEFAULT_CHART_POINTS);

  return {
    state,
    outputDir,
    outputJson,
    outputMarkdown,
    historyYaml,
    dbPath,
    includeArchived,
    includeForks,
    includePrivate,
    ownerFilters,
    maxRepos: Number.isFinite(maxRepos) && maxRepos < Infinity ? maxRepos : undefined,
    activeWithinHours: Number.isFinite(activeWithinHours) && activeWithinHours > 0 ? activeWithinHours : undefined,
    historyPoints,
    chartPoints,
  };
}

function readGithubCliToken(): string {
  try {
    const result = Bun.spawnSync(["gh", "auth", "token"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return "";
    return Buffer.from(result.stdout).toString("utf8").trim();
  } catch {
    return "";
  }
}

function requireGithubToken(): string {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PICLAW_BOT_PAT || process.env.GH_TOKEN || readGithubCliToken();
  if (!token.trim()) {
    throw new Error("Missing GitHub token. Set GITHUB_TOKEN, GITHUB_PICLAW_BOT_PAT, GH_TOKEN, or run gh auth login.");
  }
  return token.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(token: string, url: string): Promise<{ data: T; headers: Headers }> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "piclaw-github-collate-script",
      },
    });

    if (response.ok) {
      return { data: await response.json() as T, headers: response.headers };
    }

    if ((response.status === 403 || response.status === 429) && attempt < 4) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const resetEpoch = Number(response.headers.get("x-ratelimit-reset"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Number.isFinite(resetEpoch) && resetEpoch > 0
          ? Math.max(1000, (resetEpoch * 1000) - Date.now())
          : 2000 * attempt;
      await sleep(delayMs);
      continue;
    }

    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API request failed (${response.status}) for ${url}\n${body}`.trim());
  }
}

function parseLinkHeader(header: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (!match) continue;
    result[match[2]] = match[1];
  }
  return result;
}

async function fetchAllPages<T>(token: string, url: string): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | undefined = url;
  while (nextUrl) {
    const { data, headers } = await fetchJson<T[]>(token, nextUrl);
    items.push(...data);
    const links = parseLinkHeader(headers.get("link"));
    nextUrl = links.next;
  }
  return items;
}

async function fetchAllPagesAllowEmptyOnNotFound<T>(token: string, url: string): Promise<T[]> {
  try {
    return await fetchAllPages<T>(token, url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (message.includes("GitHub API request failed (404)") || message.includes("GitHub API request failed (410)")) {
      return [];
    }
    throw error;
  }
}

function previewBody(value: string | null | undefined, maxChars = 160): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function labelNames(value: Array<{ name?: string } | null> | undefined): string[] {
  return (value || [])
    .map((entry) => typeof entry?.name === "string" ? entry.name.trim() : "")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function assigneeNames(value: Array<{ login?: string } | null> | undefined): string[] {
  return (value || [])
    .map((entry) => typeof entry?.login === "string" ? entry.login.trim() : "")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function normalizeIssue(repo: RepoRecord, record: IssueApiRecord): CollatedItem | null {
  if (record.pull_request) return null;
  return {
    repo: repo.full_name,
    repo_url: repo.html_url,
    repo_private: repo.private,
    repo_archived: repo.archived,
    type: "issue",
    github_id: normalizeNumber(record.id),
    node_id: normalizeString(record.node_id) || undefined,
    number: record.number,
    title: String(record.title || "").trim(),
    state: String(record.state || "").trim() || "open",
    draft: false,
    url: String(record.html_url || "").trim(),
    author: String(record.user?.login || "").trim(),
    created_at: normalizeIsoOrNull(record.created_at) || new Date(0).toISOString(),
    updated_at: normalizeIsoOrNull(record.updated_at) || normalizeIsoOrNull(record.created_at) || new Date(0).toISOString(),
    closed_at: normalizeIsoOrNull(record.closed_at),
    merged_at: null,
    labels: labelNames(record.labels),
    assignees: assigneeNames(record.assignees),
    body_preview: previewBody(record.body),
    raw_json: JSON.stringify(record),
  };
}

function normalizePull(repo: RepoRecord, record: PullApiRecord): CollatedItem {
  return {
    repo: repo.full_name,
    repo_url: repo.html_url,
    repo_private: repo.private,
    repo_archived: repo.archived,
    type: "pull_request",
    github_id: normalizeNumber(record.id),
    node_id: normalizeString(record.node_id) || undefined,
    number: record.number,
    title: String(record.title || "").trim(),
    state: String(record.state || "").trim() || "open",
    draft: Boolean(record.draft),
    url: String(record.html_url || "").trim(),
    author: String(record.user?.login || "").trim(),
    created_at: normalizeIsoOrNull(record.created_at) || new Date(0).toISOString(),
    updated_at: normalizeIsoOrNull(record.updated_at) || normalizeIsoOrNull(record.created_at) || new Date(0).toISOString(),
    closed_at: normalizeIsoOrNull(record.closed_at),
    merged_at: normalizeIsoOrNull(record.merged_at),
    labels: labelNames(record.labels),
    assignees: assigneeNames(record.assignees),
    body_preview: previewBody(record.body),
    head_ref: String(record.head?.ref || "").trim() || undefined,
    base_ref: String(record.base?.ref || "").trim() || undefined,
    raw_json: JSON.stringify(record),
  };
}

function normalizeNumber(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.round(num));
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function ownerFromFullName(fullName: string): string {
  return String(fullName || "").split("/")[0] || "";
}

function escapeCell(value: string): string {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function escapeMarkdown(value: string): string {
  return String(value || "").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function escapeXml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function compactIso(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function toDisplayDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${String(parsed.getUTCFullYear())}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
}

const SPARKLINE_SVG_STYLE = [
  `<style>`,
  `  :root {`,
  `    color-scheme: light dark;`,
  `    --chart-bg: #ffffff;`,
  `    --chart-panel: #f8fafc;`,
  `    --chart-title: #0f172a;`,
  `    --chart-muted: #475569;`,
  `    --chart-subtle: #64748b;`,
  `    --chart-grid: #cbd5e1;`,
  `    --chart-line: #0284c7;`,
  `    --chart-line-fill: rgba(14, 165, 233, 0.12);`,
  `    --chart-point-fill: #ffffff;`,
  `    --chart-point-stroke: #0ea5e9;`,
  `    --chart-positive: #15803d;`,
  `    --chart-negative: #b91c1c;`,
  `    --chart-neutral: #475569;`,
  `  }`,
  `  @media (prefers-color-scheme: dark) {`,
  `    :root {`,
  `      --chart-bg: #0b1020;`,
  `      --chart-panel: #111827;`,
  `      --chart-title: #e2e8f0;`,
  `      --chart-muted: #9ca3af;`,
  `      --chart-subtle: #94a3b8;`,
  `      --chart-grid: #1f2937;`,
  `      --chart-line: #38bdf8;`,
  `      --chart-line-fill: rgba(56, 189, 248, 0.12);`,
  `      --chart-point-fill: #f8fafc;`,
  `      --chart-point-stroke: #0ea5e9;`,
  `      --chart-positive: #22c55e;`,
  `      --chart-negative: #f87171;`,
  `      --chart-neutral: #9ca3af;`,
  `    }`,
  `  }`,
  `  .chart-bg { fill: var(--chart-bg); }`,
  `  .chart-panel { fill: var(--chart-panel); }`,
  `  .chart-title { fill: var(--chart-title); font-family: system-ui,-apple-system,Segoe UI,sans-serif; font-size: 13px; }`,
  `  .chart-grid { stroke: var(--chart-grid); stroke-width: 1; }`,
  `  .chart-axis { fill: var(--chart-muted); font-size: 11px; font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; }`,
  `  .chart-date { fill: var(--chart-subtle); font-size: 10px; font-family: system-ui,-apple-system,Segoe UI,sans-serif; }`,
  `  .chart-line { fill: none; stroke: var(--chart-line); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }`,
  `  .chart-area { fill: var(--chart-line-fill); stroke: none; }`,
  `  .chart-point { fill: var(--chart-point-fill); stroke: var(--chart-point-stroke); stroke-width: 1.5; }`,
  `  .chart-delta { font-size: 11px; font-family: system-ui,-apple-system,Segoe UI,sans-serif; }`,
  `  .chart-delta.positive { fill: var(--chart-positive); }`,
  `  .chart-delta.negative { fill: var(--chart-negative); }`,
  `  .chart-delta.neutral { fill: var(--chart-neutral); }`,
  `  .chart-empty { fill: var(--chart-subtle); font-size: 14px; font-family: system-ui,-apple-system,Segoe UI,sans-serif; }`,
  `</style>`,
].join("");

export function buildSparklineSvg(points: HistorySnapshot[], title: string, width = 640, height = 180): string {
  if (points.length === 0) {
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<title>${escapeXml(title)}</title>`,
      SPARKLINE_SVG_STYLE,
      `<rect class="chart-bg" x="0" y="0" width="${width}" height="${height}" rx="12"/>`,
      `<text class="chart-empty" x="${width / 2}" y="${height / 2}" text-anchor="middle">No history yet</text>`,
      `</svg>`,
    ].join("");
  }

  const labels = points.map((point) => toDisplayDate(point.at));
  const values = points.map((point) => point.stars);
  const minRaw = Math.min(...values);
  const maxRaw = Math.max(...values);
  const delta = maxRaw - minRaw;
  const pad = Math.max(1, Math.ceil(delta * 0.15));
  const minY = Math.max(0, minRaw - pad);
  const maxY = maxRaw + pad;

  const left = 42;
  const right = 12;
  const top = 28;
  const bottom = 34;
  const chartW = width - left - right;
  const chartH = height - top - bottom;
  const step = chartW / Math.max(1, points.length - 1);

  const mapX = (index: number) => left + index * step;
  const mapY = (value: number) => top + chartH * (1 - (value - minY) / Math.max(1, maxY - minY));

  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${mapX(index).toFixed(2)} ${mapY(point.stars).toFixed(2)}`)
    .join(" ");

  const last = points[points.length - 1];
  const first = points[0];
  const trendDelta = (last?.stars ?? 0) - (first?.stars ?? 0);
  const trendClass = trendDelta > 0 ? "positive" : trendDelta < 0 ? "negative" : "neutral";

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  lines.push(`<title>${escapeXml(title)}</title>`);
  lines.push(SPARKLINE_SVG_STYLE);
  lines.push(`<rect class="chart-bg" x="0" y="0" width="${width}" height="${height}" rx="12"/>`);
  lines.push(`<rect class="chart-panel" x="${left}" y="${top}" width="${chartW}" height="${chartH}" rx="8"/>`);
  lines.push(`<text class="chart-title" x="${left}" y="${18}">${escapeXml(title)} • ${last.stars}★</text>`);

  // Grid & axis labels
  const minTick = minY;
  const maxTick = maxY;
  const midTick = (maxTick + minTick) / 2;
  const ticks = [minTick, midTick, maxTick];
  for (const tickValue of ticks) {
    const y = top + (tickValue - maxTick) * (chartH / (maxY - minY || 1)) * -1;
    const label = Math.round(tickValue).toString();
    lines.push(`<line class="chart-grid" x1="${left}" y1="${y.toFixed(2)}" x2="${width - right}" y2="${y.toFixed(2)}" />`);
    lines.push(`<text class="chart-axis" x="${left - 6}" y="${(y + 4).toFixed(2)}" text-anchor="end">${escapeXml(label)}</text>`);
  }

  const baseY = mapY(minY);
  lines.push(`<path class="chart-area" d="${path} L ${mapX(points.length - 1).toFixed(2)} ${baseY.toFixed(2)} L ${mapX(0).toFixed(2)} ${baseY.toFixed(2)} Z"/>`);
  lines.push(`<path class="chart-line" d="${path}"/>`);

  for (let index = 0; index < points.length; index += 1) {
    if (index % 2 === 1 && index !== points.length - 1) continue;
    const point = points[index];
    const x = mapX(index).toFixed(2);
    const y = mapY(point.stars).toFixed(2);
    lines.push(`<circle class="chart-point" cx="${x}" cy="${y}" r="3" />`);
  }

  lines.push(`<text class="chart-date" x="${left}" y="${height - 10}">${escapeXml(labels[0] || "")}</text>`);
  lines.push(`<text class="chart-date" x="${width - right}" y="${height - 10}" text-anchor="end">${escapeXml(labels[labels.length - 1] || "")}</text>`);
  if (first && last) {
    lines.push(`<text class="chart-delta ${trendClass}" x="${width - right}" y="${22}" text-anchor="end">${trendDelta >= 0 ? "+" : ""}${trendDelta.toLocaleString()}★ in ${labels.length - 1} step${labels.length - 2 === 1 ? "" : "s"}</text>`);
  }
  lines.push("</svg>");
  return lines.join("");
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function renderMarkdown(report: Report, trends: RepoTrend[], chartPoints: number): string {
  const lines: string[] = [];
  const starChanges = trends.filter((trend) => trend.deltas.stars !== 0);
  const starGains = starChanges
    .filter((trend) => trend.deltas.stars > 0)
    .sort((a, b) => b.deltas.stars - a.deltas.stars)
    .slice(0, 20);

  lines.push("# GitHub issues + PR digest");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push("");

  lines.push("## Recently changed star counts");
  lines.push("");
  if (starChanges.length === 0) {
    lines.push("No repository changed star count in this run.");
    lines.push("");
  } else {
    lines.push("| Repo | Current stars | Delta | Issues | PRs | URL |\n|---|---:|---:|---:|---:|---|");
    for (const trend of starChanges.sort((a, b) => Math.abs(b.deltas.stars) - Math.abs(a.deltas.stars))) {
      const delta = trend.deltas.stars;
      const sign = delta > 0 ? `+${delta}` : String(delta);
      lines.push(`| ${escapeCell(trend.full_name)} | ${trend.stars.toLocaleString()} | ${sign} | ${trend.issues} | ${trend.pull_requests} | [repo](${trend.html_url}) |`);
    }
    lines.push("");

    if (starGains.length > 0) {
      lines.push("### Star trend (new stars)");
      lines.push("");
      for (const trend of starGains) {
        const chartWindow = trend.points.slice(-Math.max(2, chartPoints));
        const current = trend.stars;
        const previous = current - trend.deltas.stars;
        const delta = trend.deltas.stars;
        const chart = buildSparklineSvg(chartWindow, `${trend.full_name} star trend`);
        lines.push(`#### [${escapeMarkdown(trend.full_name)}](${trend.html_url})`);
        lines.push(`- Current: **${current.toLocaleString()}** stars (from **${Math.max(0, previous).toLocaleString()}**, **${delta > 0 ? "+" : ""}${delta}** this run)`);
        lines.push(`- Open items: ${trend.issues} issues / ${trend.pull_requests} PRs`);
        lines.push(`![${escapeMarkdown(trend.full_name)} stars trend](${svgDataUrl(chart)})`);
        lines.push("");
      }
    }
  }

  const stateSummary = [
    `State filter: ${escapeCell(report.state)}`,
    ...(report.recent_activity_hours ? [`Activity window: last ${report.recent_activity_hours}h by created/updated time`] : []),
    `Included private repos: ${report.include_private ? "yes" : "no"}`,
  ];
  const countSummary = [
    `Repos scanned: **${report.totals.repos_scanned}**`,
    `Repos with items: **${report.totals.repos_with_items}**`,
    `Total items: **${report.totals.total_items}**`,
    `Issues: **${report.totals.total_issues}**`,
    `Pull requests: **${report.totals.total_pull_requests}**`,
    `Repos with star movement: **${report.totals.repos_with_star_changes}**`,
    `Repos with new stars: **${report.totals.repos_with_star_gains}**`,
  ];
  const summaryRows = Math.max(countSummary.length, stateSummary.length);

  lines.push("## Summary");
  lines.push("");
  lines.push("| Counts | State |");
  lines.push("|---|---|");
  for (let index = 0; index < summaryRows; index += 1) {
    lines.push(`| ${escapeCell(countSummary[index] || "")} | ${escapeCell(stateSummary[index] || "")} |`);
  }
  lines.push("");

  if (report.repos.length > 0) {
    lines.push("## Repo summary");
    lines.push("");
    lines.push("| Repo | Stars | Issues | PRs | Total |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const repo of report.repos) {
      lines.push(`| ${escapeCell(repo.full_name)} | ${repo.stars} | ${repo.issues} | ${repo.pull_requests} | ${repo.total} |`);
    }
    lines.push("");
  }

  lines.push("## Collated items");
  lines.push("");
  if (report.items.length === 0) {
    lines.push("| Updated | Repo | Type | # | Title | Author | Labels | URL |");
    lines.push("|---|---|---|---:|---|---|---|---|");
    lines.push("| — | — | — | — | No matching items | — | — | — |");
    lines.push("");
    return lines.join("\n");
  }

  const itemsByRepo = new Map<string, CollatedItem[]>();
  for (const item of report.items) {
    const existing = itemsByRepo.get(item.repo) || [];
    existing.push(item);
    itemsByRepo.set(item.repo, existing);
  }

  for (const repo of report.repos) {
    const repoItems = itemsByRepo.get(repo.full_name) || [];
    if (repoItems.length === 0) continue;
    const issues = repoItems.filter((item) => item.type === "issue");
    const pullRequests = repoItems.filter((item) => item.type === "pull_request");

    lines.push(`### [${escapeCell(repo.full_name)}](${repo.html_url})`);
    lines.push("");

    if (issues.length > 0) {
      lines.push("#### Issues");
      lines.push("");
      lines.push("| Updated | # | Title | Author | Labels | URL |");
      lines.push("|---|---:|---|---|---|---|");
      for (const item of issues) {
        const labels = item.labels.length > 0 ? item.labels.join(", ") : "—";
        lines.push(
          `| ${escapeCell(compactIso(item.updated_at))} | ${item.number} | ${escapeCell(item.title)} | ${escapeCell(item.author || "—")} | ${escapeCell(labels)} | [#${item.number}](${item.url}) |`,
        );
      }
      lines.push("");
    }

    if (pullRequests.length > 0) {
      lines.push("#### Pull requests");
      lines.push("");
      lines.push("| Updated | # | Title | Author | Labels | URL |");
      lines.push("|---|---:|---|---|---|---|");
      for (const item of pullRequests) {
        const labels = item.labels.length > 0 ? item.labels.join(", ") : "—";
        const title = item.draft ? `${item.title} (draft)` : item.title;
        lines.push(
          `| ${escapeCell(compactIso(item.updated_at))} | ${item.number} | ${escapeCell(title)} | ${escapeCell(item.author || "—")} | ${escapeCell(labels)} | [#${item.number}](${item.url}) |`,
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function loadHistory(path: string): RepoMetricsHistory {
  if (!existsSync(path)) {
    return {
      generated_at: new Date().toISOString(),
      version: 1,
      points: DEFAULT_HISTORY_POINTS,
      repos: [],
    };
  }

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = YAML.load(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return {
        generated_at: new Date().toISOString(),
        version: 1,
        points: DEFAULT_HISTORY_POINTS,
        repos: [],
      };
    }

    const reposRaw = Array.isArray((parsed as any).repos) ? (parsed as any).repos as unknown[] : [];
    const repos = reposRaw.flatMap((repo: unknown): RepoHistoryRecord[] => {
      if (!repo || typeof repo !== "object") return [];
      const typed = repo as Record<string, unknown>;
      const fullName = normalizeString(typed.full_name);
      if (!fullName) return [];
      const pointRaw = Array.isArray((typed as any).points) ? (typed as any).points as unknown[] : [];
      const points = pointRaw
        .map((point: unknown): HistorySnapshot | null => {
          if (!point || typeof point !== "object") return null;
          const rawPoint = point as Record<string, unknown>;
          const at = normalizeString(rawPoint.at);
          if (!at) return null;
          const issues = normalizeNumber(rawPoint.issues);
          const pullRequests = normalizeNumber(rawPoint.pull_requests);
          const stars = normalizeNumber(rawPoint.stars);
          const deltasCandidate = typeof rawPoint.deltas === "object" && rawPoint.deltas !== null
            ? rawPoint.deltas as Record<string, unknown>
            : null;
          return {
            at,
            issues,
            pull_requests: pullRequests,
            stars,
            deltas: {
              issues: normalizeNumber(deltasCandidate?.issues),
              pull_requests: normalizeNumber(deltasCandidate?.pull_requests),
              stars: normalizeNumber(deltasCandidate?.stars),
            },
          };
        })
        .filter((point): point is HistorySnapshot => Boolean(point));

      return [{
        full_name: fullName,
        html_url: normalizeString(typed.html_url),
        private: Boolean((typed as any).private),
        archived: Boolean((typed as any).archived),
        fork: Boolean((typed as any).fork),
        default_branch: normalizeString(typed.default_branch),
        points,
      }];
    });

    const parsedVersion = Number.isFinite(Number((parsed as any).version)) ? Number((parsed as any).version) : 1;
    const parsedPoints = Number.isFinite(Number((parsed as any).points)) ? Number((parsed as any).points) : DEFAULT_HISTORY_POINTS;
    return {
      generated_at: normalizeString((parsed as any).generated_at) || new Date().toISOString(),
      version: Math.max(1, parsedVersion),
      points: Math.max(10, Math.round(parsedPoints)),
      repos,
    };
  } catch {
    return {
      generated_at: new Date().toISOString(),
      version: 1,
      points: DEFAULT_HISTORY_POINTS,
      repos: [],
    };
  }
}

function ensureRepoHistoryLimit(points: HistorySnapshot[], limit: number): HistorySnapshot[] {
  if (points.length <= limit) return points;
  return points.slice(points.length - limit);
}

function upsertRepoHistory(
  history: RepoMetricsHistory,
  summaries: RepoSummary[],
  generatedAt: string,
  historyPoints: number,
): RepoTrend[] {
  const repoMap = new Map(history.repos.map((repo) => [repo.full_name, repo]));
  const updated: RepoTrend[] = [];

  for (const repo of summaries) {
    const existing = repoMap.get(repo.full_name) || {
      full_name: repo.full_name,
      html_url: repo.html_url,
      private: repo.private,
      archived: repo.archived,
      fork: repo.fork,
      default_branch: repo.default_branch,
      points: [],
    };

    const previous = existing.points[existing.points.length - 1];
    const deltas: MetricDeltas = {
      issues: previous ? repo.issues - previous.issues : 0,
      pull_requests: previous ? repo.pull_requests - previous.pull_requests : 0,
      stars: previous ? repo.stars - previous.stars : 0,
    };

    const point: HistorySnapshot = {
      at: generatedAt,
      issues: repo.issues,
      pull_requests: repo.pull_requests,
      stars: repo.stars,
      deltas,
    };
    existing.points = ensureRepoHistoryLimit([...existing.points, point], historyPoints);

    if (!repoMap.has(repo.full_name)) {
      history.repos.push(existing);
      repoMap.set(repo.full_name, existing);
    }

    updated.push({
      full_name: repo.full_name,
      html_url: repo.html_url,
      stars: repo.stars,
      issues: repo.issues,
      pull_requests: repo.pull_requests,
      deltas,
      points: [...existing.points],
    });
  }

  history.generated_at = generatedAt;
  history.version = Math.max(1, history.version);
  history.points = historyPoints;
  return updated.sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export function initAnalyticsDb(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY,
      full_name TEXT NOT NULL UNIQUE,
      html_url TEXT NOT NULL DEFAULT '',
      owner_login TEXT NOT NULL DEFAULT '',
      is_private INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_fork INTEGER NOT NULL DEFAULT 0,
      default_branch TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '{}',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      github_id INTEGER,
      node_id TEXT,
      number INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('issue', 'pull_request')),
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      draft INTEGER NOT NULL DEFAULT 0,
      author TEXT NOT NULL DEFAULT '',
      html_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      merged_at TEXT,
      labels_json TEXT NOT NULL DEFAULT '[]',
      assignees_json TEXT NOT NULL DEFAULT '[]',
      raw_json TEXT NOT NULL DEFAULT '{}',
      last_seen_at TEXT NOT NULL,
      UNIQUE(repo_id, kind, number)
    );

    CREATE TABLE IF NOT EXISTS repo_snapshots (
      id INTEGER PRIMARY KEY,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      collected_at TEXT NOT NULL,
      stars INTEGER NOT NULL DEFAULT 0,
      open_issues INTEGER NOT NULL DEFAULT 0,
      open_prs INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'sync',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(repo_id, collected_at)
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      scope_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT,
      error_text TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_items_repo_kind_created ON items(repo_id, kind, created_at);
    CREATE INDEX IF NOT EXISTS idx_items_kind_created ON items(kind, created_at);
    CREATE INDEX IF NOT EXISTS idx_items_kind_closed ON items(kind, closed_at);
    CREATE INDEX IF NOT EXISTS idx_items_kind_merged ON items(kind, merged_at);
    CREATE INDEX IF NOT EXISTS idx_repo_snapshots_repo_time ON repo_snapshots(repo_id, collected_at);

    CREATE VIEW IF NOT EXISTS daily_item_opened AS
    SELECT
      repo_id,
      date(created_at) AS day,
      SUM(CASE WHEN kind = 'issue' THEN 1 ELSE 0 END) AS issues_opened,
      SUM(CASE WHEN kind = 'pull_request' THEN 1 ELSE 0 END) AS prs_opened
    FROM items
    GROUP BY repo_id, date(created_at);

    CREATE VIEW IF NOT EXISTS daily_item_closed AS
    SELECT
      repo_id,
      date(closed_at) AS day,
      SUM(CASE WHEN kind = 'issue' THEN 1 ELSE 0 END) AS issues_closed,
      SUM(CASE WHEN kind = 'pull_request' THEN 1 ELSE 0 END) AS prs_closed
    FROM items
    WHERE closed_at IS NOT NULL
    GROUP BY repo_id, date(closed_at);

    CREATE VIEW IF NOT EXISTS daily_pr_merged AS
    SELECT
      repo_id,
      date(merged_at) AS day,
      COUNT(*) AS prs_merged
    FROM items
    WHERE kind = 'pull_request' AND merged_at IS NOT NULL
    GROUP BY repo_id, date(merged_at);
  `);
}

function openAnalyticsDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  initAnalyticsDb(db);
  return db;
}

function upsertRepoRow(db: Database, repo: RepoSummary, seenAt: string, metaJson = "{}"): number {
  db.query(`
    INSERT INTO repos (
      full_name, html_url, owner_login, is_private, is_archived, is_fork, default_branch, meta_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(full_name) DO UPDATE SET
      html_url = excluded.html_url,
      owner_login = excluded.owner_login,
      is_private = excluded.is_private,
      is_archived = excluded.is_archived,
      is_fork = excluded.is_fork,
      default_branch = excluded.default_branch,
      meta_json = excluded.meta_json,
      last_seen_at = excluded.last_seen_at
  `).run(
    repo.full_name,
    repo.html_url || "",
    ownerFromFullName(repo.full_name),
    Number(Boolean(repo.private)),
    Number(Boolean(repo.archived)),
    Number(Boolean(repo.fork)),
    repo.default_branch || "",
    metaJson,
    seenAt,
    seenAt,
  );
  const row = db.query(`SELECT id FROM repos WHERE full_name = ?`).get(repo.full_name) as { id: number } | null;
  if (!row) throw new Error(`Failed to upsert repo row for ${repo.full_name}`);
  return row.id;
}

function importLegacyHistoryIntoDb(db: Database, history: RepoMetricsHistory, historyYamlPath: string): number {
  let inserted = 0;
  for (const repo of history.repos) {
    const repoId = upsertRepoRow(db, {
      full_name: repo.full_name,
      html_url: repo.html_url,
      private: repo.private,
      archived: repo.archived,
      fork: repo.fork,
      default_branch: repo.default_branch,
      stars: repo.points.at(-1)?.stars ?? 0,
      issues: repo.points.at(-1)?.issues ?? 0,
      pull_requests: repo.points.at(-1)?.pull_requests ?? 0,
      total: (repo.points.at(-1)?.issues ?? 0) + (repo.points.at(-1)?.pull_requests ?? 0),
    }, history.generated_at || new Date().toISOString(), JSON.stringify({ imported_from: historyYamlPath, imported_version: history.version }));

    for (const point of repo.points) {
      const before = db.query(`SELECT 1 AS ok FROM repo_snapshots WHERE repo_id = ? AND collected_at = ?`).get(repoId, point.at) as { ok: number } | null;
      db.query(`
        INSERT INTO repo_snapshots (
          repo_id, collected_at, stars, open_issues, open_prs, source, snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_id, collected_at) DO UPDATE SET
          stars = excluded.stars,
          open_issues = excluded.open_issues,
          open_prs = excluded.open_prs,
          source = excluded.source,
          snapshot_json = excluded.snapshot_json
      `).run(
        repoId,
        point.at,
        point.stars,
        point.issues,
        point.pull_requests,
        "legacy_yaml",
        JSON.stringify({ deltas: point.deltas, imported_from: historyYamlPath }),
      );
      if (!before) inserted += 1;
    }
  }
  return inserted;
}

function syncRepoToDb(db: Database, result: CollectedRepo, collectedAt: string): void {
  const openIssues = result.all_items.filter((item) => item.type === "issue" && item.state === "open").length;
  const openPullRequests = result.all_items.filter((item) => item.type === "pull_request" && item.state === "open").length;
  const repoId = upsertRepoRow(db, result.repo, collectedAt, JSON.stringify({ synced_by: "github-collate-issues-prs.ts" }));

  const tx = db.transaction((items: CollatedItem[]) => {
    for (const item of items) {
      db.query(`
        INSERT INTO items (
          repo_id, github_id, node_id, number, kind, title, state, draft, author, html_url,
          created_at, updated_at, closed_at, merged_at, labels_json, assignees_json, raw_json, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_id, kind, number) DO UPDATE SET
          github_id = excluded.github_id,
          node_id = excluded.node_id,
          title = excluded.title,
          state = excluded.state,
          draft = excluded.draft,
          author = excluded.author,
          html_url = excluded.html_url,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          closed_at = excluded.closed_at,
          merged_at = excluded.merged_at,
          labels_json = excluded.labels_json,
          assignees_json = excluded.assignees_json,
          raw_json = excluded.raw_json,
          last_seen_at = excluded.last_seen_at
      `).run(
        repoId,
        item.github_id || null,
        item.node_id || null,
        item.number,
        item.type,
        item.title,
        item.state,
        Number(item.draft),
        item.author,
        item.url,
        item.created_at,
        item.updated_at,
        item.closed_at,
        item.merged_at,
        JSON.stringify(item.labels),
        JSON.stringify(item.assignees),
        item.raw_json || "{}",
        collectedAt,
      );
    }

    db.query(`
      INSERT INTO repo_snapshots (
        repo_id, collected_at, stars, open_issues, open_prs, source, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, collected_at) DO UPDATE SET
        stars = excluded.stars,
        open_issues = excluded.open_issues,
        open_prs = excluded.open_prs,
        source = excluded.source,
        snapshot_json = excluded.snapshot_json
    `).run(
      repoId,
      collectedAt,
      result.repo.stars,
      openIssues,
      openPullRequests,
      "sync",
      JSON.stringify({ total_items_seen: result.all_items.length, report_items: result.items.length }),
    );
  });

  tx(result.all_items);
}

function startSyncRun(db: Database, startedAt: string, scope: Record<string, unknown>): SyncRunRowResult {
  db.query(`INSERT INTO sync_runs (started_at, status, scope_json) VALUES (?, 'running', ?)`).run(startedAt, JSON.stringify(scope));
  const row = db.query(`SELECT last_insert_rowid() AS id`).get() as { id: number } | null;
  return { id: row?.id ?? 0, started_at: startedAt };
}

function finishSyncRun(db: Database, run: SyncRunRowResult, finishedAt: string, result: unknown): void {
  if (!run.id) return;
  db.query(`UPDATE sync_runs SET finished_at = ?, status = 'ok', result_json = ? WHERE id = ?`).run(finishedAt, JSON.stringify(result), run.id);
}

function loadRepoTrendsFromDb(db: Database, summaries: RepoSummary[], maxPoints: number): RepoTrend[] {
  const pointLimit = Math.max(2, maxPoints);
  const statement = db.query(`
    SELECT
      s.collected_at,
      s.stars,
      s.open_issues AS issues,
      s.open_prs AS pull_requests
    FROM repo_snapshots s
    JOIN repos r ON r.id = s.repo_id
    WHERE r.full_name = ?
    ORDER BY s.collected_at DESC
    LIMIT ?
  `);

  return summaries
    .map((repo) => {
      const rows = (statement.all(repo.full_name, pointLimit) as RepoSnapshotRow[]).reverse();
      const points = rows.map((row, index): HistorySnapshot => {
        const previous = rows[index - 1];
        return {
          at: row.collected_at,
          issues: normalizeNumber(row.issues),
          pull_requests: normalizeNumber(row.pull_requests),
          stars: normalizeNumber(row.stars),
          deltas: {
            issues: previous ? normalizeNumber(row.issues) - normalizeNumber(previous.issues) : 0,
            pull_requests: previous ? normalizeNumber(row.pull_requests) - normalizeNumber(previous.pull_requests) : 0,
            stars: previous ? normalizeNumber(row.stars) - normalizeNumber(previous.stars) : 0,
          },
        };
      });

      const current = points.at(-1);
      const previous = points.at(-2);
      const deltas = current && previous
        ? {
            issues: current.issues - previous.issues,
            pull_requests: current.pull_requests - previous.pull_requests,
            stars: current.stars - previous.stars,
          }
        : { issues: 0, pull_requests: 0, stars: 0 };

      return {
        full_name: repo.full_name,
        html_url: repo.html_url,
        stars: current?.stars ?? repo.stars,
        issues: current?.issues ?? repo.issues,
        pull_requests: current?.pull_requests ?? repo.pull_requests,
        deltas,
        points,
      };
    })
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, values.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function isRecentlyActive(item: CollatedItem, nowMs: number, activeWithinHours?: number): boolean {
  if (!activeWithinHours || activeWithinHours <= 0) return true;
  const cutoff = nowMs - (activeWithinHours * 60 * 60 * 1000);
  const createdMs = Date.parse(item.created_at) || 0;
  const updatedMs = Date.parse(item.updated_at) || 0;
  return createdMs >= cutoff || updatedMs >= cutoff;
}

function toOutputItem(item: CollatedItem): CollatedItem {
  const output: Partial<CollatedItem> = { ...item };
  delete output.github_id;
  delete output.node_id;
  delete output.closed_at;
  delete output.merged_at;
  delete output.raw_json;
  return output as CollatedItem;
}

async function collectRepoItems(
  token: string,
  repo: RepoRecord,
  state: Options["state"],
  activeWithinHours?: number,
  nowMs = Date.now(),
): Promise<CollectedRepo> {
  const [owner = "", name = ""] = String(repo.full_name || "").split("/");
  if (!owner || !name) {
    throw new Error(`Invalid GitHub repo full_name: ${repo.full_name}`);
  }
  const issuesUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?state=all&per_page=100`;
  const pullsUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=all&per_page=100`;

  const [issueRecords, pullRecords] = await Promise.all([
    fetchAllPagesAllowEmptyOnNotFound<IssueApiRecord>(token, issuesUrl),
    fetchAllPagesAllowEmptyOnNotFound<PullApiRecord>(token, pullsUrl),
  ]);

  const allItems = [
    ...issueRecords.map((record) => normalizeIssue(repo, record)).filter((record): record is CollatedItem => Boolean(record)),
    ...pullRecords.map((record) => normalizePull(repo, record)),
  ].sort((left, right) => {
    const leftTs = Date.parse(left.updated_at) || 0;
    const rightTs = Date.parse(right.updated_at) || 0;
    if (rightTs !== leftTs) return rightTs - leftTs;
    if (left.repo !== right.repo) return left.repo.localeCompare(right.repo);
    if (left.type !== right.type) return left.type.localeCompare(right.type);
    return left.number - right.number;
  });

  const items = allItems
    .filter((item) => state === "all" || item.state === state)
    .filter((item) => isRecentlyActive(item, nowMs, activeWithinHours));

  return {
    repo: {
      full_name: repo.full_name,
      html_url: repo.html_url,
      private: repo.private,
      archived: repo.archived,
      fork: repo.fork,
      default_branch: repo.default_branch,
      stars: normalizeNumber(repo.stargazers_count),
      issues: items.filter((item) => item.type === "issue").length,
      pull_requests: items.filter((item) => item.type === "pull_request").length,
      total: items.length,
    },
    all_items: allItems,
    items,
  };
}

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function normalizeHistoryYamlPath(outputDir: string, explicitPath: string | undefined): string {
  if (explicitPath && explicitPath.trim()) {
    return resolve(explicitPath);
  }
  return resolve(outputDir, "github-repo-metrics-history.yml");
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  const token = requireGithubToken();
  const historyYaml = normalizeHistoryYamlPath(options.outputDir, options.historyYaml);

  const repos = await fetchAllPages<RepoRecord>(
    token,
    "https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=full_name&direction=asc",
  );

  let filteredRepos = repos.filter((repo) => {
    if (!options.includeArchived && repo.archived) return false;
    if (!options.includeForks && repo.fork) return false;
    if (!options.includePrivate && repo.private) return false;
    if (options.ownerFilters.length > 0) {
      const owner = String(repo.owner?.login || "").trim().toLowerCase();
      return options.ownerFilters.includes(owner);
    }
    return true;
  });

  filteredRepos = filteredRepos.sort((a, b) => a.full_name.localeCompare(b.full_name));
  if (options.maxRepos && filteredRepos.length > options.maxRepos) {
    filteredRepos = filteredRepos.slice(0, options.maxRepos);
  }

  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const perRepo = await mapWithConcurrency(
    filteredRepos,
    6,
    async (repo) => collectRepoItems(token, repo, options.state, options.activeWithinHours, nowMs),
  );

  const repoSummariesAll = perRepo.map((entry) => entry.repo);
  const repoSummariesWithItems = repoSummariesAll
    .filter((repo) => repo.total > 0)
    .sort((a, b) => b.total - a.total || a.full_name.localeCompare(b.full_name));

  const items = perRepo
    .flatMap((entry) => entry.items)
    .sort((a, b) => {
      const leftTs = Date.parse(a.updated_at) || 0;
      const rightTs = Date.parse(b.updated_at) || 0;
      if (rightTs !== leftTs) return rightTs - leftTs;
      if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.number - b.number;
    });

  const history = loadHistory(historyYaml);
  const db = openAnalyticsDb(options.dbPath);
  const legacySnapshotsImported = importLegacyHistoryIntoDb(db, history, historyYaml);
  const syncRun = startSyncRun(db, generatedAt, {
    state: options.state,
    include_archived: options.includeArchived,
    include_forks: options.includeForks,
    include_private: options.includePrivate,
    owner_filters: options.ownerFilters,
    recent_activity_hours: options.activeWithinHours ?? null,
    repos_scanned: filteredRepos.length,
  });
  for (const entry of perRepo) syncRepoToDb(db, entry, generatedAt);

  upsertRepoHistory(history, repoSummariesAll, generatedAt, options.historyPoints);
  const trends = loadRepoTrendsFromDb(db, repoSummariesAll, options.chartPoints);
  const starChanges = trends.filter((trend) => trend.deltas.stars !== 0);
  const starGains = trends.filter((trend) => trend.deltas.stars > 0);

  const report: Report = {
    generated_at: generatedAt,
    state: options.state,
    include_archived: options.includeArchived,
    include_forks: options.includeForks,
    include_private: options.includePrivate,
    owner_filters: options.ownerFilters,
    recent_activity_hours: options.activeWithinHours ?? null,
    totals: {
      repos_scanned: filteredRepos.length,
      repos_with_items: repoSummariesWithItems.length,
      total_items: items.length,
      total_issues: items.filter((item) => item.type === "issue").length,
      total_pull_requests: items.filter((item) => item.type === "pull_request").length,
      repos_with_star_changes: starChanges.length,
      repos_with_star_gains: starGains.length,
    },
    repos: repoSummariesWithItems,
    items: items.map(toOutputItem),
  };

  const slug = timestampSlug();
  const jsonPath = resolve(options.outputJson || join(options.outputDir, `github-items-${options.state}-${slug}.json`));
  const markdownPath = resolve(options.outputMarkdown || join(options.outputDir, `github-items-${options.state}-${slug}.md`));
  const markdown = renderMarkdown(report, trends, options.chartPoints);

  ensureParentDir(jsonPath);
  ensureParentDir(markdownPath);
  ensureParentDir(historyYaml);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, `${markdown}\n`, "utf8");
  writeFileSync(historyYaml, `${YAML.dump(history, { lineWidth: 120, noRefs: true })}\n`, "utf8");
  finishSyncRun(db, syncRun, new Date().toISOString(), {
    ...report.totals,
    legacy_snapshots_imported: legacySnapshotsImported,
  });
  db.close();

  console.log(JSON.stringify({
    json: jsonPath,
    markdown: markdownPath,
    history: historyYaml,
    database: options.dbPath,
    legacy_snapshots_imported: legacySnapshotsImported,
    totals: report.totals,
  }, null, 2));
}

if (import.meta.main) {
  await main();
}
