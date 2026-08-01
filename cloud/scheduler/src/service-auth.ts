import { isPlaceholderSchedulerServiceKey } from "@piclaw-cloud/shared/cloud-config";

export function canClaimScheduledTasks(serviceKey: string): boolean {
  return !isPlaceholderSchedulerServiceKey(serviceKey);
}
