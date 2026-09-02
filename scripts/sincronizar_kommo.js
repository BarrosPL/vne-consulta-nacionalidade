import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { google } from "googleapis";
import {
  isSalesbotBusinessHours,
  nextSalesbotBusinessTime
} from "./lib/janela_salesbot.js";
import {
  avisoIntegracaoKommoDesativada,
  integracaoKommoHabilitada,
  notaKommoHabilitada
} from "./lib/integracao_kommo.js";

// A trava vem antes de qualquer leitura de configuracao para que o modulo nao
// exija token nem IDs de etapa enquanto a integracao estiver desativada.
if (!integracaoKommoHabilitada()) {
  console.warn(avisoIntegracaoKommoDesativada("sincronizacao com o Kommo"));
  process.exit(0);
}
if (!notaKommoHabilitada()) {
  console.log(
    "[kommo] Nota de status desligada: os dados vao para os campos "
    + "personalizados do lead. Use KOMMO_NOTA_HABILITADA=true para reativa-la."
  );
}

const APPLY = process.argv.includes("--aplicar");
const NOTE_ENABLED = notaKommoHabilitada();
const LIMIT = Number(process.env.KOMMO_LIMITE_POR_EXECUCAO ?? 30);
const TEST_NACIONALIDADE_ID = process.env.KOMMO_TESTE_NACIONALIDADE_ID
  ? Number(process.env.KOMMO_TESTE_NACIONALIDADE_ID)
  : null;
const BASE_URL = String(process.env.KOMMO_BASE_URL ?? "https://vocenaeuropa.kommo.com").replace(/\/$/, "");
const TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const PIPELINE_ID = Number(process.env.KOMMO_PIPELINE_ID ?? 8322487);
const REQUESTS_PER_SECOND = Number(process.env.KOMMO_REQUISICOES_POR_SEGUNDO ?? 4);
const SALESBOT_REMINDER_DAYS = Number(process.env.KOMMO_SALESBOT_LEMBRETE_DIAS ?? 30);
const SALESBOT_LIMIT = Number(process.env.KOMMO_SALESBOT_LIMITE_POR_EXECUCAO ?? 100);
const SALESBOT_TIMEZONE = process.env.KOMMO_SALESBOT_FUSO ?? "America/Sao_Paulo";
// Cadencia de comunicacao. Diferente de KOMMO_REQUISICOES_POR_SEGUNDO, que e o
// limite tecnico da API: estes dois controlam o ritmo com que o cliente final
// recebe mensagem.
const SALESBOT_INTERVAL_MS = Number(process.env.KOMMO_SALESBOT_INTERVALO_MS ?? 0);
const SALESBOT_DAILY_LIMIT = Number(process.env.KOMMO_SALESBOT_LIMITE_DIARIO ?? 0);
if (!Number.isInteger(SALESBOT_INTERVAL_MS) || SALESBOT_INTERVAL_MS < 0 || SALESBOT_INTERVAL_MS > 3600000) {
  throw new Error("KOMMO_SALESBOT_INTERVALO_MS deve ser um inteiro entre 0 e 3600000.");
}
if (!Number.isInteger(SALESBOT_DAILY_LIMIT) || SALESBOT_DAILY_LIMIT < 0 || SALESBOT_DAILY_LIMIT > 100000) {
  throw new Error("KOMMO_SALESBOT_LIMITE_DIARIO deve ser um inteiro entre 0 e 100000.");
}
console.log(
  `[salesbot] Cadencia: ${SALESBOT_INTERVAL_MS > 0 ? `${SALESBOT_INTERVAL_MS / 1000}s entre mensagens` : "sem espacamento"}`
  + `, ${SALESBOT_LIMIT} por execucao`
  + `, ${SALESBOT_DAILY_LIMIT > 0 ? `${SALESBOT_DAILY_LIMIT} por dia` : "sem limite diario"}.`
);
process.env.TZ = SALESBOT_TIMEZONE;
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

