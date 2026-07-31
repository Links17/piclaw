/** Create a session with a fixed id for web-adapter /agent/* e2e scripts. */
export async function ensureE2eSession(
  base: string,
  sessionId: string,
  title = "e2e",
): Promise<void> {
  const res = await fetch(`${base}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: sessionId, title }),
  });
  if (!res.ok) {
    throw new Error(`create session failed: ${res.status} ${await res.text()}`);
  }
}
