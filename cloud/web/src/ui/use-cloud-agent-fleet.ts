import { useEffect, useState } from '../vendor/preact-htm.js';
import {
  getCloudFleetRuns,
  subscribeCloudAgentExtensions,
  type CloudFleetRun,
} from './app-cloud-agent-extensions.js';

export function useCloudAgentFleet(): CloudFleetRun[] {
  const [runs, setRuns] = useState(() => getCloudFleetRuns());
  useEffect(() => subscribeCloudAgentExtensions(() => setRuns(getCloudFleetRuns())), []);
  return runs;
}