function optionalPositiveInteger(value, variableName) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${variableName} deve ser um ID inteiro positivo ou ficar vazio.`);
  }
  return number;
}

const SALESBOTS = new Map([
  [STATUS.fase1, {
    mudanca: Number(process.env.KOMMO_SALESBOT_FASE_1 ?? 62867),
    lembrete: Number(process.env.KOMMO_SALESBOT_LEMBRETE_FASE_1 ?? 62869)
  }],
  [STATUS.fase2, {
    mudanca: Number(process.env.KOMMO_SALESBOT_FASE_2 ?? 62929),
    lembrete: Number(process.env.KOMMO_SALESBOT_LEMBRETE_FASE_2 ?? 62931)
  }],
  [STATUS.fase3, {
    mudanca: Number(process.env.KOMMO_SALESBOT_FASE_3 ?? 62871),
    lembrete: Number(process.env.KOMMO_SALESBOT_LEMBRETE_FASE_3 ?? 62873)
  }],
  [STATUS.fase4, {
    mudanca: Number(process.env.KOMMO_SALESBOT_FASE_4 ?? 62875),
    lembrete: null
  }],
  [STATUS.exigencia, {
    mudanca: optionalPositiveInteger(
      process.env.KOMMO_SALESBOT_EXIGENCIA,
      "KOMMO_SALESBOT_EXIGENCIA"
    ),
    lembrete: optionalPositiveInteger(
      process.env.KOMMO_SALESBOT_LEMBRETE_EXIGENCIA,
      "KOMMO_SALESBOT_LEMBRETE_EXIGENCIA"
    )
  }]
]);

let nextKommoRequestAt = 0;
// Cadencia: momento do proximo disparo permitido e contagem do dia corrente.
let nextSalesbotDispatchAt = 0;
let salesbotSentToday = null;
let salesbotDailyLimitLogged = false;

// Meia-noite local. process.env.TZ ja foi ajustado para KOMMO_SALESBOT_FUSO.
function startOfLocalDay() {
  const inicio = new Date();
  inicio.setHours(0, 0, 0, 0);
  return inicio;
}

async function salesbotDispatchedToday(pool) {
  if (salesbotSentToday !== null) return salesbotSentToday;
  const resultado = await pool.query(`
    SELECT count(*)::int AS total
      FROM public.disparos_salesbot_nacionalidade
     WHERE status_disparo = 'sucesso'
       AND disparado_em >= $1
  `, [startOfLocalDay()]);
  salesbotSentToday = resultado.rows[0]?.total ?? 0;
  return salesbotSentToday;
}

async function waitForSalesbotCadence() {
  if (SALESBOT_INTERVAL_MS <= 0) return;
  const espera = Math.max(0, nextSalesbotDispatchAt - Date.now());
  if (espera > 0) await new Promise((resolve) => setTimeout(resolve, espera));
  nextSalesbotDispatchAt = Math.max(Date.now(), nextSalesbotDispatchAt) + SALESBOT_INTERVAL_MS;
}

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

const PHASE_RANK = new Map([
  [STATUS.iniciar, 0],
  [STATUS.fase1, 1],
  [STATUS.fase2, 2],
  [STATUS.fase3, 3],
  [STATUS.fase4, 4]
]);
const CLOSED_STATUS_IDS = new Set([142, 143]);
const SPECIAL_REVIEW_STATUS_IDS = new Set([STATUS.exigencia, STATUS.risco]);

function manualPhaseTarget(value) {
  const normalized = normalize(value);
  if (/\bfase\s*3\b/.test(normalized)) {
    return { id: STATUS.fase3, reason: "Fase 3 (status manual)", source: "manual" };
  }
  if (/\bfase\s*2\b/.test(normalized)) {
    return { id: STATUS.fase2, reason: "Fase 2 (status manual)", source: "manual" };
  }
  if (/\bfase\s*1\b/.test(normalized)) {
    return { id: STATUS.fase1, reason: "Fase 1 (status manual)", source: "manual" };
  }
  if (normalized.includes("iniciar consulta")) {
    return { id: STATUS.iniciar, reason: "Iniciar consulta (status manual)", source: "manual" };
  }
  return null;
}

function targetCandidate(record) {
  if (record.processo_finalizado) {
    return { id: STATUS.fase4, reason: "Processo finalizado → Fase 4", source: "finalizado" };
  }
  const combined = [
    record.status_manual, record.anotacoes,
    Array.isArray(record.titulos_notificacoes)
      ? record.titulos_notificacoes.join(" ")
      : record.titulos_notificacoes
  ].join(" ");
  if (positiveMention(combined, ["risco de indeferimento", "indeferimento", "indeferido"])) {
    return { id: STATUS.risco, reason: "Risco de indeferimento", source: "especial" };
  }
  if (positiveMention(combined, ["exigencia"])) {
    return { id: STATUS.exigencia, reason: "Cumprimento de Exigência", source: "especial" };
  }
  const position = Number(record.posicao_fase);
  if (position >= 4) {
    return { id: STATUS.fase4, reason: `Fase ${position} → Fase 4`, source: "automatica" };
  }
  if (position === 3) {
    return { id: STATUS.fase3, reason: "Fase 3 (consulta automática)", source: "automatica" };
  }
  if (position === 2) {
    return { id: STATUS.fase2, reason: "Fase 2 (consulta automática)", source: "automatica" };
  }
  if (position === 1) {
    return { id: STATUS.fase1, reason: "Fase 1 (consulta automática)", source: "automatica" };
  }
  return manualPhaseTarget(record.status_manual);
}

function preservedTarget(lead, reason) {
  return {
    id: Number(lead.status_id),
    reason,
    source: "kommo_preservado",
    preserved: true
  };
}

function resolveTarget(record, lead) {
  const candidate = targetCandidate(record);
  if (!lead) {
    return candidate ?? {
      id: STATUS.iniciar,
      reason: "Novo lead sem fase confiável → Iniciar consulta",
      source: "novo_lead"
    };
  }

  const currentStatusId = Number(lead.status_id);
  if (CLOSED_STATUS_IDS.has(currentStatusId)) {
    return preservedTarget(lead, "Etapa encerrada preservada");
  }
  if (!candidate) {
    return preservedTarget(lead, "Etapa atual preservada: sem fase confiável no banco");
  }
  if (SPECIAL_REVIEW_STATUS_IDS.has(currentStatusId)
      && candidate.source !== "especial"
      && candidate.source !== "finalizado") {
    return preservedTarget(lead, "Etapa especial preservada para revisão da equipe");
  }

  const currentRank = PHASE_RANK.get(currentStatusId);
  const targetRank = PHASE_RANK.get(candidate.id);
  if (currentRank !== undefined
      && targetRank !== undefined
      && targetRank < currentRank) {
    return preservedTarget(lead, "Etapa atual preservada: regressão automática bloqueada");
  }
  return candidate;
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
  } else if (record.status_manual) {
    lines.push(`Status informado no banco: ${record.status_manual}`);
    lines.push("Situação da consulta automática: fase ainda não disponível");
  } else {
    lines.push("Situação da consulta: aguardando primeira consulta automática");
  }
  lines.push(`Atualização de origem: ${formatDate(record.data_ultima_consulta)}`);
  return lines.join("\n");
}

async function waitForKommoRateLimit() {
  const interval = Math.ceil(1000 / REQUESTS_PER_SECOND);
  const now = Date.now();
  const waitMs = Math.max(0, nextKommoRequestAt - now);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  nextKommoRequestAt = Math.max(Date.now(), nextKommoRequestAt) + interval;
}

function retryAfterMs(response, attempt) {
  const value = response.headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return attempt * 2000;
}

async function kommoRequest(route, options = {}) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitForKommoRateLimit();
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
      const waitMs = retryAfterMs(response, attempt);
      console.warn(
        `[kommo] HTTP ${response.status}; nova tentativa em ${Math.ceil(waitMs / 1000)}s.`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    const validation = body?.["validation-errors"]
      ?? body?.validation_errors
      ?? body?.errors;
    const validationText = validation
      ? ` | validação: ${JSON.stringify(validation).slice(0, 1500)}`
      : "";
    const error = new Error(
      `Kommo HTTP ${response.status}: ${body?.detail ?? body?.title ?? "falha"}${validationText}`
    );
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

async function launchSalesbot(botId, leadId) {
  await waitForKommoRateLimit();
  const response = await fetch(`${BASE_URL}/api/v4/bots/${botId}/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/problem+json, text/html",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      entity_id: Number(leadId),
      entity_type: "leads"
    })
  });
  const rawBody = await response.text();
  let body = rawBody;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    // A resposta de sucesso deste endpoint pode ser text/html.
  }
  if (!response.ok) {
    const detail = typeof body === "object"
      ? body?.detail ?? body?.title ?? JSON.stringify(body)
      : body;
    const error = new Error(
      `Kommo Salesbot HTTP ${response.status}: ${detail || "falha sem detalhes"}`
    );
    error.status = response.status;
    throw error;
  }
  return response.status;
}

