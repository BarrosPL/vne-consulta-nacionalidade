import "dotenv/config";
import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL nao definida no .env.");
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function query(text) {
  return (await client.query(text)).rows;
}

try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = '30s'");

  const database = (await client.query(`
    SELECT current_database() AS database,
           current_user AS usuario,
           version() AS versao
  `)).rows[0];

  const schemas = await query(`
    SELECT schema_name AS schema
      FROM information_schema.schemata
     WHERE schema_name <> 'information_schema'
       AND schema_name NOT LIKE 'pg_%'
     ORDER BY schema_name
  `);

  const relations = await query(`
    SELECT n.nspname AS schema,
           c.relname AS nome,
           CASE c.relkind
             WHEN 'r' THEN 'tabela'
             WHEN 'p' THEN 'tabela_particionada'
             WHEN 'v' THEN 'view'
             WHEN 'm' THEN 'materialized_view'
             WHEN 'f' THEN 'foreign_table'
           END AS tipo,
           CASE WHEN c.relkind IN ('r', 'p') THEN c.reltuples::bigint END AS linhas_estimadas
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname <> 'information_schema'
       AND n.nspname NOT LIKE 'pg_%'
     ORDER BY n.nspname, c.relname
  `);

  const columns = await query(`
    SELECT table_schema AS schema,
           table_name AS tabela,
           ordinal_position AS posicao,
           column_name AS coluna,
           data_type AS tipo,
           udt_name AS tipo_interno,
           is_nullable = 'YES' AS aceita_nulo,
           column_default AS valor_padrao
      FROM information_schema.columns
     WHERE table_schema <> 'information_schema'
       AND table_schema NOT LIKE 'pg_%'
     ORDER BY table_schema, table_name, ordinal_position
  `);

  const constraints = await query(`
    SELECT tc.table_schema AS schema,
           tc.table_name AS tabela,
           tc.constraint_name AS nome,
           tc.constraint_type AS tipo,
           string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS colunas
      FROM information_schema.table_constraints tc
 LEFT JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema = tc.constraint_schema
       AND kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
       AND kcu.table_name = tc.table_name
     WHERE tc.table_schema <> 'information_schema'
       AND tc.table_schema NOT LIKE 'pg_%'
     GROUP BY tc.table_schema, tc.table_name, tc.constraint_name, tc.constraint_type
     ORDER BY tc.table_schema, tc.table_name, tc.constraint_type, tc.constraint_name
  `);

  const foreignKeys = await query(`
    SELECT tc.table_schema AS schema_origem,
           tc.table_name AS tabela_origem,
           kcu.column_name AS coluna_origem,
           ccu.table_schema AS schema_destino,
           ccu.table_name AS tabela_destino,
           ccu.column_name AS coluna_destino,
           tc.constraint_name AS nome
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema = tc.constraint_schema
       AND kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_schema = tc.constraint_schema
       AND ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY'
     ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position
  `);

  const indexes = await query(`
    SELECT schemaname AS schema,
           tablename AS tabela,
           indexname AS nome,
           indexdef AS definicao
      FROM pg_indexes
     WHERE schemaname <> 'information_schema'
       AND schemaname NOT LIKE 'pg_%'
     ORDER BY schemaname, tablename, indexname
  `);

  console.log(JSON.stringify({ database, schemas, relations, columns, constraints, foreignKeys, indexes }, null, 2));
  await client.query("ROLLBACK");
} finally {
  await client.end().catch(() => {});
}
