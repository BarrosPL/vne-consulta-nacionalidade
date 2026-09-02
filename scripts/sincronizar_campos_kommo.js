import "dotenv/config";
import { createHash } from "node:crypto";
import pg from "pg";
import {
  CAMPOS,
  avisoCamposKommoDesativado,
  camposKommoHabilitado,
  montarCamposPersonalizados,
  validarCorpoSomenteCampos
} from "./lib/campos_kommo.js";

// A trava vem antes de qualquer leitura de configuracao para que o modulo nao
// exija token enquanto a escrita de campos estiver desativada.
if (!camposKommoHabilitado()) {
  console.warn(avisoCamposKommoDesativado("preenchimento de campos personalizados"));
  process.exit(0);
}

const APPLY = process.argv.includes("--aplicar");
const BASE_URL = String(process.env.KOMMO_BASE_URL ?? "https://vocenaeuropa.kommo.com").replace(/\/$/, "");
const TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const LIMIT = Number(process.env.KOMMO_CAMPOS_LIMITE_POR_EXECUCAO ?? 100);
const REQUESTS_PER_SECOND = Number(process.env.KOMMO_REQUISICOES_POR_SEGUNDO ?? 4);
const TEST_ID = process.env.KOMMO_CAMPOS_TESTE_NACIONALIDADE_ID
  ? Number(process.env.KOMMO_CAMPOS_TESTE_NACIONALIDADE_ID)
  : null;

if (!TOKEN) throw new Error("KOMMO_ACCESS_TOKEN nao definido no .env.");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL nao definida no .env.");
if (!Number.isInteger(LIMIT) || LIMIT < 1 || LIMIT > 1000) {
  throw new Error("KOMMO_CAMPOS_LIMITE_POR_EXECUCAO deve ser um inteiro entre 1 e 1000.");
}

let nextRequestAt = 0;

async function waitForRateLimit() {
  const interval = Math.ceil(1000 / Math.max(1, REQUESTS_PER_SECOND));
  const waitMs = Math.max(0, nextRequestAt - Date.now());
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  nextRequestAt = Math.max(Date.now(), nextRequestAt) + interval;
}

function retryAfterMs(response, attempt) {
  const header = response.headers.get("retry-after");
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return Math.min(30000, 1000 * 2 ** attempt);
}

async function kommoRequest(route, options = {}) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitForRateLimit();
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
      console.warn(`[campos-kommo] HTTP ${response.status}; nova tentativa em ${Math.ceil(waitMs / 1000)}s.`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    const validation = body?.["validation-errors"] ?? body?.validation_errors ?? body?.errors;
    const error = new Error(
      `Kommo HTTP ${response.status}: ${body?.detail ?? body?.title ?? "falha"}`
      + (validation ? ` | validação: ${JSON.stringify(validation).slice(0, 1500)}` : "")
    );
    error.status = response.status;
    throw error;
  }
}

function hashDoConteudo(leadId, campos) {
  return createHash("sha256")
    .update(JSON.stringify({ leadId, campos }))
    .digest("hex")
    .slice(0, 32);
}

