import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const sql = databaseUrl
  ? postgres(databaseUrl, { max: 1, prepare: false })
  : null;

describe.skipIf(!databaseUrl)("PostGIS game predicates", () => {
  afterAll(async () => {
    await sql?.end();
  });

  it("treats a polygon edge as inside and an exterior point as outside", async () => {
    const [result] = await sql!<{ edge: boolean; outside: boolean }[]>`
      with zone as (select ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))', 4326) polygon)
      select ST_Covers(polygon, ST_SetSRID(ST_Point(0, 0.5), 4326)) as edge,
        ST_Covers(polygon, ST_SetSRID(ST_Point(1.01, 0.5), 4326)) as outside from zone
    `;
    expect(result).toEqual({ edge: true, outside: false });
  });

  it("uses geography metres for tag range", async () => {
    const [result] = await sql!<{ near: boolean; far: boolean }[]>`
      select
        ST_DWithin(ST_SetSRID(ST_Point(0, 51), 4326)::geography, ST_SetSRID(ST_Point(0.0001, 51), 4326)::geography, 15) as near,
        ST_DWithin(ST_SetSRID(ST_Point(0, 51), 4326)::geography, ST_SetSRID(ST_Point(0.01, 51), 4326)::geography, 15) as far
    `;
    expect(result).toEqual({ near: true, far: false });
  });
});
