import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { google } from "googleapis";

const APPLY = process.argv.includes("--aplicar");
const LIMIT = Number(process.env.KOMMO_LIMITE_POR_EXECUCAO ?? 30);
const TEST_NACIONALIDADE_ID = process.env.KOMMO_TESTE_NACIONALIDADE_ID
  ? Number(process.env.KOMMO_TESTE_NACIONALIDADE_ID)
  : null;
const BASE_URL = String(process.env.KOMMO_BASE_URL ?? "https://vocenaeuropa.kommo.com").replace(/\/$/, "");
const TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const PIPELINE_ID = Number(process.env.KOMMO_PIPELINE_ID ?? 8322487);
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID
  ?? "10YNu_c-TGiSpb2QwfWDdQgQYuvXYXqwreCmxRETamFs";
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME ?? "Andamentos";
const CREDENTIALS_FILE = process.env.GOOGLE_CREDENTIALS_FILE ?? "google-service-account.json";

const STATUS = {
  iniciar: Number(process.env.KOMMO_STATUS_INICIAR_CONSULTA ?? 106133608),
  fase1: Number(process.env.KOMMO_STATUS_FASE_1 ?? 106133612),
  fase2: Number(process.env.KOMMO_STATUS_FASE_2 ?? 100204688),
  fase3: Number(process.env.KOMMO_STATUS_FASE_3 ?? 100204696),
  fase4: Number(process.env.KOMMO_STATUS_FASE_4 ?? 100204712),
  exigencia: Number(process.env.KOMMO_STATUS_EXIGENCIA ?? 76490168),
  risco: Number(process.env.KOMMO_STATUS_RISCO_INDEFERIMENTO ?? 105756056)
};

function text(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return text(value).normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase().replace(/\s+/g, " ");
}

function positiveMention(value, terms) {
  let normalized = normalize(value);
  for (const term of terms) {
    normalized = normalized
      .replaceAll(`sem ${term}`, "")
      .replaceAll(`nao possui ${term}`, "")
      .replaceAll(`não possui ${term}`, "");
  }
  return terms.some((term) => normalized.includes(term));
}

function targetStatus(record) {
  if (record.processo_finalizado) {
    return { id: STATUS.fase4, reason: "Processo finalizado → Fase 4" };
  }
  const combined = [
    record.status_manual, record.anotacoes,
    Array.isArray(record.titulos_notificacoes)
      ? record.titulos_notificacoes.join(" ")
      : record.titulos_notificacoes
  ].join(" ");
  if (positiveMention(combined, ["risco de indeferimento", "indeferimento", "indeferido"])) {
    return { id: STATUS.risco, reason: "Risco de indeferimento" };
  }
  if (positiveMention(combined, ["exigencia"])) {
    return { id: STATUS.exigencia, reason: "Cumprimento de Exigência" };
  }
  const position = Number(record.posicao_fase);
  if (position >= 4) return { id: STATUS.fase4, reason: `Fase ${position} → Fase 4` };
  if (position === 3) return { id: STATUS.fase3, reason: "Fase 3" };
  if (position === 2) return { id: STATUS.fase2, reason: "Fase 2" };
  if (position === 1) return { id: STATUS.fase1, reason: "Fase 1" };
  return { id: STATUS.iniciar, reason: "Iniciar consulta" };
}

function formatDate(value) {
  if (!value) return "Não informada";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text(value);
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "medium"
  }).format(date);
}

function noteContent(record, target) {
  const titles = Array.isArray(record.titulos_notificacoes)
    ? record.titulos_notificacoes.filter(Boolean).join(" | ")
    : text(record.titulos_notificacoes);
  const lines = [
    "[INTEGRAÇÃO VNE — STATUS NACIONALIDADE]",
    "",
    `Cliente: ${record.cliente}`,
    `Situação no Kommo: ${target.reason}`
  ];
  if (record.fase_consulta_automatica) {
    lines.push(`Fase atual: ${record.fase_consulta_automatica}`);
    lines.push(`Posição: ${record.posicao_fase ?? "-"} de ${record.total_fases ?? "-"}`);
    lines.push(`Data da fase: ${record.data_fase ? formatDate(record.data_fase) : "Não informada"}`);
    lines.push(`Possui notificação: ${record.possui_notificacao ? "Sim" : "Não"}`);
    if (titles) lines.push(`Notificações: ${titles}`);
    lines.push(`Última consulta: ${formatDate(record.data_ultima_consulta)}`);
  } else {
    lines.push("Situação da consulta: aguardando primeira consulta automática");
  }
  lines.push(`Atualização de origem: ${formatDate(record.data_ultima_consulta)}`);
  return lines.join("\n");
}

