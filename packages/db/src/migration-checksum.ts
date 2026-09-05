import { createHash } from "node:crypto";

const sha256 = (source: string) =>
  createHash("sha256").update(source).digest("hex");

const normalizeLineEndings = (source: string) => source.replace(/\r\n?/g, "\n");

export function canonicalMigrationChecksum(source: string): string {
  return sha256(normalizeLineEndings(source));
}

export function matchesMigrationChecksum(
  source: string,
  existingChecksum: string,
): boolean {
  const normalized = normalizeLineEndings(source);
  const legacyCrlf = normalized.replace(/\n/g, "\r\n");
  return (
    existingChecksum === sha256(normalized) ||
    existingChecksum === sha256(legacyCrlf)
  );
}
