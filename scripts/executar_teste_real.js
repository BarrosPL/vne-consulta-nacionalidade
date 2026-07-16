import "dotenv/config";
import { spawn } from "node:child_process";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
let idRegistro;

try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const result = await client.query(`
    SELECT id_registro
      FROM public.nacionalidade_portuguesa
     WHERE nullif(btrim(codigo_consulta), '') IS NOT NULL
       AND fase_consulta_automatica IS NULL
     ORDER BY id
     LIMIT 1
  `);
  idRegistro = result.rows[0]?.id_registro;
  await client.query("ROLLBACK");
} finally {
  await client.end().catch(() => {});
}

if (!idRegistro) throw new Error("Nenhum registro elegivel para o teste real.");

const child = spawn(process.execPath, ["consulta_status.js"], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: {
    ...process.env,
    POSTGRES_TEST_RECORD_ID: idRegistro,
    POSTGRES_SIMULAR: "false"
  }
});

child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