function salesbotFor(statusId, type) {
  const config = SALESBOTS.get(Number(statusId));
  return type === "mudanca_fase" ? config?.mudanca : config?.lembrete;
}

function stageKeyDate(value) {
  return new Date(value).toISOString();
}

async function scheduleSalesbotDispatch(pool, dispatch) {
  const runAfter = nextSalesbotBusinessTime();
  const result = await pool.query(`
    INSERT INTO public.disparos_salesbot_nacionalidade (
      nacionalidade_id, crm_lead_id, status_id, salesbot_id, tipo,
      chave_idempotencia, ciclo_lembrete, etapa_entrou_em, status_disparo,
      disparar_apos
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'agendado',$9)
    ON CONFLICT (chave_idempotencia) DO UPDATE SET
      crm_lead_id=EXCLUDED.crm_lead_id,
      salesbot_id=EXCLUDED.salesbot_id,
      status_disparo='agendado',
      disparar_apos=EXCLUDED.disparar_apos,
      erro=NULL,
      ultima_tentativa_em=now()
    WHERE disparos_salesbot_nacionalidade.status_disparo IN ('erro', 'agendado')
    RETURNING id, disparar_apos
  `, [
    dispatch.nacionalidadeId, dispatch.leadId, dispatch.statusId,
    dispatch.botId, dispatch.type, dispatch.key, dispatch.cycle ?? null,
    dispatch.stageEnteredAt, runAfter
  ]);
  const scheduled = result.rows[0];
  return {
    sent: false,
    duplicate: !scheduled,
    scheduled: Boolean(scheduled),
    runAfter: scheduled?.disparar_apos ?? runAfter
  };
}

