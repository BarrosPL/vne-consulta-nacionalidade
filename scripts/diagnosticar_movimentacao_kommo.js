import "dotenv/config";
import pg from "pg";

const nacionalidadeId = Number(process.argv[2]);
if (!Number.isSafeInteger(nacionalidadeId) || nacionalidadeId <= 0) {
  throw new Error("Informe o ID interno do registro.");
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const result = await client.query(`
    SELECT n.id, n.cliente, n.status, n.anotacoes,
           n.fase_consulta_automatica, n.posicao_fase, n.processo_finalizado,
           s.crm_lead_id, s.status_id_sincronizado, s.fase_sincronizada,
           s.etapa_entrou_em
      FROM public.nacionalidade_portuguesa n
      LEFT JOIN public.sincronizacao_crm_nacionalidade s
        ON s.nacionalidade_id=n.id
     WHERE n.id=$1
  `, [nacionalidadeId]);
  const record = result.rows[0];
  if (!record) throw new Error("Registro não encontrado.");

  let kommoLead = null;
  const baseUrl = String(process.env.KOMMO_BASE_URL).replace(/\/$/, "");
  const route = record.crm_lead_id
    ? `/api/v4/leads/${record.crm_lead_id}`
    : `/api/v4/leads?query=${encodeURIComponent(record.cliente)}&limit=50`;
  {
    const response = await fetch(`${baseUrl}${route}`, {
      headers: {
        Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`,
        Accept: "application/json"
      }
    });
    if (!response.ok) throw new Error(`Kommo HTTP ${response.status}.`);
    const body = await response.json();
    const leads = record.crm_lead_id ? [body] : body?._embedded?.leads ?? [];
    kommoLead = leads.map((lead) => ({
      id: lead.id,
      nome: lead.name,
      pipeline_id: lead.pipeline_id,
      status_id: lead.status_id
    }));
  }
  console.log(JSON.stringify({ banco: record, kommo: kommoLead }, null, 2));
  await client.query("ROLLBACK");
} finally {
  await client.end().catch(() => {});
}
