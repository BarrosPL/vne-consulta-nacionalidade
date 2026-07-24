import "dotenv/config";
import fs from "node:fs/promises";
import pg from "pg";

const reportPath = process.argv[2];
if (!reportPath) throw new Error("Informe o caminho do relatório.");

const raw = await fs.readFile(reportPath, "utf8");
const jsonStart = raw.indexOf("{");
if (jsonStart < 0) throw new Error("JSON do relatório não encontrado.");
const report = JSON.parse(raw.slice(jsonStart));
const ids = report.detalhes.map((item) => Number(item.id));
const startedAt = new Date(report.iniciado_em);
const finishedAt = new Date(report.finalizado_em);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const records = (await client.query(`
    SELECT n.id, n.id_registro, n.id_planilha, n.cliente, n.codigo_consulta,
           n.ativo_na_planilha, n.registro_duplicado,
           n.fase_consulta_automatica, n.posicao_fase,
           n.total_fases, n.data_fase, n.data_ultima_consulta,
           n.data_ultima_tentativa, n.status_ultima_tentativa,
           n.erro_ultima_tentativa, n.processo_finalizado, n.kommo_pendente,
           n.motivo_pendencia_kommo,
           s.crm_lead_id, s.crm_nota_status_id, s.status_id_sincronizado,
           s.motivo_movimentacao, s.status_ultima_tentativa AS kommo_status,
           s.erro_ultima_tentativa AS kommo_erro, s.ultima_tentativa_em AS kommo_tentativa_em,
           s.nota_atualizada_em, s.etapa_entrou_em,
           s.lead_criado_pelo_sistema, s.criado_no_kommo_em
      FROM public.nacionalidade_portuguesa n
      LEFT JOIN public.sincronizacao_crm_nacionalidade s
        ON s.nacionalidade_id=n.id
     WHERE n.id=ANY($1::bigint[])
     ORDER BY n.id
  `, [ids])).rows;
  const history = (await client.query(`
    SELECT h.id, h.nacionalidade_id, h.sucesso, h.fase, h.posicao_fase,
           h.total_fases, h.observacao, h.consultado_em
      FROM public.historico_consultas_nacionalidade h
     WHERE h.nacionalidade_id=ANY($1::bigint[])
       AND h.consultado_em BETWEEN $2 AND $3
     ORDER BY h.consultado_em
  `, [ids, startedAt, new Date(finishedAt.getTime() + 60000)])).rows;
  const salesbots = (await client.query(`
    SELECT nacionalidade_id, crm_lead_id, status_id, salesbot_id, tipo,
           ciclo_lembrete, status_disparo, http_status, tentativas, erro,
           criado_em, ultima_tentativa_em, disparado_em, disparar_apos
      FROM public.disparos_salesbot_nacionalidade
     WHERE nacionalidade_id=ANY($1::bigint[])
       AND (
         criado_em BETWEEN $2 AND $3
         OR ultima_tentativa_em BETWEEN $2 AND $3
         OR disparado_em BETWEEN $2 AND $3
       )
     ORDER BY criado_em, id
  `, [ids, startedAt, new Date(finishedAt.getTime() + 60000)])).rows;
  if (process.argv.includes("--resumo")) {
    const byId = new Map(records.map((record) => [Number(record.id), record]));
    const errorDetails = report.detalhes
      .filter((detail) => detail.consulta === "erro")
      .map((detail) => ({
        id: Number(detail.id),
        cliente: detail.cliente,
        erro_relatorio: detail.erro_consulta,
        tentativa_banco: byId.get(Number(detail.id))?.data_ultima_tentativa ?? null,
        erro_banco: byId.get(Number(detail.id))?.erro_ultima_tentativa ?? null,
        id_registro: byId.get(Number(detail.id))?.id_registro ?? null,
        ativo: byId.get(Number(detail.id))?.ativo_na_planilha ?? null,
        duplicado: byId.get(Number(detail.id))?.registro_duplicado ?? null,
        crm_lead_id: byId.get(Number(detail.id))?.crm_lead_id ?? null,
        crm_status_id: byId.get(Number(detail.id))?.status_id_sincronizado ?? null,
        crm_decisao: byId.get(Number(detail.id))?.motivo_movimentacao ?? null,
        crm_nota_id: byId.get(Number(detail.id))?.crm_nota_status_id ?? null,
        crm_tentativa: byId.get(Number(detail.id))?.kommo_tentativa_em ?? null
      }));
    const errorGroups = {};
    for (const detail of errorDetails) {
      const message = detail.erro_banco ?? detail.erro_relatorio ?? "";
      const category = message.includes("[captcha]") ? "captcha"
        : message.includes("[codigo]") ? "codigo"
          : message.includes("[extracao]") ? "extracao"
            : "sem_tentativa";
      errorGroups[category] ??= [];
      errorGroups[category].push({ id: detail.id, cliente: detail.cliente });
    }
    const phaseGroups = {};
    for (const item of history.filter((item) => item.sucesso)) {
      const key = `${item.posicao_fase ?? "-"} - ${item.fase ?? "sem fase"}`;
      phaseGroups[key] = (phaseGroups[key] ?? 0) + 1;
    }
    const kommoAttempts = records.filter((record) => {
      const date = record.kommo_tentativa_em && new Date(record.kommo_tentativa_em);
      return date && date >= startedAt && date <= new Date(finishedAt.getTime() + 60000);
    });
    console.log(JSON.stringify({
      relatorio: {
        selecionados: report.selecionados,
        duracao_minutos: report.duracao_minutos,
        consultas_sucesso: report.consultas_sucesso,
        consultas_erro: report.consultas_erro,
        kommo_sucesso: report.kommo_sucesso,
        kommo_erro: report.kommo_erro
      },
      fases_consultadas: phaseGroups,
      erros_consulta_por_categoria: errorGroups,
      detalhes_erros: errorDetails,
      banco: {
        historicos_gravados: history.length,
        historicos_sucesso: history.filter((item) => item.sucesso).length,
        historicos_erro: history.filter((item) => !item.sucesso).length,
        tentativas_kommo_no_periodo: kommoAttempts.length,
        tentativas_kommo_sucesso: kommoAttempts.filter(
          (item) => item.kommo_status === "sucesso"
        ).length,
        notas_atualizadas_no_periodo: records.filter((record) => {
          const date = record.nota_atualizada_em && new Date(record.nota_atualizada_em);
          return date && date >= startedAt && date <= new Date(finishedAt.getTime() + 60000);
        }).length,
        leads_criados_no_periodo: records.filter((record) => {
          const date = record.criado_no_kommo_em && new Date(record.criado_no_kommo_em);
          return date && date >= startedAt && date <= new Date(finishedAt.getTime() + 60000);
        }).length,
        salesbots: salesbots
      }
    }, null, 2));
    await client.query("ROLLBACK");
    process.exit(0);
  }
  console.log(JSON.stringify({
    relatorio: {
      iniciado_em: report.iniciado_em,
      finalizado_em: report.finalizado_em,
      selecionados: report.selecionados,
      consultas_sucesso: report.consultas_sucesso,
      consultas_erro: report.consultas_erro,
      kommo_sucesso: report.kommo_sucesso,
      kommo_erro: report.kommo_erro
    },
    registros: records,
    historico_no_periodo: history,
    salesbots_no_periodo: salesbots
  }, null, 2));
  await client.query("ROLLBACK");
} finally {
  await client.end().catch(() => {});
}