async function kommoRequest(route, options = {}) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(`${BASE_URL}${route}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
    });
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;
    if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      continue;
    }
    const error = new Error(`Kommo HTTP ${response.status}: ${body?.title ?? body?.detail ?? "falha"}`);
    error.status = response.status;
    throw error;
  }
}

async function findLeadByName(record) {
  const response = await kommoRequest(
    `/api/v4/leads?query=${encodeURIComponent(record.cliente)}&limit=50`
  );
  const leads = response?._embedded?.leads ?? [];
  return leads.filter((lead) =>
    Number(lead.pipeline_id) === PIPELINE_ID
    && normalize(lead.name) === normalize(record.cliente)
  );
}

async function validateStoredLead(leadId) {
  if (!leadId) return null;
  try {
    const lead = await kommoRequest(`/api/v4/leads/${leadId}`);
    return Number(lead?.pipeline_id) === PIPELINE_ID ? lead : null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function createLead(record, target) {
  const response = await kommoRequest("/api/v4/leads", {
    method: "POST",
    body: JSON.stringify([{
      name: record.cliente,
      pipeline_id: PIPELINE_ID,
      status_id: target.id,
      request_id: record.id_planilha
    }])
  });
  const lead = response?._embedded?.leads?.[0];
  if (!lead?.id) throw new Error("Kommo não retornou o ID do lead criado.");
  return lead;
}

async function moveLead(leadId, target) {
  return kommoRequest(`/api/v4/leads/${leadId}`, {
    method: "PATCH",
    body: JSON.stringify({ pipeline_id: PIPELINE_ID, status_id: target.id })
  });
}

async function upsertNote(record, leadId, currentNoteId, content) {
  if (currentNoteId) {
    try {
      await kommoRequest(`/api/v4/leads/notes/${currentNoteId}`, {
        method: "PATCH",
        body: JSON.stringify({ note_type: "common", params: { text: content } })
      });
      return currentNoteId;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const response = await kommoRequest("/api/v4/leads/notes", {
    method: "POST",
    body: JSON.stringify([{
      entity_id: Number(leadId),
      note_type: "common",
      params: { text: content }
    }])
  });
  const note = response?._embedded?.notes?.[0];
  if (!note?.id) throw new Error("Kommo não retornou o ID da nota criada.");
  return note.id;
}

async function loadCandidates(pool) {
  const result = await pool.query(`
    SELECT n.id AS nacionalidade_id, n.id_planilha::text, n.cliente, n.esta_no_kommo,
           n.status AS status_manual, n.anotacoes, n.fase_consulta_automatica,
           n.posicao_fase, n.total_fases, n.data_fase, n.possui_notificacao,
           n.titulos_notificacoes, n.data_ultima_consulta, n.processo_finalizado,
           n.kommo_pendente_desde, n.motivo_pendencia_kommo, n.kommo_versao,
           s.crm_lead_id, s.crm_nota_status_id, s.conteudo_nota_hash,
           s.status_id_sincronizado, s.sincronizado_em,
           s.sincronizacao_final_concluida
      FROM public.nacionalidade_portuguesa n
      LEFT JOIN public.sincronizacao_crm_nacionalidade s ON s.nacionalidade_id=n.id
     WHERE n.ativo_na_planilha
       AND NOT n.registro_duplicado
       AND n.kommo_pendente
       AND ($2::bigint IS NULL OR n.id=$2)
       AND (NOT n.processo_finalizado OR NOT coalesce(s.sincronizacao_final_concluida, false))
     ORDER BY n.processo_finalizado DESC, n.kommo_pendente_desde NULLS FIRST, n.id
     LIMIT $1
  `, [LIMIT, TEST_NACIONALIDADE_ID]);
  return result.rows;
}

async function saveSuccess(pool, record, data) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
    INSERT INTO public.sincronizacao_crm_nacionalidade (
      nacionalidade_id, crm_lead_id, crm_nota_status_id, conteudo_nota_hash,
      fase_sincronizada, posicao_fase_sincronizada, status_id_sincronizado,
      motivo_movimentacao, sincronizado_em, ultima_tentativa_em,
      status_ultima_tentativa, erro_ultima_tentativa, lead_criado_pelo_sistema,
      criado_no_kommo_em, nota_atualizada_em, sincronizacao_final_concluida,
      atualizado_em
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now(),'sucesso',NULL,$9,
              CASE WHEN $9 THEN now() END,now(),$10,now())
    ON CONFLICT (nacionalidade_id) DO UPDATE SET
      crm_lead_id=EXCLUDED.crm_lead_id,
      crm_nota_status_id=EXCLUDED.crm_nota_status_id,
      conteudo_nota_hash=EXCLUDED.conteudo_nota_hash,
      fase_sincronizada=EXCLUDED.fase_sincronizada,
      posicao_fase_sincronizada=EXCLUDED.posicao_fase_sincronizada,
      status_id_sincronizado=EXCLUDED.status_id_sincronizado,
      motivo_movimentacao=EXCLUDED.motivo_movimentacao,
      sincronizado_em=now(), ultima_tentativa_em=now(),
      status_ultima_tentativa='sucesso', erro_ultima_tentativa=NULL,
      lead_criado_pelo_sistema=sincronizacao_crm_nacionalidade.lead_criado_pelo_sistema OR EXCLUDED.lead_criado_pelo_sistema,
      criado_no_kommo_em=coalesce(sincronizacao_crm_nacionalidade.criado_no_kommo_em, EXCLUDED.criado_no_kommo_em),
      nota_atualizada_em=now(),
      sincronizacao_final_concluida=EXCLUDED.sincronizacao_final_concluida,
      atualizado_em=now()
    `, [
    record.nacionalidade_id, data.leadId, data.noteId, data.noteHash,
    record.fase_consulta_automatica, record.posicao_fase, data.target.id,
    data.target.reason, data.created, Boolean(record.processo_finalizado)
    ]);
    await client.query(`
      UPDATE public.nacionalidade_portuguesa
         SET esta_no_kommo='SIM',
             kommo_pendente=false,
             kommo_pendente_desde=NULL,
             motivo_pendencia_kommo=NULL
       WHERE id=$1
         AND kommo_versao=$2
    `, [record.nacionalidade_id, record.kommo_versao]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function saveError(pool, record, error) {
  await pool.query(`
    INSERT INTO public.sincronizacao_crm_nacionalidade (
      nacionalidade_id, crm_lead_id, ultima_tentativa_em,
      status_ultima_tentativa, erro_ultima_tentativa, atualizado_em
    ) VALUES ($1,$2,now(),'erro',$3,now())
    ON CONFLICT (nacionalidade_id) DO UPDATE SET
      crm_lead_id=coalesce(EXCLUDED.crm_lead_id, sincronizacao_crm_nacionalidade.crm_lead_id),
      ultima_tentativa_em=now(), status_ultima_tentativa='erro',
      erro_ultima_tentativa=EXCLUDED.erro_ultima_tentativa, atualizado_em=now()
  `, [record.nacionalidade_id, record.crm_lead_id, String(error.message).slice(0, 2000)]);
}

async function markKommoInSheet(records) {
  if (!records.length) return;
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : JSON.parse(await fs.readFile(path.resolve(CREDENTIALS_FILE), "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'`
  });
  const rows = response.data.values ?? [];
  const headers = rows[0] ?? [];
  const idIndex = headers.indexOf("ID REGISTRO SISTEMA");
  const kommoIndex = headers.indexOf("ESTÁ NO KOMMO?");
  if (idIndex < 0 || kommoIndex < 0) throw new Error("Colunas de UUID/Kommo não encontradas.");
  const rowById = new Map(rows.slice(1).map((row, index) => [text(row[idIndex]), index + 2]));
  const letter = String.fromCharCode(65 + kommoIndex);
  const data = records.map((record) => rowById.get(record.id_planilha))
    .filter(Boolean).map((row) => ({ range: `'${SHEET_NAME}'!${letter}${row}`, values: [["SIM"]] }));
  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: "RAW", data }
    });
  }
}

