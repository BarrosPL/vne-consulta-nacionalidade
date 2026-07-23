import { spawn } from "node:child_process";

const hour = Number(process.env.AGENDADOR_HORA ?? 2);
const minute = Number(process.env.AGENDADOR_MINUTO ?? 0);
const runOnStart = String(process.env.EXECUTAR_AO_INICIAR ?? "false").toLowerCase() === "true";
const validateOnly = String(process.env.AGENDADOR_APENAS_VALIDAR ?? "false").toLowerCase() === "true";
const syncEnabled = String(process.env.SINCRONIZACAO_ATIVA ?? "true").toLowerCase() === "true";
const syncIntervalMinutes = Number(process.env.SINCRONIZACAO_INTERVALO_MINUTOS ?? 10);
const syncRunOnStart = String(process.env.SINCRONIZAR_AO_INICIAR ?? "false").toLowerCase() === "true";

if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
  throw new Error("AGENDADOR_HORA deve estar entre 0 e 23.");
}
if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
  throw new Error("AGENDADOR_MINUTO deve estar entre 0 e 59.");
}
if (!Number.isInteger(syncIntervalMinutes) || syncIntervalMinutes < 1 || syncIntervalMinutes > 1440) {
  throw new Error("SINCRONIZACAO_INTERVALO_MINUTOS deve estar entre 1 e 1440.");
}

let child = null;
let timer = null;
let syncChild = null;
let syncTimer = null;

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

function execute() {
  if (child) {
    console.warn("[agendador] Worker anterior ainda esta ativo; verificacao ignorada.");
    return Promise.resolve();
  }
  console.log(`[agendador] Iniciando verificacao de ciclo: ${new Date().toISOString()}`);
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
        POSTGRES_LIMITE: process.env.POSTGRES_LIMITE ?? "1000"
      }
    });
    child.once("error", (error) => {
      console.error(`[agendador] Falha ao iniciar worker: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      console.log(`[agendador] Worker encerrado: codigo=${code ?? "-"}, sinal=${signal ?? "-"}`);
      child = null;
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

function shutdown(signal) {
  console.log(`[agendador] Encerrando por ${signal}.`);
  if (timer) clearTimeout(timer);
  if (syncTimer) clearInterval(syncTimer);
  if (child) child.kill("SIGTERM");
  if (syncChild) syncChild.kill("SIGTERM");
  setTimeout(() => process.exit(0), child || syncChild ? 10000 : 0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (validateOnly) {
  console.log(`[agendador] Configuracao valida. Proxima verificacao: ${nextExecution().toISOString()}`);
} else {
  if (syncRunOnStart) executeSync();
  scheduleSync();
  if (runOnStart) await execute();
  schedule();
}
