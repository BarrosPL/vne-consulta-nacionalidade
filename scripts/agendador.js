import { spawn } from "node:child_process";
import {
  avisoIntegracaoKommoDesativada,
  integracaoKommoHabilitada
} from "./lib/integracao_kommo.js";
import {
  avisoCamposKommoDesativado,
  camposKommoHabilitado
} from "./lib/campos_kommo.js";

const hour = Number(process.env.AGENDADOR_HORA ?? 8);
const minute = Number(process.env.AGENDADOR_MINUTO ?? 0);
const runOnStart = String(process.env.EXECUTAR_AO_INICIAR ?? "false").toLowerCase() === "true";
// Vale somente para a execucao de partida. As verificacoes diarias seguintes
// continuam respeitando o intervalo de POSTGRES_CICLO_DIAS.
const forceCycleOnStart = String(process.env.FORCAR_CICLO_AO_INICIAR ?? "false").toLowerCase() === "true";
const validateOnly = String(process.env.AGENDADOR_APENAS_VALIDAR ?? "false").toLowerCase() === "true";
const syncEnabled = String(process.env.SINCRONIZACAO_ATIVA ?? "true").toLowerCase() === "true";
const syncIntervalMinutes = Number(process.env.SINCRONIZACAO_INTERVALO_MINUTOS ?? 10);
const syncRunOnStart = String(process.env.SINCRONIZAR_AO_INICIAR ?? "false").toLowerCase() === "true";
const kommoIntegrationEnabled = integracaoKommoHabilitada();
const kommoEnabled = kommoIntegrationEnabled
  && String(process.env.KOMMO_SINCRONIZACAO_ATIVA ?? "false").toLowerCase() === "true";
const kommoIntervalMinutes = Number(process.env.KOMMO_INTERVALO_MINUTOS ?? 15);
const kommoRunOnStart = String(process.env.KOMMO_SINCRONIZAR_AO_INICIAR ?? "false").toLowerCase() === "true";
// Rotina independente: escreve apenas campos personalizados do lead.
const fieldsIntegrationEnabled = camposKommoHabilitado();
const fieldsEnabled = fieldsIntegrationEnabled
  && String(process.env.KOMMO_CAMPOS_ATIVO ?? "false").toLowerCase() === "true";
const fieldsIntervalMinutes = Number(process.env.KOMMO_CAMPOS_INTERVALO_MINUTOS ?? 30);
const fieldsRunOnStart = String(process.env.KOMMO_CAMPOS_SINCRONIZAR_AO_INICIAR ?? "false").toLowerCase() === "true";

if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
  throw new Error("AGENDADOR_HORA deve estar entre 0 e 23.");
}
if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
  throw new Error("AGENDADOR_MINUTO deve estar entre 0 e 59.");
}
if (!Number.isInteger(syncIntervalMinutes) || syncIntervalMinutes < 1 || syncIntervalMinutes > 1440) {
  throw new Error("SINCRONIZACAO_INTERVALO_MINUTOS deve estar entre 1 e 1440.");
}
if (!Number.isInteger(kommoIntervalMinutes) || kommoIntervalMinutes < 1 || kommoIntervalMinutes > 1440) {
  throw new Error("KOMMO_INTERVALO_MINUTOS deve estar entre 1 e 1440.");
}
if (!Number.isInteger(fieldsIntervalMinutes) || fieldsIntervalMinutes < 1 || fieldsIntervalMinutes > 1440) {
  throw new Error("KOMMO_CAMPOS_INTERVALO_MINUTOS deve estar entre 1 e 1440.");
}

let child = null;
let timer = null;
let syncChild = null;
let syncTimer = null;
let kommoChild = null;
let kommoTimer = null;
let fieldsChild = null;
let fieldsTimer = null;

function nextExecution() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function schedule() {
  const next = nextExecution();
  const delay = next.getTime() - Date.now();
  console.log(`[agendador] Proxima verificacao: ${next.toISOString()}`);
  timer = setTimeout(async () => {
    await execute();
    schedule();
  }, delay);
}