if (!TOKEN) throw new Error("KOMMO_ACCESS_TOKEN não definido.");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL não definida.");
if (!Number.isInteger(LIMIT) || LIMIT < 1 || LIMIT > 250) {
  throw new Error("KOMMO_LIMITE_POR_EXECUCAO deve estar entre 1 e 250.");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const lockClient = await pool.connect();
const lock = await lockClient.query(
  "SELECT pg_try_advisory_lock(hashtext('vne_sincronizacao_kommo')) AS acquired"
);
if (!lock.rows[0]?.acquired) {
  lockClient.release();
  await pool.end();
  throw new Error("Já existe uma sincronização Kommo em andamento.");
}
const summary = {
  selecionados: 0,
  encontrados: 0,
  criados: 0,
  movidos: 0,
  ja_na_etapa_correta: 0,
  ambiguos: 0,
  erros: 0
};
const sheetUpdates = [];
try {
  const candidates = await loadCandidates(pool);
  summary.selecionados = candidates.length;
  for (const record of candidates) {
    const target = targetStatus(record);
    try {
      let lead = await validateStoredLead(record.crm_lead_id);
      let created = false;
      if (!lead) {
        const matches = await findLeadByName(record);
        if (matches.length > 1) {
          summary.ambiguos++;
          throw new Error(`Nome ambíguo no funil: ${matches.length} leads encontrados.`);
        }
        lead = matches[0] ?? null;
        if (!lead) {
          if (APPLY) lead = await createLead(record, target);
          created = true;
        } else {
          summary.encontrados++;
        }
      } else {
        summary.encontrados++;
      }
      const needsMove = Boolean(lead)
        && !created
        && (
          Number(lead.status_id) !== target.id
          || Number(lead.pipeline_id) !== PIPELINE_ID
        );
      if (!APPLY) {
        if (created) summary.criados++;
        if (needsMove) summary.movidos++;
        else if (!created) summary.ja_na_etapa_correta++;
        const action = created
          ? "seria_criado"
          : needsMove
            ? "seria_movido"
            : "ja_na_etapa_correta";
        console.log(`[diagnostico] ${record.nacionalidade_id}: ${action} → ${target.reason}`);
        continue;
      }
      if (created) summary.criados++;
      if (needsMove) {
        await moveLead(lead.id, target);
        summary.movidos++;
      } else if (!created) {
        summary.ja_na_etapa_correta++;
      }
      const content = noteContent(record, target);
      const noteHash = createHash("sha256").update(content).digest("hex");
      let noteId = record.crm_nota_status_id;
      if (!noteId || noteHash !== record.conteudo_nota_hash) {
        noteId = await upsertNote(record, lead.id, noteId, content);
      }
      await saveSuccess(pool, record, {
        leadId: lead.id, noteId, noteHash, target, created
      });
      if (normalize(record.esta_no_kommo) !== "sim") sheetUpdates.push(record);
    } catch (error) {
      summary.erros++;
      console.error(`[kommo] ${record.nacionalidade_id}: ${error.message}`);
      if (APPLY) await saveError(pool, record, error);
    }
  }
  if (APPLY) await markKommoInSheet(sheetUpdates);
  console.log(JSON.stringify({ modo: APPLY ? "aplicar" : "diagnostico", ...summary }, null, 2));
} finally {
  await lockClient.query(
    "SELECT pg_advisory_unlock(hashtext('vne_sincronizacao_kommo'))"
  ).catch(() => {});
  lockClient.release();
  await pool.end().catch(() => {});
}
