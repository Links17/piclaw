/**
 * Lightweight host metrics for the web HUD (ported from runtime, cloud runtime snapshot simplified).
 */
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

export interface SystemMetricsSnapshot {
  cpu_percent: number;
  ram_percent: number;
  swap_percent: number | null;
  cpu_series: number[];
  ram_series: number[];
  swap_series: number[];
  buffer_cache_bytes: number | null;
  buffer_cache_series_bytes: number[];
  process_rss_series_bytes: number[];
  process_heap_used_series_bytes: number[];
  swap_total_bytes: number;
  swap_used_bytes: number;
  sample_interval_ms: number;
  platform: NodeJS.Platform;
  process_memory: {
    rss_bytes: number;
    heap_total_bytes: number;
    heap_used_bytes: number;
    external_bytes: number;
    array_buffers_bytes: number;
    vm_rss_bytes: number | null;
    vm_hwm_bytes: number | null;
    rss_anon_bytes: number | null;
    rss_file_bytes: number | null;
    rss_shmem_bytes: number | null;
    pss_bytes: number | null;
    private_clean_bytes: number | null;
    private_dirty_bytes: number | null;
    shared_clean_bytes: number | null;
    shared_dirty_bytes: number | null;
    cgroup_memory_current_bytes: number | null;
    threads: number | null;
  };
  runtime_memory: {
    active_chats: number;
    replica_id: string;
  } | null;
  vram_percent: number | null;
  vram_series: number[];
  vram_total_bytes: number;
  vram_used_bytes: number;
  gpu_provider: string | null;
}

type CpuTotals = { idle: number; total: number };

function readCpuTotals(): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const times = cpu?.times;
    if (!times) continue;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

function roundPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function pushSample(series: number[], value: number, maxSamples: number): number[] {
  const next = [...series, value];
  return next.length > maxSamples ? next.slice(next.length - maxSamples) : next;
}

function parseKbLine(text: string, label: string): number | null {
  const match = text.match(new RegExp(`^${label}:\\s+(\\d+)\\s+kB$`, "m"));
  if (!match) return null;
  const kb = Number(match[1]);
  return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null;
}

function readRamUsage() {
  if (process.platform === "linux") {
    try {
      const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
      const totalBytes = parseKbLine(meminfo, "MemTotal");
      const availableBytes = parseKbLine(meminfo, "MemAvailable");
      if (totalBytes && availableBytes != null && totalBytes > 0) {
        const usedBytes = Math.max(0, totalBytes - Math.min(availableBytes, totalBytes));
        return {
          totalBytes,
          usedBytes,
          percent: roundPercent((usedBytes / totalBytes) * 100),
          bufferCacheBytes: null as number | null,
        };
      }
    } catch {
      // fall through
    }
  }
  const totalBytes = os.totalmem();
  const usedBytes = Math.max(0, totalBytes - os.freemem());
  return {
    totalBytes,
    usedBytes,
    percent: roundPercent(totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0),
    bufferCacheBytes: null as number | null,
  };
}

function readSwapUsage() {
  if (process.platform !== "linux") return null;
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const totalBytes = parseKbLine(meminfo, "SwapTotal");
    const freeBytes = parseKbLine(meminfo, "SwapFree");
    if (!totalBytes || freeBytes == null || totalBytes <= 0) return null;
    const usedBytes = Math.max(0, totalBytes - Math.min(freeBytes, totalBytes));
    return { totalBytes, usedBytes, percent: roundPercent((usedBytes / totalBytes) * 100) };
  } catch {
    return null;
  }
}

function readGpuVramUsage() {
  try {
    const result = spawnSync("nvidia-smi", [
      "--query-gpu=memory.used,memory.total",
      "--format=csv,noheader,nounits",
    ], { encoding: "utf8", timeout: 1000, windowsHide: true });
    if (result.status !== 0) return null;
    let usedMiB = 0;
    let totalMiB = 0;
    for (const row of String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      const [usedRaw, totalRaw] = row.split(",").map((value) => value.trim());
      usedMiB += Number(usedRaw);
      totalMiB += Number(totalRaw);
    }
    if (!Number.isFinite(totalMiB) || totalMiB <= 0) return null;
    const usedBytes = Math.round(usedMiB * 1024 * 1024);
    const totalBytes = Math.round(totalMiB * 1024 * 1024);
    return {
      totalBytes,
      usedBytes: Math.min(usedBytes, totalBytes),
      percent: roundPercent((Math.min(usedMiB, totalMiB) / totalMiB) * 100),
      provider: "nvidia-smi",
    };
  } catch {
    return null;
  }
}