function execute({ forceCycle = false } = {}) {
  if (child) {
    console.warn("[agendador] Worker anterior ainda esta ativo; verificacao ignorada.");
    return Promise.resolve();
  }
  console.log(
    `[agendador] Iniciando verificacao de ciclo: ${new Date().toISOString()}`
    + (forceCycle ? " (ciclo forcado pela partida)" : "")
  );
  return new Promise((resolve) => {
    child = spawn(process.execPath, ["consulta_status.js"], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        POSTGRES_MODO_TESTE: "false",
        POSTGRES_SIMULAR: "false",
        POSTGRES_HEADLESS: "true",
        POSTGRES_CONTROLE_CICLO: "true",
        POSTGRES_CICLO_DIAS: process.env.POSTGRES_CICLO_DIAS ?? "15",
        POSTGRES_LIMITE: process.env.POSTGRES_LIMITE ?? "1000",
        // Definido explicitamente para que uma variavel global no EasyPanel nao
        // faca a verificacao diaria abrir um ciclo completo todos os dias.
        POSTGRES_FORCAR_CICLO: forceCycle ? "true" : "false",
        // Consulta de admissao: atende cadastros novos entre dois ciclos completos.
        POSTGRES_ADMISSAO_ATIVA: process.env.POSTGRES_ADMISSAO_ATIVA ?? "true",
        POSTGRES_ADMISSAO_LIMITE: process.env.POSTGRES_ADMISSAO_LIMITE ?? "25",
        POSTGRES_ADMISSAO_REINTERVALO_HORAS:
          process.env.POSTGRES_ADMISSAO_REINTERVALO_HORAS ?? "24",
        POSTGRES_ADMISSAO_MAX_TENTATIVAS:
          process.env.POSTGRES_ADMISSAO_MAX_TENTATIVAS ?? "5"
      }
    });
    child.once("error", (error) => {
      console.error(`[agendador] Falha ao iniciar worker: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      console.log(`[agendador] Worker encerrado: codigo=${code ?? "-"}, sinal=${signal ?? "-"}`);
      child = null;
      // O resultado recem-gravado vai ao Kommo sem esperar o intervalo proprio.
      executeFields();
      resolve();
    });
  });
}

function executeSync() {
  if (!syncEnabled) return;
  if (syncChild) {
    console.warn("[sincronizacao] Execucao anterior ainda ativa; ciclo ignorado.");
    return;
  }
  console.log(`[sincronizacao] Iniciando: ${new Date().toISOString()}`);
  syncChild = spawn(process.execPath, ["scripts/sincronizar_planilha.js", "--aplicar"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env
  });
  syncChild.once("error", (error) => {
    console.error(`[sincronizacao] Falha ao iniciar: ${error.message}`);
  });
  syncChild.once("exit", (code, signal) => {
    console.log(`[sincronizacao] Encerrada: codigo=${code ?? "-"}, sinal=${signal ?? "-"}`);
    syncChild = null;
  });
}

function scheduleSync() {
  if (!syncEnabled) return;
  syncTimer = setInterval(executeSync, syncIntervalMinutes * 60 * 1000);
  console.log(`[sincronizacao] Intervalo configurado: ${syncIntervalMinutes} minuto(s).`);
}

function executeKommo() {
  if (!kommoEnabled) return;
  if (kommoChild) {
    console.warn("[kommo] Execucao anterior ainda ativa; ciclo ignorado.");
    return;
  }
  console.log(`[kommo] Iniciando sincronizacao: ${new Date().toISOString()}`);
  kommoChild = spawn(process.execPath, ["scripts/sincronizar_kommo.js", "--aplicar"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env
  });
  kommoChild.once("error", (error) => console.error(`[kommo] Falha ao iniciar: ${error.message}`));
  kommoChild.once("exit", (code, signal) => {
    console.log(`[kommo] Encerrada: codigo=${code ?? "-"}, sinal=${signal ?? "-"}`);
    kommoChild = null;
  });
}

function executeFields() {
  if (!fieldsEnabled) return;
  if (fieldsChild) {
    console.warn("[campos-kommo] Execucao anterior ainda ativa; ciclo ignorado.");
    return;
  }
  console.log(`[campos-kommo] Iniciando sincronizacao de campos: ${new Date().toISOString()}`);
  fieldsChild = spawn(process.execPath, ["scripts/sincronizar_campos_kommo.js", "--aplicar"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env
  });
  fieldsChild.once("error", (error) => console.error(`[campos-kommo] Falha ao iniciar: ${error.message}`));
  fieldsChild.once("exit", (code, signal) => {
    console.log(`[campos-kommo] Encerrada: codigo=${code ?? "-"}, sinal=${signal ?? "-"}`);
    fieldsChild = null;
  });
}

function scheduleFields() {
  if (!fieldsIntegrationEnabled) {
    console.log(avisoCamposKommoDesativado("ciclo automatico de campos personalizados"));
    return;
  }
  if (!fieldsEnabled) {
    console.log("[campos-kommo] Sincronizacao desativada por KOMMO_CAMPOS_ATIVO.");
    return;
  }
  fieldsTimer = setInterval(executeFields, fieldsIntervalMinutes * 60 * 1000);
  console.log(`[campos-kommo] Intervalo configurado: ${fieldsIntervalMinutes} minuto(s).`);
}

function scheduleKommo() {
  if (!kommoIntegrationEnabled) {
    console.log(avisoIntegracaoKommoDesativada("ciclo automatico do Kommo"));
    return;
  }
  if (!kommoEnabled) {
    console.log("[kommo] Sincronizacao desativada por KOMMO_SINCRONIZACAO_ATIVA.");
    return;
  }
  kommoTimer = setInterval(executeKommo, kommoIntervalMinutes * 60 * 1000);
  console.log(`[kommo] Intervalo configurado: ${kommoIntervalMinutes} minuto(s).`);
}

function shutdown(signal) {
  console.log(`[agendador] Encerrando por ${signal}.`);
  if (timer) clearTimeout(timer);
  if (syncTimer) clearInterval(syncTimer);
  if (kommoTimer) clearInterval(kommoTimer);
  if (fieldsTimer) clearInterval(fieldsTimer);
  if (child) child.kill("SIGTERM");
  if (syncChild) syncChild.kill("SIGTERM");
  if (kommoChild) kommoChild.kill("SIGTERM");
  if (fieldsChild) fieldsChild.kill("SIGTERM");
  setTimeout(
    () => process.exit(0),
    child || syncChild || kommoChild || fieldsChild ? 10000 : 0
  );
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (validateOnly) {
  console.log(`[agendador] Configuracao valida. Proxima verificacao: ${nextExecution().toISOString()}`);
} else {
  if (syncRunOnStart) executeSync();
  scheduleSync();
  if (kommoRunOnStart) executeKommo();
  scheduleKommo();
  if (fieldsRunOnStart) executeFields();
  scheduleFields();
  if (runOnStart) {
    if (forceCycleOnStart) {
      console.log(
        "[agendador] FORCAR_CICLO_AO_INICIAR ativo: a execucao de partida abre "
        + "um ciclo completo mesmo que o intervalo ainda nao tenha vencido."
      );
    }
    await execute({ forceCycle: forceCycleOnStart });
  } else if (forceCycleOnStart) {
    console.warn(
      "[agendador] FORCAR_CICLO_AO_INICIAR nao tem efeito sem EXECUTAR_AO_INICIAR=true."
    );
  }
  schedule();
}