async function reserveSalesbotDispatch(pool, dispatch) {
  const result = await pool.query(`
    INSERT INTO public.disparos_salesbot_nacionalidade (
      nacionalidade_id, crm_lead_id, status_id, salesbot_id, tipo,
      chave_idempotencia, ciclo_lembrete, etapa_entrou_em, status_disparo
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'processando')
    ON CONFLICT (chave_idempotencia) DO UPDATE SET
      crm_lead_id=EXCLUDED.crm_lead_id,
      tentativas=disparos_salesbot_nacionalidade.tentativas + 1,
      status_disparo='processando',
      disparar_apos=NULL,
      erro=NULL,
      ultima_tentativa_em=now()
    WHERE disparos_salesbot_nacionalidade.status_disparo IN ('erro', 'agendado')
    RETURNING id
  `, [
    dispatch.nacionalidadeId, dispatch.leadId, dispatch.statusId,
    dispatch.botId, dispatch.type, dispatch.key, dispatch.cycle ?? null,
    dispatch.stageEnteredAt
  ]);
  return result.rows[0]?.id ?? null;
}

async function executeSalesbotDispatch(pool, dispatch) {
  if (!isSalesbotBusinessHours()) {
    return scheduleSalesbotDispatch(pool, dispatch);
  }
  // Cota diaria esgotada: a mensagem nao se perde, e adiada para as 09:00 do
  // proximo dia util, pelo mesmo caminho de quem cai fora da janela.
  if (SALESBOT_DAILY_LIMIT > 0) {
    const enviadosHoje = await salesbotDispatchedToday(pool);
    if (enviadosHoje >= SALESBOT_DAILY_LIMIT) {
      if (!salesbotDailyLimitLogged) {
        console.warn(
          `[salesbot] Cota diaria de ${SALESBOT_DAILY_LIMIT} mensagem(ns) atingida `
          + `(${enviadosHoje} enviadas hoje). Os disparos restantes ficam agendados `
          + "para as 09:00 do proximo dia util."
        );
        salesbotDailyLimitLogged = true;
      }
      return scheduleSalesbotDispatch(pool, dispatch);
    }
  }
  // Espaca as mensagens antes de reservar, para nao manter um disparo em
  // 'processando' enquanto aguarda.
  await waitForSalesbotCadence();
  const dispatchId = await reserveSalesbotDispatch(pool, dispatch);
  if (!dispatchId) return { sent: false, duplicate: true };
  try {
    const httpStatus = await launchSalesbot(dispatch.botId, dispatch.leadId);
    await pool.query(`
      UPDATE public.disparos_salesbot_nacionalidade
         SET status_disparo='sucesso', http_status=$2, erro=NULL,
             disparado_em=now(), disparar_apos=NULL, ultima_tentativa_em=now()
       WHERE id=$1
    `, [dispatchId, httpStatus]);
    await pool.query(`
      UPDATE public.sincronizacao_crm_nacionalidade
         SET salesbot_ultimo_disparo_em=now(), atualizado_em=now()
       WHERE nacionalidade_id=$1
    `, [dispatch.nacionalidadeId]);
    if (salesbotSentToday !== null) salesbotSentToday++;
    return { sent: true, duplicate: false, httpStatus };
  } catch (error) {
    await pool.query(`
      UPDATE public.disparos_salesbot_nacionalidade
         SET status_disparo='erro', http_status=$2, erro=$3,
             ultima_tentativa_em=now()
       WHERE id=$1
    `, [dispatchId, error.status ?? null, String(error.message).slice(0, 2000)]);
    throw error;
  }
}

