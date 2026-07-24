import "dotenv/config";
import pg from "pg";

const ids = process.argv.slice(2).map(Number);
if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
  throw new Error("Informe um ou mais IDs internos válidos.");
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  const result = await client.query(`
    UPDATE public.nacionalidade_portuguesa
       SET processo_finalizado=true,
           processo_finalizado_em=coalesce(processo_finalizado_em, now()),
           motivo_finalizacao='portal_senha_nao_corresponde_processo',
           atualizado_em=now()
     WHERE id=ANY($1::bigint[])
     RETURNING id, cliente, codigo_consulta, processo_finalizado,
               processo_finalizado_em, motivo_finalizacao,
               kommo_pendente, motivo_pendencia_kommo
  `, [ids]);
  if (result.rowCount !== ids.length) {
    throw new Error(
      `Esperados ${ids.length} registros, mas apenas ${result.rowCount} foram encontrados.`
    );
  }
  await client.query("COMMIT");
  console.log(JSON.stringify(result.rows, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end().catch(() => {});
}
