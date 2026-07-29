/** Unique old_string → new_string replacement for sandbox files. */
export function applyUniqueEdit(content: string, oldString: string, newString: string): string {
  if (!oldString) throw new Error("old_string must not be empty");
  let index = 0;
  let count = 0;
  while (true) {
    const found = content.indexOf(oldString, index);
    if (found === -1) break;
    count += 1;
    if (count > 1) {
      throw new Error(`old_string appears ${count} times; edit requires exactly one match`);
    }
    index = found + oldString.length;
  }
  if (count === 0) throw new Error("old_string not found in file");
  return content.replace(oldString, newString);
}
