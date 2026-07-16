import "dotenv/config";
import pg from "pg";
import { openPostgresStorage } from "../consulta_status.js";

const expectedColumns = [
  "fase_consulta_automatica", "posicao_fase", "total_fases", "data_fase",
  "possui_notificacao", "titulos_notificacoes", "data_ultima_consulta",
  "observacao_consulta"
];
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const columns = (await client.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'nacionalidade_portuguesa'
       AND column_name = ANY($1::text[])
  `, [expectedColumns])).rows.map(({ column_name }) => column_name);
  const history = (await client.query(`
    SELECT to_regclass('public.historico_consultas_nacionalidade')::text AS tabela,
           (SELECT count(*)::int FROM public.historico_consultas_nacionalidade) AS registros
  `)).rows[0];
  const eligible = Number((await client.query(`
    SELECT count(*)
      FROM public.nacionalidade_portuguesa
     WHERE nullif(btrim(codigo_consulta), '') IS NOT NULL
       AND fase_consulta_automatica IS NULL
  `)).rows[0].count);
  const testRecord = (await client.query(`
    SELECT id_registro
      FROM public.nacionalidade_portuguesa
     WHERE nullif(btrim(codigo_consulta), '') IS NOT NULL
       AND fase_consulta_automatica IS NULL
     ORDER BY id
     LIMIT 1
  `)).rows[0];
  const missing = expectedColumns.filter((name) => !columns.includes(name));

  if (missing.length || !history.tabela) {
    throw new Error(`Migracao incompleta. Colunas ausentes: ${missing.join(", ") || "nenhuma"}`);
  }
  if (!testRecord) throw new Error("Nenhum registro elegivel para validar a selecao.");

  const storage = await openPostgresStorage({
    modo_teste: true,
    id_registro_teste: testRecord.id_registro,
    limite_por_execucao: 1,
    reconsultar_processados: false
  });
  const selectionValid = storage.rowCount === 2 && Boolean(storage.getCodigo(2));
  await storage.close();
  if (!selectionValid) throw new Error("A camada PostgreSQL nao selecionou exatamente um codigo.");

  console.log(JSON.stringify({
    migracao_valida: true,
    colunas_automaticas: columns.length,
    tabela_historico: history.tabela,
    registros_historico: history.registros,
    registros_elegiveis: eligible,
    selecao_modo_teste: "1 codigo, 1 registro"
  }, null, 2));
  await client.query("ROLLBACK");
} finally {
  await client.end().catch(() => {});
}
