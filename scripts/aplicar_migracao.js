import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const migration = process.argv[2];
if (!migration) throw new Error("Informe o arquivo de migracao.");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL nao definida no .env.");

const migrationPath = path.resolve(migration);
const sql = await fs.readFile(migrationPath, "utf8");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  await client.query("SET statement_timeout = '30s'");
  await client.query(sql);
  console.log(`Migracao aplicada: ${migrationPath}`);
} finally {
  await client.end().catch(() => {});
}
