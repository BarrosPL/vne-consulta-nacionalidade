import "dotenv/config";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const pendencias = (await client.query(`
    SELECT count(*)::integer AS total,
           count(*) FILTER (WHERE processo_finalizado)::integer AS finalizados
      FROM public.nacionalidade_portuguesa
     WHERE ativo_na_planilha
       AND NOT registro_duplicado
       AND kommo_pendente
  `)).rows[0];
  const consultas = (await client.query(`
    SELECT count(*)::integer AS registros,
           count(DISTINCT btrim(codigo_consulta))::integer AS codigos_distintos
      FROM public.nacionalidade_portuguesa
     WHERE nullif(btrim(codigo_consulta), '') IS NOT NULL
       AND ativo_na_planilha
       AND NOT registro_duplicado
       AND NOT processo_finalizado
  `)).rows[0];
  const salesbots = (await client.query(`
    SELECT
      count(*) FILTER (
        WHERE tipo='mudanca_fase'
          AND status_disparo='erro'
          AND ultima_tentativa_em <= now() - interval '15 minutes'
      )::integer AS mudancas_com_falha,
      count(*) FILTER (
        WHERE status_disparo='processando'
      )::integer AS processando
      FROM public.disparos_salesbot_nacionalidade
  `)).rows[0];
  const lembretes = (await client.query(`
    WITH vencidos AS (
      SELECT s.nacionalidade_id, s.status_id_sincronizado AS status_id,
             s.etapa_entrou_em,
             floor(extract(epoch FROM (now() - s.etapa_entrou_em))
               / (30::numeric * 86400))::integer AS ciclo
        FROM public.sincronizacao_crm_nacionalidade s
        JOIN public.nacionalidade_portuguesa n ON n.id=s.nacionalidade_id
       WHERE n.ativo_na_planilha
         AND NOT n.registro_duplicado
         AND NOT n.processo_finalizado
         AND s.crm_lead_id IS NOT NULL
         AND s.etapa_entrou_em <= now() - interval '30 days'
         AND s.status_id_sincronizado = ANY($1::bigint[])
    )
    SELECT count(*)::integer AS total
      FROM vencidos v
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.disparos_salesbot_nacionalidade d
        WHERE d.nacionalidade_id=v.nacionalidade_id
          AND d.status_id=v.status_id
          AND d.etapa_entrou_em=v.etapa_entrou_em
          AND d.tipo='lembrete_30_dias'
          AND d.ciclo_lembrete=v.ciclo
          AND d.status_disparo IN ('processando', 'sucesso')
     )
  `, [[
    Number(process.env.KOMMO_STATUS_FASE_1 ?? 106133612),
    Number(process.env.KOMMO_STATUS_FASE_2 ?? 100204688),
    Number(process.env.KOMMO_STATUS_FASE_3 ?? 100204696)
  ]])).rows[0];
  const ultimoCiclo = (await client.query(`
    SELECT *
      FROM public.ciclos_consulta_nacionalidade
     ORDER BY id DESC
     LIMIT 1
  `)).rows[0] ?? null;

  console.log(JSON.stringify({
    verificado_em: new Date().toISOString(),
    pendencias_kommo: pendencias,
    elegiveis_consulta_processual: consultas,
    lembretes_30_dias_vencidos: lembretes.total,
    salesbots,
    ultimo_ciclo_consulta: ultimoCiclo
  }, null, 2));
  await client.query("ROLLBACK");
} finally {
  await client.end().catch(() => {});
}