async function dispatchStageChangeSalesbot(pool, record, leadId, target, stageEnteredAt) {
  const botId = salesbotFor(target.id, "mudanca_fase");
  if (!botId) return { sent: false, ignored: true };
  const key = [
    "mudanca", record.nacionalidade_id, target.id, stageKeyDate(stageEnteredAt)
  ].join(":");
  return executeSalesbotDispatch(pool, {
    nacionalidadeId: record.nacionalidade_id,
    leadId,
    statusId: target.id,
    botId,
    type: "mudanca_fase",
    key,
    stageEnteredAt
  });
}

async function loadDueReminders(pool) {
  const result = await pool.query(`
    WITH vencidos AS (
      SELECT s.nacionalidade_id, s.crm_lead_id,
             s.status_id_sincronizado AS status_id, s.etapa_entrou_em,
             floor(extract(epoch FROM (now() - s.etapa_entrou_em))
               / ($1::numeric * 86400))::integer AS ciclo
        FROM public.sincronizacao_crm_nacionalidade s
        JOIN public.nacionalidade_portuguesa n ON n.id=s.nacionalidade_id
       WHERE n.ativo_na_planilha
         AND NOT n.registro_duplicado
         AND NOT n.processo_finalizado
         AND s.crm_lead_id IS NOT NULL
         AND s.etapa_entrou_em IS NOT NULL
         AND s.etapa_entrou_em <= now() - ($1::text || ' days')::interval
         AND s.status_id_sincronizado = ANY($2::bigint[])
    )
    SELECT v.*
      FROM vencidos v
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.disparos_salesbot_nacionalidade d
        WHERE d.nacionalidade_id=v.nacionalidade_id
          AND d.status_id=v.status_id
          AND d.etapa_entrou_em=v.etapa_entrou_em
          AND d.tipo='lembrete_30_dias'
          AND d.ciclo_lembrete=v.ciclo
          AND d.status_disparo IN ('agendado', 'processando', 'sucesso')
     )
     ORDER BY v.etapa_entrou_em, v.nacionalidade_id
     LIMIT $3
  `, [
    SALESBOT_REMINDER_DAYS,
    [...SALESBOTS.entries()]
      .filter(([, config]) => config.lembrete)
      .map(([statusId]) => statusId),
    SALESBOT_LIMIT
  ]);
  return result.rows;
}

async function processDueReminders(pool, summary, auditDetails) {
  const reminders = await loadDueReminders(pool);
  summary.lembretes_vencidos = reminders.length;
  for (const reminder of reminders) {
    const botId = salesbotFor(reminder.status_id, "lembrete_30_dias");
    const key = [
      "lembrete", reminder.nacionalidade_id, reminder.status_id,
      stageKeyDate(reminder.etapa_entrou_em), reminder.ciclo
    ].join(":");
    if (!APPLY) {
      summary.lembretes_diagnostico++;
      auditDetails.push({
        tipo: "lembrete_30_dias",
        nacionalidade_id: reminder.nacionalidade_id,
        lead_id: reminder.crm_lead_id,
        salesbot_id: botId,
        ciclo: reminder.ciclo,
        resultado: "diagnostico"
      });
      continue;
    }
    try {
      const result = await executeSalesbotDispatch(pool, {
        nacionalidadeId: reminder.nacionalidade_id,
        leadId: reminder.crm_lead_id,
        statusId: reminder.status_id,
        botId,
        type: "lembrete_30_dias",
        key,
        cycle: reminder.ciclo,
        stageEnteredAt: reminder.etapa_entrou_em
      });
      if (result.sent) summary.lembretes_disparados++;
      if (result.scheduled) summary.lembretes_agendados++;
      if (result.duplicate) summary.lembretes_ja_processados++;
    } catch (error) {
      summary.erros_salesbot++;
      console.error(
        `[salesbot] lembrete do registro ${reminder.nacionalidade_id}: ${error.message}`
      );
    }
  }
}

