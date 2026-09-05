import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  canonicalMigrationChecksum,
  matchesMigrationChecksum,
} from "./migration-checksum.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const directory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const sql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  onnotice: () => undefined,
});

try {
  await sql`select pg_advisory_lock(hashtext('geohunter_migrations'))`;
  await sql`
    create table if not exists _schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `;

  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const source = await readFile(join(directory, file), "utf8");
    const checksum = canonicalMigrationChecksum(source);
    const [existing] = await sql<
      { checksum: string }[]
    >`select checksum from _schema_migrations where name = ${file}`;
    if (existing) {
      if (!matchesMigrationChecksum(source, existing.checksum))
        throw new Error(`Applied migration changed: ${file}`);
      continue;
    }
    await sql.begin(async (transaction) => {
      await transaction.unsafe(source);
      await transaction`insert into _schema_migrations (name, checksum) values (${file}, ${checksum})`;
    });
    process.stdout.write(`Applied ${file}\n`);
  }
  await sql`select ensure_location_sample_partitions(60)`;
} finally {
  await sql`select pg_advisory_unlock(hashtext('geohunter_migrations'))`.catch(
    () => undefined,
  );
  await sql.end();
}