function maskCode(value) {
  const texto = String(value ?? "").trim();
  if (texto.length <= 4) return texto ? "****" : "";
  return `${"*".repeat(texto.length - 4)}${texto.slice(-4)}`;
}

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    statement_timeout: 30000
  });
  const lockClient = await pool.connect();
  const lock = await lockClient.query(
    "SELECT pg_try_advisory_lock(hashtext('vne_campos_kommo_nacionalidade')) AS acquired"
  );
  if (!lock.rows[0]?.acquired) {
    lockClient.release();
    await pool.end();
    throw new Error("Ja existe uma sincronizacao de campos em andamento.");
  }

  const resumo = {
    selecionados: 0,
    atualizados: 0,
    sem_mudanca: 0,
    sem_lead: 0,
    sem_dados: 0,
    erros: 0,
    simulados: 0
  };
  const detalhes = [];

  try {
    const params = [];
    let filtroTeste = "";
    if (TEST_ID) {
      params.push(TEST_ID);
      filtroTeste = `AND n.id = $${params.length}`;
    }
    params.push(LIMIT);

    // O lead vem da sincronizacao antiga ou do estado do agente. Este modulo
    // nunca cria lead: sem ID conhecido, o cadastro apenas e reportado.
    const selecionados = await pool.query(`
      SELECT n.id, n.cliente, n.codigo_consulta, n.numero_processo,
             n.fase_consulta_automatica, n.posicao_fase, n.total_fases,
             n.data_fase, n.possui_notificacao, n.titulos_notificacoes,
             n.data_ultima_consulta,
             coalesce(s.crm_lead_id, a.crm_lead_id) AS crm_lead_id,
             c.conteudo_hash, c.sincronizado_em
        FROM public.nacionalidade_portuguesa n
        LEFT JOIN public.sincronizacao_crm_nacionalidade s ON s.nacionalidade_id = n.id
        LEFT JOIN public.agente_kommo_nacionalidade_estado a ON a.nacionalidade_id = n.id
        LEFT JOIN public.campos_kommo_nacionalidade c ON c.nacionalidade_id = n.id
       WHERE n.ativo_na_planilha
         AND NOT n.registro_duplicado
         AND n.fase_consulta_automatica IS NOT NULL
         ${filtroTeste}
       ORDER BY c.sincronizado_em NULLS FIRST, n.data_ultima_consulta DESC NULLS LAST, n.id
       LIMIT $${params.length}
    `, params);

    resumo.selecionados = selecionados.rowCount;
    console.log(
      `[campos-kommo] Modo ${APPLY ? "APLICACAO" : "DIAGNOSTICO"}; `
      + `${selecionados.rowCount} cadastro(s) selecionado(s), limite ${LIMIT}.`
    );

    for (const registro of selecionados.rows) {
      const identificacao = `#${registro.id} ${registro.cliente ?? "(sem nome)"}`;
      const leadId = registro.crm_lead_id ? Number(registro.crm_lead_id) : null;

      if (!leadId) {
        resumo.sem_lead++;
        detalhes.push({ id: registro.id, cliente: registro.cliente, acao: "sem_lead" });
        console.warn(`[campos-kommo] ${identificacao}: sem lead conhecido no Kommo; ignorado.`);
        if (APPLY) {
          await pool.query(`
            INSERT INTO public.campos_kommo_nacionalidade (
              nacionalidade_id, ultima_tentativa_em, status_ultima_tentativa, atualizado_em
            ) VALUES ($1, now(), 'sem_lead', now())
            ON CONFLICT (nacionalidade_id) DO UPDATE
               SET ultima_tentativa_em = now(),
                   status_ultima_tentativa = 'sem_lead',
                   atualizado_em = now()
          `, [registro.id]);
        }
        continue;
      }

      const campos = montarCamposPersonalizados(registro);
      if (campos.length === 0) {
        resumo.sem_dados++;
        detalhes.push({ id: registro.id, cliente: registro.cliente, lead: leadId, acao: "sem_dados" });
        continue;
      }

      const hash = hashDoConteudo(leadId, campos);
      if (hash === registro.conteudo_hash) {
        resumo.sem_mudanca++;
        detalhes.push({ id: registro.id, cliente: registro.cliente, lead: leadId, acao: "sem_mudanca" });
        continue;
      }

      const corpo = { custom_fields_values: campos };
      validarCorpoSomenteCampos(corpo);

      if (!APPLY) {
        resumo.simulados++;
        detalhes.push({
          id: registro.id,
          cliente: registro.cliente,
          lead: leadId,
          acao: "seria_atualizado",
          fase: registro.fase_consulta_automatica,
          posicao: registro.posicao_fase,
          total: registro.total_fases,
          codigo: maskCode(registro.codigo_consulta),
          campos: campos.length
        });
        console.log(
          `[campos-kommo] ${identificacao}: lead ${leadId} receberia ${campos.length} campo(s) `
          + `(fase "${registro.fase_consulta_automatica}", `
          + `${registro.posicao_fase ?? "?"}/${registro.total_fases ?? "?"}).`
        );
        continue;
      }

      try {
        await kommoRequest(`/api/v4/leads/${leadId}`, {
          method: "PATCH",
          body: JSON.stringify(corpo)
        });
        resumo.atualizados++;
        detalhes.push({
          id: registro.id, cliente: registro.cliente, lead: leadId,
          acao: "atualizado", campos: campos.length
        });
        await pool.query(`
          INSERT INTO public.campos_kommo_nacionalidade (
            nacionalidade_id, crm_lead_id, conteudo_hash, sincronizado_em,
            ultima_tentativa_em, status_ultima_tentativa, erro_ultima_tentativa,
            tentativas, atualizado_em
          ) VALUES ($1, $2, $3, now(), now(), 'sucesso', NULL, 1, now())
          ON CONFLICT (nacionalidade_id) DO UPDATE
             SET crm_lead_id = EXCLUDED.crm_lead_id,
                 conteudo_hash = EXCLUDED.conteudo_hash,
                 sincronizado_em = now(),
                 ultima_tentativa_em = now(),
                 status_ultima_tentativa = 'sucesso',
                 erro_ultima_tentativa = NULL,
                 tentativas = public.campos_kommo_nacionalidade.tentativas + 1,
                 atualizado_em = now()
        `, [registro.id, leadId, hash]);
        console.log(`[campos-kommo] ${identificacao}: lead ${leadId} atualizado (${campos.length} campos).`);
      } catch (error) {
        resumo.erros++;
        detalhes.push({
          id: registro.id, cliente: registro.cliente, lead: leadId,
          acao: "erro", erro: error.message
        });
        await pool.query(`
          INSERT INTO public.campos_kommo_nacionalidade (
            nacionalidade_id, crm_lead_id, ultima_tentativa_em,
            status_ultima_tentativa, erro_ultima_tentativa, tentativas, atualizado_em
          ) VALUES ($1, $2, now(), 'erro', $3, 1, now())
          ON CONFLICT (nacionalidade_id) DO UPDATE
             SET crm_lead_id = EXCLUDED.crm_lead_id,
                 ultima_tentativa_em = now(),
                 status_ultima_tentativa = 'erro',
                 erro_ultima_tentativa = EXCLUDED.erro_ultima_tentativa,
                 tentativas = public.campos_kommo_nacionalidade.tentativas + 1,
                 atualizado_em = now()
        `, [registro.id, leadId, error.message.slice(0, 1000)]);
        console.error(`[campos-kommo] ${identificacao}: falha no lead ${leadId}: ${error.message}`);
      }
    }

    console.log("\n========== RELATORIO_AUDITORIA_CAMPOS_KOMMO ==========");
    console.log(JSON.stringify({
      tipo: "campos_personalizados_kommo",
      modo: APPLY ? "aplicacao" : "diagnostico",
      executado_em: new Date().toISOString(),
      campos_mapeados: CAMPOS,
      resumo,
      detalhes
    }, null, 2));
  } finally {
    await lockClient.query(
      "SELECT pg_advisory_unlock(hashtext('vne_campos_kommo_nacionalidade'))"
    ).catch(() => {});
    lockClient.release();
    await pool.end();
  }

  console.log("\nResumo:");
  for (const [chave, valor] of Object.entries(resumo)) {
    console.log(`  ${chave}: ${valor}`);
  }
  if (!APPLY) {
    console.log("\nNenhum dado foi alterado no Kommo. Use --aplicar para gravar.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
