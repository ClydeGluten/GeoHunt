import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalMigrationChecksum,
  matchesMigrationChecksum,
} from "./migration-checksum.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

describe("migration checksums", () => {
  it("uses LF as the canonical checksum format", () => {
    expect(canonicalMigrationChecksum("select 1;\r\nselect 2;\r\n")).toBe(
      sha256("select 1;\nselect 2;\n"),
    );
  });

  it("accepts a legacy checksum produced from CRLF content", () => {
    const source = "select 1;\nselect 2;\n";
    const legacyChecksum = sha256("select 1;\r\nselect 2;\r\n");

    expect(matchesMigrationChecksum(source, legacyChecksum)).toBe(true);
  });

  it("rejects a checksum from changed SQL", () => {
    expect(matchesMigrationChecksum("select 1;\n", sha256("select 2;\n"))).toBe(
      false,
    );
  });
});