export class SystemMetricsSampler {
  private lastCpuTotals: CpuTotals | null = null;
  private cpuSeries: number[] = [];
  private ramSeries: number[] = [];
  private swapSeries: number[] = [];
  private vramSeries: number[] = [];
  private bufferCacheSeriesBytes: number[] = [];
  private processRssSeriesBytes: number[] = [];
  private processHeapUsedSeriesBytes: number[] = [];

  constructor(
    private readonly maxSamples = 30,
    readonly sampleIntervalMs = 2000,
  ) {}

  readSnapshot(runtimeMemory: SystemMetricsSnapshot["runtime_memory"]): SystemMetricsSnapshot {
    const currentCpuTotals = readCpuTotals();
    let cpuPercent = 0;
    if (this.lastCpuTotals) {
      const deltaIdle = currentCpuTotals.idle - this.lastCpuTotals.idle;
      const deltaTotal = currentCpuTotals.total - this.lastCpuTotals.total;
      cpuPercent = deltaTotal > 0 ? ((deltaTotal - deltaIdle) / deltaTotal) * 100 : 0;
    }
    this.lastCpuTotals = currentCpuTotals;

    const ramUsage = readRamUsage();
    const swapUsage = readSwapUsage();
    const gpuVramUsage = readGpuVramUsage();
    const cpuValue = roundPercent(cpuPercent);
    this.cpuSeries = pushSample(this.cpuSeries, cpuValue, this.maxSamples);
    this.ramSeries = pushSample(this.ramSeries, ramUsage.percent, this.maxSamples);
    this.swapSeries = swapUsage ? pushSample(this.swapSeries, swapUsage.percent, this.maxSamples) : [];
    this.vramSeries = gpuVramUsage ? pushSample(this.vramSeries, gpuVramUsage.percent, this.maxSamples) : [];
    this.bufferCacheSeriesBytes = ramUsage.bufferCacheBytes == null
      ? []
      : pushSample(this.bufferCacheSeriesBytes, ramUsage.bufferCacheBytes, this.maxSamples);

    const processMemoryUsage = process.memoryUsage();
    this.processRssSeriesBytes = pushSample(this.processRssSeriesBytes, processMemoryUsage.rss, this.maxSamples);
    this.processHeapUsedSeriesBytes = pushSample(this.processHeapUsedSeriesBytes, processMemoryUsage.heapUsed, this.maxSamples);

    return {
      cpu_percent: cpuValue,
      ram_percent: ramUsage.percent,
      swap_percent: swapUsage?.percent ?? null,
      cpu_series: [...this.cpuSeries],
      ram_series: [...this.ramSeries],
      swap_series: [...this.swapSeries],
      vram_percent: gpuVramUsage?.percent ?? null,
      vram_series: [...this.vramSeries],
      vram_total_bytes: gpuVramUsage?.totalBytes ?? 0,
      vram_used_bytes: gpuVramUsage?.usedBytes ?? 0,
      gpu_provider: gpuVramUsage?.provider ?? null,
      buffer_cache_bytes: ramUsage.bufferCacheBytes,
      buffer_cache_series_bytes: [...this.bufferCacheSeriesBytes],
      process_rss_series_bytes: [...this.processRssSeriesBytes],
      process_heap_used_series_bytes: [...this.processHeapUsedSeriesBytes],
      swap_total_bytes: swapUsage?.totalBytes ?? 0,
      swap_used_bytes: swapUsage?.usedBytes ?? 0,
      sample_interval_ms: this.sampleIntervalMs,
      platform: process.platform,
      process_memory: {
        rss_bytes: processMemoryUsage.rss,
        heap_total_bytes: processMemoryUsage.heapTotal,
        heap_used_bytes: processMemoryUsage.heapUsed,
        external_bytes: processMemoryUsage.external,
        array_buffers_bytes: processMemoryUsage.arrayBuffers,
        vm_rss_bytes: null,
        vm_hwm_bytes: null,
        rss_anon_bytes: null,
        rss_file_bytes: null,
        rss_shmem_bytes: null,
        pss_bytes: null,
        private_clean_bytes: null,
        private_dirty_bytes: null,
        shared_clean_bytes: null,
        shared_dirty_bytes: null,
        cgroup_memory_current_bytes: null,
        threads: null,
      },
      runtime_memory: runtimeMemory,
    };
  }
}

const defaultSampler = new SystemMetricsSampler();

export function readSystemMetrics(runtimeMemory: SystemMetricsSnapshot["runtime_memory"]): SystemMetricsSnapshot {
  return defaultSampler.readSnapshot(runtimeMemory);
}