async function processScheduledSalesbots(pool, summary, auditDetails) {
  if (!APPLY || !isSalesbotBusinessHours()) return;
  await pool.query(`
    UPDATE public.disparos_salesbot_nacionalidade d
       SET status_disparo='cancelado',
           erro='Etapa alterada ou registro inelegível antes do horário de envio',
           ultima_tentativa_em=now()
      FROM public.sincronizacao_crm_nacionalidade s,
           public.nacionalidade_portuguesa n
     WHERE d.status_disparo='agendado'
       AND s.nacionalidade_id=d.nacionalidade_id
       AND n.id=d.nacionalidade_id
       AND (
         NOT n.ativo_na_planilha
         OR n.registro_duplicado
         OR s.status_id_sincronizado IS DISTINCT FROM d.status_id
         OR s.etapa_entrou_em IS DISTINCT FROM d.etapa_entrou_em
       )
  `);
  const result = await pool.query(`
    SELECT d.nacionalidade_id, d.crm_lead_id, d.status_id, d.salesbot_id,
           d.tipo, d.chave_idempotencia, d.ciclo_lembrete, d.etapa_entrou_em
      FROM public.disparos_salesbot_nacionalidade d
      JOIN public.sincronizacao_crm_nacionalidade s
        ON s.nacionalidade_id=d.nacionalidade_id
      JOIN public.nacionalidade_portuguesa n
        ON n.id=d.nacionalidade_id
     WHERE d.status_disparo='agendado'
       AND d.disparar_apos <= now()
       AND n.ativo_na_planilha
       AND NOT n.registro_duplicado
       AND s.status_id_sincronizado=d.status_id
       AND s.etapa_entrou_em=d.etapa_entrou_em
     ORDER BY d.disparar_apos, d.id
     LIMIT $1
  `, [SALESBOT_LIMIT]);
  summary.salesbots_agendados_vencidos = result.rows.length;
  for (const scheduled of result.rows) {
    try {
      const dispatch = await executeSalesbotDispatch(pool, {
        nacionalidadeId: scheduled.nacionalidade_id,
        leadId: scheduled.crm_lead_id,
        statusId: scheduled.status_id,
        botId: scheduled.salesbot_id,
        type: scheduled.tipo,
        key: scheduled.chave_idempotencia,
        cycle: scheduled.ciclo_lembrete,
        stageEnteredAt: scheduled.etapa_entrou_em
      });
      if (dispatch.sent) summary.salesbots_agendados_disparados++;
      auditDetails.push({
        tipo: scheduled.tipo,
        nacionalidade_id: scheduled.nacionalidade_id,
        lead_id: scheduled.crm_lead_id,
        salesbot_id: scheduled.salesbot_id,
        resultado: dispatch.sent ? "agendado_disparado" : "agendado_nao_disparado"
      });
    } catch (error) {
      summary.erros_salesbot++;
      console.error(
        `[salesbot] agendado do registro ${scheduled.nacionalidade_id}: ${error.message}`
      );
    }
  }
}

async function processFailedStageChanges(pool, summary, auditDetails) {
  const result = await pool.query(`
    SELECT d.nacionalidade_id, d.crm_lead_id, d.status_id, d.salesbot_id,
           d.chave_idempotencia, d.etapa_entrou_em
      FROM public.disparos_salesbot_nacionalidade d
      JOIN public.sincronizacao_crm_nacionalidade s
        ON s.nacionalidade_id=d.nacionalidade_id
      JOIN public.nacionalidade_portuguesa n
        ON n.id=d.nacionalidade_id
     WHERE d.tipo='mudanca_fase'
       AND d.status_disparo='erro'
       AND d.ultima_tentativa_em <= now() - interval '15 minutes'
       AND n.ativo_na_planilha
       AND NOT n.registro_duplicado
       AND s.status_id_sincronizado=d.status_id
       AND s.etapa_entrou_em=d.etapa_entrou_em
     ORDER BY d.ultima_tentativa_em
     LIMIT $1
  `, [SALESBOT_LIMIT]);
  summary.mudancas_salesbot_para_repetir = result.rows.length;
  if (!APPLY) return;
  for (const failed of result.rows) {
    try {
      const retry = await executeSalesbotDispatch(pool, {
        nacionalidadeId: failed.nacionalidade_id,
        leadId: failed.crm_lead_id,
        statusId: failed.status_id,
        botId: failed.salesbot_id,
        type: "mudanca_fase",
        key: failed.chave_idempotencia,
        stageEnteredAt: failed.etapa_entrou_em
      });
      if (retry.sent) summary.mudancas_salesbot_repetidas++;
      auditDetails.push({
        tipo: "mudanca_fase",
        nacionalidade_id: failed.nacionalidade_id,
        lead_id: failed.crm_lead_id,
        salesbot_id: failed.salesbot_id,
        resultado: retry.sent ? "repetido_com_sucesso" : "ja_processado"
      });
    } catch (error) {
      summary.erros_salesbot++;
      console.error(
        `[salesbot] repetição da mudança ${failed.nacionalidade_id}: ${error.message}`
      );
    }
  }
}

