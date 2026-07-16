import "dotenv/config";
import pg from "pg";

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = '30s'");

  const columns = (await client.query(`
    SELECT ordinal_position AS posicao,
           column_name AS coluna,
           data_type AS tipo,
           is_nullable = 'YES' AS aceita_nulo,
           column_default AS valor_padrao
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'nacionalidade_portuguesa'
     ORDER BY ordinal_position
  `)).rows;

  const constraints = (await client.query(`
    SELECT tc.constraint_name AS nome,
           tc.constraint_type AS tipo,
           string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS colunas
      FROM information_schema.table_constraints tc
 LEFT JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema = tc.constraint_schema
       AND kcu.constraint_name = tc.constraint_name
     WHERE tc.table_schema = 'public'
       AND tc.table_name = 'nacionalidade_portuguesa'
     GROUP BY tc.constraint_name, tc.constraint_type
     ORDER BY tc.constraint_type, tc.constraint_name
  `)).rows;

  const indexes = (await client.query(`
    SELECT indexname AS nome, indexdef AS definicao
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'nacionalidade_portuguesa'
     ORDER BY indexname
  `)).rows;

  const total = Number((await client.query(
    "SELECT count(*) AS total FROM public.nacionalidade_portuguesa"
  )).rows[0].total);

  const completenessParts = columns.map(({ coluna }) =>
    `count(${client.escapeIdentifier(coluna)})::int AS ${client.escapeIdentifier(coluna)}`
  );
  const preenchimento = (await client.query(
    `SELECT ${completenessParts.join(", ")} FROM public.nacionalidade_portuguesa`
  )).rows[0];

  const codigos = (await client.query(`
    SELECT count(*) FILTER (WHERE nullif(btrim(codigo_consulta), '') IS NOT NULL)::int AS preenchidos,
           count(DISTINCT nullif(btrim(codigo_consulta), ''))::int AS distintos,
           count(*) FILTER (WHERE nullif(btrim(codigo_consulta), '') IS NULL)::int AS ausentes
      FROM public.nacionalidade_portuguesa
  `)).rows[0];

  const codigosDuplicados = Number((await client.query(`
    SELECT count(*) AS total
      FROM (
        SELECT btrim(codigo_consulta)
          FROM public.nacionalidade_portuguesa
         WHERE nullif(btrim(codigo_consulta), '') IS NOT NULL
         GROUP BY btrim(codigo_consulta)
        HAVING count(*) > 1
      ) duplicados
  `)).rows[0].total);

  console.log(JSON.stringify({
    total,
    columns,
    preenchimento,
    codigos: { ...codigos, grupos_duplicados: codigosDuplicados },
    constraints,
    indexes
  }, null, 2));
  await client.query("ROLLBACK");
} finally {
  await client.end().catch(() => {});
}
