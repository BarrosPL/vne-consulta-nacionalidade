import "dotenv/config";
import { spawn } from "node:child_process";
import pg from "pg";

const LIMIT = Number(process.env.TESTE_FLUXO_LIMITE ?? 10);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL não definida.");
}
if (!Number.isInteger(LIMIT) || LIMIT < 1 || LIMIT > 50) {
  throw new Error("TESTE_FLUXO_LIMITE deve estar entre 1 e 50.");
}

function runNode(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: { ...process.env, ...extraEnv }
    });
    child.once("error", (error) => resolve({ ok: false, error: error.message }));
    child.once("exit", (code, signal) => resolve({
      ok: code === 0,
      code,
      signal,
      error: code === 0 ? null : `codigo=${code ?? "-"}, sinal=${signal ?? "-"}`
    }));
  });
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  statement_timeout: 30000
});

const startedAt = new Date();
const report = {
  iniciado_em: startedAt.toISOString(),
  limite: LIMIT,
  planilha_sincronizada: false,
  selecionados: 0,
  consultas_sucesso: 0,
  consultas_erro: 0,
  kommo_sucesso: 0,
  kommo_erro: 0,
  detalhes: []
};

try {
  console.log("\n[fluxo-completo] 1/3 Sincronizando a planilha com o banco...");
  const sheet = await runNode(["scripts/sincronizar_planilha.js", "--aplicar"]);
  if (!sheet.ok) {
    throw new Error(`Sincronização da planilha falhou: ${sheet.error}`);
  }
  report.planilha_sincronizada = true;

  const candidates = await pool.query(`
    SELECT id, id_registro, cliente, codigo_consulta
      FROM public.nacionalidade_portuguesa
     WHERE ativo_na_planilha
       AND NOT registro_duplicado
       AND NOT processo_finalizado
       AND nullif(btrim(id_registro), '') IS NOT NULL
       AND nullif(btrim(codigo_consulta), '') IS NOT NULL
     ORDER BY data_ultima_consulta NULLS FIRST, id
     LIMIT $1
  `, [LIMIT]);

  report.selecionados = candidates.rowCount;
  if (!candidates.rowCount) {
    console.log("[fluxo-completo] Nenhuma pessoa elegível encontrada.");
  }

  console.log(`\n[fluxo-completo] 2/3 Consultando ${candidates.rowCount} pessoa(s)...`);
  for (let index = 0; index < candidates.rows.length; index++) {
    const candidate = candidates.rows[index];
    const detail = {
      id: candidate.id,
      cliente: candidate.cliente,
      consulta: "pendente",
      kommo: "pendente"
    };
    report.detalhes.push(detail);
    console.log(`\n[fluxo-completo] Consulta ${index + 1}/${candidates.rowCount}: ${candidate.cliente}`);

    const consultationStartedAt = new Date();
    const consultation = await runNode(["consulta_status.js"], {
      POSTGRES_MODO_TESTE: "true",
      POSTGRES_TEST_RECORD_ID: String(candidate.id_registro),
      POSTGRES_SIMULAR: "false",
      POSTGRES_HEADLESS: "true",
      POSTGRES_CONTROLE_CICLO: "false",
      POSTGRES_LIMITE: "1"
    });

    const consultationState = await pool.query(`
      SELECT status_ultima_tentativa, erro_ultima_tentativa, data_ultima_tentativa
        FROM public.nacionalidade_portuguesa
       WHERE id=$1
    `, [candidate.id]);
    const state = consultationState.rows[0];
    const attemptedNow = state?.data_ultima_tentativa
      && new Date(state.data_ultima_tentativa) >= consultationStartedAt;
    const consultationSucceeded = consultation.ok
      && attemptedNow
      && state.status_ultima_tentativa === "sucesso";

    if (consultationSucceeded) {
      detail.consulta = "sucesso";
      report.consultas_sucesso++;
    } else {
      detail.consulta = "erro";
      detail.erro_consulta = state?.erro_ultima_tentativa
        ?? consultation.error
        ?? "A consulta não registrou uma tentativa nova.";
      report.consultas_erro++;
    }
  }

  console.log(`\n[fluxo-completo] 3/3 Sincronizando as mesmas ${candidates.rowCount} pessoa(s) com o Kommo...`);
  for (let index = 0; index < candidates.rows.length; index++) {
    const candidate = candidates.rows[index];
    const detail = report.detalhes[index];
    console.log(`\n[fluxo-completo] Kommo ${index + 1}/${candidates.rowCount}: ${candidate.cliente}`);
    const kommoStartedAt = new Date();
    const kommo = await runNode(["scripts/sincronizar_kommo.js", "--aplicar"], {
      KOMMO_TESTE_NACIONALIDADE_ID: String(candidate.id),
      KOMMO_LIMITE_POR_EXECUCAO: "1"
    });
    const kommoState = await pool.query(`
      SELECT n.kommo_pendente, s.status_ultima_tentativa,
             s.erro_ultima_tentativa, s.ultima_tentativa_em
        FROM public.nacionalidade_portuguesa n
        LEFT JOIN public.sincronizacao_crm_nacionalidade s
          ON s.nacionalidade_id=n.id
       WHERE n.id=$1
    `, [candidate.id]);
    const state = kommoState.rows[0];
    const attemptedNow = state?.ultima_tentativa_em
      && new Date(state.ultima_tentativa_em) >= kommoStartedAt;
    const kommoSucceeded = kommo.ok
      && attemptedNow
      && state?.kommo_pendente === false
      && state?.status_ultima_tentativa === "sucesso";
    if (kommoSucceeded) {
      detail.kommo = "sucesso";
      report.kommo_sucesso++;
    } else {
      detail.kommo = "erro";
      detail.erro_kommo = state?.erro_ultima_tentativa
        ?? kommo.error
        ?? "A pendência não foi baixada.";
      report.kommo_erro++;
    }
  }
} catch (error) {
  report.erro_geral = error.message;
  process.exitCode = 1;
} finally {
  report.finalizado_em = new Date().toISOString();
  report.duracao_minutos = Number(
    ((new Date(report.finalizado_em) - startedAt) / 60000).toFixed(2)
  );
  console.log("\n========== RELATÓRIO DO FLUXO COMPLETO ==========");
  console.log(JSON.stringify(report, null, 2));
  await pool.end().catch(() => {});
}