async function upsertNote(record, leadId, currentNoteId, content) {
  if (currentNoteId) {
    try {
      await kommoRequest(`/api/v4/leads/notes/${currentNoteId}`, {
        method: "PATCH",
        body: JSON.stringify({
          entity_id: Number(leadId),
          note_type: "common",
          params: { text: content }
        })
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
           s.sincronizacao_final_concluida, s.etapa_entrou_em
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
      etapa_entrou_em, atualizado_em
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now(),'sucesso',NULL,$9,
              CASE WHEN $9 THEN now() END,now(),$10,$11,now())
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
      etapa_entrou_em=CASE
        WHEN sincronizacao_crm_nacionalidade.status_id_sincronizado
             IS DISTINCT FROM EXCLUDED.status_id_sincronizado
          THEN EXCLUDED.etapa_entrou_em
        ELSE coalesce(
          sincronizacao_crm_nacionalidade.etapa_entrou_em,
          EXCLUDED.etapa_entrou_em
        )
      END,
      atualizado_em=now()
    `, [
    record.nacionalidade_id, data.leadId, data.noteId, data.noteHash,
    record.fase_consulta_automatica, record.posicao_fase, data.target.id,
    data.target.reason, data.created, Boolean(record.processo_finalizado),
    data.stageEnteredAt
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
if (!Number.isFinite(REQUESTS_PER_SECOND)
    || REQUESTS_PER_SECOND < 1
    || REQUESTS_PER_SECOND > 7) {
  throw new Error("KOMMO_REQUISICOES_POR_SEGUNDO deve estar entre 1 e 7.");
}
if (!Number.isInteger(SALESBOT_REMINDER_DAYS) || SALESBOT_REMINDER_DAYS < 1) {
  throw new Error("KOMMO_SALESBOT_LEMBRETE_DIAS deve ser um inteiro positivo.");
}
if (!Number.isInteger(SALESBOT_LIMIT) || SALESBOT_LIMIT < 1 || SALESBOT_LIMIT > 250) {
  throw new Error("KOMMO_SALESBOT_LIMITE_POR_EXECUCAO deve estar entre 1 e 250.");
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
  movimentacoes_bloqueadas: 0,
  ja_na_etapa_correta: 0,
  ambiguos: 0,
  erros: 0,
  mudancas_salesbot_disparadas: 0,
  mudancas_salesbot_agendadas: 0,
  mudancas_salesbot_diagnostico: 0,
  mudancas_salesbot_ignoradas: 0,
  mudancas_salesbot_para_repetir: 0,
  mudancas_salesbot_repetidas: 0,
  lembretes_vencidos: 0,
  lembretes_diagnostico: 0,
  lembretes_disparados: 0,
  lembretes_agendados: 0,
  lembretes_ja_processados: 0,
  salesbots_agendados_vencidos: 0,
  salesbots_agendados_disparados: 0,
  erros_salesbot: 0
};
const kommoRunStartedAt = new Date();
const auditDetails = [];
const sheetUpdates = [];
try {
  const candidates = await loadCandidates(pool);
  summary.selecionados = candidates.length;
  for (const record of candidates) {
    const audit = {
      id: record.nacionalidade_id,
      cliente: record.cliente,
      motivo_pendencia: record.motivo_pendencia_kommo
    };
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
        if (lead) {
          summary.encontrados++;
        }
      } else {
        summary.encontrados++;
      }
      const target = resolveTarget(record, lead);
      audit.destino = target.reason;
      audit.status_id_destino = target.id;
      audit.fonte_destino = target.source;
      audit.movimentacao_bloqueada = Boolean(target.preserved);
      if (!lead) {
        if (APPLY) lead = await createLead(record, target);
        created = true;
      }
      const needsMove = Boolean(lead)
        && !created
        && (
          Number(lead.status_id) !== target.id
          || Number(lead.pipeline_id) !== PIPELINE_ID
        );
      audit.pipeline_id_atual = lead?.pipeline_id ?? null;
      audit.status_id_atual = lead?.status_id ?? null;
      audit.fase_manual = record.status_manual ?? null;
      audit.fase_automatica = record.fase_consulta_automatica ?? null;
      audit.posicao_fase = record.posicao_fase ?? null;
      const stageChanged = record.status_id_sincronizado !== null
        && Number(record.status_id_sincronizado) !== target.id;
      const stageEnteredAt = stageChanged || !record.etapa_entrou_em
        ? new Date()
        : new Date(record.etapa_entrou_em);
      if (!APPLY) {
        if (created) summary.criados++;
        if (needsMove) summary.movidos++;
        else if (target.preserved) summary.movimentacoes_bloqueadas++;
        else if (!created) summary.ja_na_etapa_correta++;
        const action = created
          ? "seria_criado"
          : needsMove
            ? "seria_movido"
            : target.preserved
              ? "etapa_preservada"
              : "ja_na_etapa_correta";
        console.log(`[diagnostico] ${record.nacionalidade_id}: ${action} → ${target.reason}`);
        audit.resultado = "diagnostico";
        audit.acao = action;
        if (stageChanged && !target.preserved) {
          const botId = salesbotFor(target.id, "mudanca_fase");
          audit.salesbot_id = botId ?? null;
          audit.salesbot_resultado = botId ? "seria_disparado" : "ignorado";
          if (botId) summary.mudancas_salesbot_diagnostico++;
          else summary.mudancas_salesbot_ignoradas++;
        }
        auditDetails.push(audit);
        continue;
      }
      if (created) summary.criados++;
      if (needsMove) {
        await moveLead(lead.id, target);
        summary.movidos++;
        audit.acao = "movido";
      } else if (target.preserved) {
        summary.movimentacoes_bloqueadas++;
        audit.acao = "etapa_preservada";
      } else if (!created) {
        summary.ja_na_etapa_correta++;
        audit.acao = "ja_na_etapa_correta";
      } else {
        audit.acao = "criado";
      }
      // Com a nota desligada, o ID e o hash ja gravados sao preservados como
      // estao: nada e escrito no Kommo e nada e sobrescrito no banco.
      let noteId = record.crm_nota_status_id;
      let noteHash = record.conteudo_nota_hash;
      let noteUpdated = false;
      if (NOTE_ENABLED) {
        const content = noteContent(record, target);
        const computedHash = createHash("sha256").update(content).digest("hex");
        noteUpdated = !noteId || computedHash !== record.conteudo_nota_hash;
        if (noteUpdated) {
          noteId = await upsertNote(record, lead.id, noteId, content);
          noteHash = computedHash;
        }
      }
      await saveSuccess(pool, record, {
        leadId: lead.id, noteId, noteHash, target, created, stageEnteredAt
      });
      if (stageChanged && !target.preserved) {
        try {
          const botResult = await dispatchStageChangeSalesbot(
            pool, record, lead.id, target, stageEnteredAt
          );
          if (botResult.sent) summary.mudancas_salesbot_disparadas++;
          if (botResult.scheduled) summary.mudancas_salesbot_agendadas++;
          if (botResult.ignored) summary.mudancas_salesbot_ignoradas++;
          audit.salesbot_id = salesbotFor(target.id, "mudanca_fase") ?? null;
          audit.salesbot_resultado = botResult.sent
            ? "disparado"
            : botResult.scheduled
              ? "agendado"
              : "ignorado";
          audit.salesbot_disparar_apos = botResult.runAfter ?? null;
        } catch (error) {
          summary.erros_salesbot++;
          audit.salesbot_resultado = "erro";
          audit.salesbot_erro = String(error.message).slice(0, 2000);
          console.error(`[salesbot] mudança do registro ${record.nacionalidade_id}: ${error.message}`);
        }
      }
      if (normalize(record.esta_no_kommo) !== "sim") sheetUpdates.push(record);
      audit.resultado = "sucesso";
      audit.lead_id = lead.id;
      audit.nota_id = noteId;
      audit.nota_atualizada = noteUpdated;
      auditDetails.push(audit);
    } catch (error) {
      summary.erros++;
      console.error(`[kommo] ${record.nacionalidade_id}: ${error.message}`);
      if (APPLY) {
        await saveError(pool, record, error).catch((saveErrorFailure) => {
          console.error(
            `[kommo] ${record.nacionalidade_id}: falha ao registrar erro: ${saveErrorFailure.message}`
          );
        });
      }
      audit.resultado = "erro";
      audit.erro = String(error.message).slice(0, 2000);
      auditDetails.push(audit);
    }
  }
  await processScheduledSalesbots(pool, summary, auditDetails);
  await processFailedStageChanges(pool, summary, auditDetails);
  await processDueReminders(pool, summary, auditDetails);
  if (APPLY) await markKommoInSheet(sheetUpdates);
  console.log(JSON.stringify({ modo: APPLY ? "aplicar" : "diagnostico", ...summary }, null, 2));
  console.log("\n========== RELATORIO_AUDITORIA_KOMMO ==========");
  console.log(JSON.stringify({
    tipo: "sincronizacao_kommo",
    modo: APPLY ? "aplicar" : "diagnostico",
    iniciado_em: kommoRunStartedAt.toISOString(),
    finalizado_em: new Date().toISOString(),
    limite_requisicoes_por_segundo: REQUESTS_PER_SECOND,
    resumo: summary,
    detalhes: auditDetails
  }, null, 2));
} finally {
  await lockClient.query(
    "SELECT pg_advisory_unlock(hashtext('vne_sincronizacao_kommo'))"
  ).catch(() => {});
  lockClient.release();
  await pool.end().catch(() => {});
}
