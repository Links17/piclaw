/** Keep only transcript rows at or before the user turn currently being executed. */
export function boundHistoryThroughMessageId<T extends { id: number }>(
  rows: T[],
  throughMessageId: number,
): T[] {
  return rows.filter((row) => row.id <= throughMessageId);
}
