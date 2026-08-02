import { describe, expect, test } from "bun:test";
import { getGeneralSettingsSnapshot, normalizeIanaTimezone } from "./user-settings.ts";
import { sql } from "./db.ts";

describe("user timezone", () => {
  test("accepts canonical IANA timezones and null", () => {
    expect(normalizeIanaTimezone(" Asia/Shanghai ")).toBe("Asia/Shanghai");
    expect(normalizeIanaTimezone("UTC")).toBe("UTC");
    expect(normalizeIanaTimezone(null)).toBeNull();
  });

  test("rejects offsets and invalid zones", () => {
    expect(() => normalizeIanaTimezone("GMT+0800")).toThrow("valid IANA timezone");
    expect(() => normalizeIanaTimezone("Not/AZone")).toThrow("valid IANA timezone");
  });

  test("tolerates legacy invalid stored timezone while keeping writes strict", async () => {
    await sql`
      UPDATE users
      SET preferences = jsonb_set(
        CASE WHEN jsonb_typeof(preferences) = 'object' THEN preferences ELSE '{}'::jsonb END,
        '{timezone}',
        '"GMT+0800"'
      )
      WHERE id = 'default-user'`;
    expect((await getGeneralSettingsSnapshot()).timezone).toBeNull();
  });
});
