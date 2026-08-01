const LEGACY_HELLO_PATTERN = /\bhello(?:,)?\s+world\b/i;
const USER_VISIBLE_OUTPUT_PATTERN = /\b(?:serial|tft|lcd|display)\s*\.\s*(?:print|println|drawstring|settext|show)\s*\(/i;

export function executableHelloLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .filter((line) => USER_VISIBLE_OUTPUT_PATTERN.test(line));
}

export function hasLegacyHelloOutput(content: string): boolean {
  return executableHelloLines(content).some((line) => LEGACY_HELLO_PATTERN.test(line));
}
