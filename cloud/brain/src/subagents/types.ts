export interface CodingSubagentResult {
  runId: string;
  status: "completed" | "failed" | "timed_out" | "cancelled";
  summary: string;
  artifacts: string[];
  usage: { inputTokens: number; outputTokens: number };
  error?: string;
}

export interface CodingSubagentOptions {
  task: string;
  timeoutMs?: number;
  constraints?: string;
}
