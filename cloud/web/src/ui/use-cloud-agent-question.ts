import { useEffect, useState } from '../vendor/preact-htm.js';
import {
  getCloudAgentQuestion,
  setCloudAgentQuestion,
  subscribeCloudAgentExtensions,
  type CloudAgentQuestion,
} from './app-cloud-agent-extensions.js';

export function useCloudAgentQuestion(): CloudAgentQuestion | null {
  const [question, setQuestion] = useState(() => getCloudAgentQuestion());
  useEffect(() => subscribeCloudAgentExtensions(() => setQuestion(getCloudAgentQuestion())), []);
  return question;
}

export function clearCloudAgentQuestion(): void {
  setCloudAgentQuestion(null);
}
