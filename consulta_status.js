import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import ExcelJS from "exceljs";
import { google } from "googleapis";
import { chromium } from "playwright";
import pg from "pg";
import "dotenv/config";

// ─── Configurações de chaves ──────────────────────────────────────────────────

const CAPSOLVER_API_KEY   = process.env.CAPSOLVER_API_KEY   ?? "";
const TWOCAPTCHA_API_KEY  = process.env.TWOCAPTCHA_API_KEY  ?? "";

// ─── Detecção de hCaptcha ─────────────────────────────────────────────────────

async function extractHCaptchaSitekey(page) {
  const fromDom = await page.evaluate(() => {
    const el =
      document.querySelector(".h-captcha[data-sitekey]") ||
      document.querySelector("[data-sitekey]");
    return el?.getAttribute("data-sitekey") ?? null;
  });
  if (fromDom) {
    console.log("  [hcaptcha] Sitekey encontrada no DOM:", fromDom);
    return fromDom;
  }

  for (const frame of page.frames()) {
    const url = frame.url();
    if (url.includes("hcaptcha.com")) {
      const match = url.match(/[?&]sitekey=([^&]+)/);
      if (match) {
        console.log("  [hcaptcha] Sitekey extraída do iframe:", match[1]);
        return match[1];
      }
    }
  }

  const html = await page.content();
  const match =
    html.match(/data-sitekey=["']([^"']+)["']/) ||
    html.match(/"sitekey"\s*:\s*"([^"]+)"/);
  if (match) {
    console.log("  [hcaptcha] Sitekey encontrada via regex:", match[1]);
    return match[1];
  }

  return null;
}

async function hasHCaptcha(page) {
  for (const frame of page.frames()) {
    if (frame.url().includes("hcaptcha.com")) return true;
  }
  return await page.evaluate(() => {
    return !!(
      document.querySelector(".h-captcha") ||
      document.querySelector("iframe[src*='hcaptcha.com']") ||
      document.querySelector("script[src*='hcaptcha.com']")
    );
  });
}

// ─── Injeção do token ─────────────────────────────────────────────────────────

async function injectHCaptchaToken(page, token) {
  await page.evaluate((tkn) => {
    for (const sel of ["[name='h-captcha-response']", "[name='g-recaptcha-response']"]) {
      const el = document.querySelector(sel);
      if (el) {
        el.style.display = "block";
        el.value = tkn;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    try {
      if (typeof window.hcaptcha !== "undefined") {
        const widgetEl = document.querySelector(".h-captcha");
        const widgetId = widgetEl?.getAttribute("data-hcaptcha-widget-id");
        if (widgetId !== null && widgetId !== undefined) {
          window.hcaptcha.setResponse(widgetId, tkn);
        }
      }
    } catch (_) { /* silencia */ }
    try {
      const widgetEl = document.querySelector(".h-captcha[data-callback]");
      const cbName = widgetEl?.getAttribute("data-callback");
      if (cbName && typeof window[cbName] === "function") {
        window[cbName](tkn);
      }
    } catch (_) { /* silencia */ }
  }, token);

  await page.waitForTimeout(2000);

  const accepted = await page.evaluate(() => {
    const resp = document.querySelector("[name='h-captcha-response']");
    return !!(resp && resp.value && resp.value.length > 10);
  });

  console.log(`  [hcaptcha] Token injetado. Aceito pelo widget: ${accepted}`);
  return accepted;
}

// ─── CapSolver ────────────────────────────────────────────────────────────────

async function solveWithCapSolver(pageUrl, sitekey) {
  if (!CAPSOLVER_API_KEY) throw new Error("CAPSOLVER_API_KEY não definida no .env");

  console.log("  [CapSolver] Criando tarefa...");
  const createRes = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: CAPSOLVER_API_KEY,
      task: {
        type: "HCaptchaTaskProxyless",
        websiteURL: pageUrl,
        websiteKey: sitekey,
        isInvisible: false
      }
    })
  });
  const createData = await createRes.json();

  if (createData.errorId !== 0) {
    throw new Error(`CapSolver createTask erro: ${createData.errorCode} - ${createData.errorDescription}`);
  }

  const taskId = createData.taskId;
  console.log(`  [CapSolver] Tarefa criada: ${taskId}`);

  await new Promise((r) => setTimeout(r, 8000));

  const startTime = Date.now();
  const TIMEOUT_MS = 120_000;
  let attempt = 0;

  while (Date.now() - startTime < TIMEOUT_MS) {
    attempt++;
    const elapsed = Date.now() - startTime;
    const interval = elapsed < 30_000 ? 3000 : 5000;

    const resultRes = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY, taskId })
    });
    const resultData = await resultRes.json();

    if (resultData.errorId !== 0) {
      throw new Error(`CapSolver getTaskResult erro: ${resultData.errorCode} - ${resultData.errorDescription}`);
    }
    if (resultData.status === "ready") {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  [CapSolver] CAPTCHA resolvido em ${elapsed}s!`);
      return (
        resultData.solution?.gRecaptchaResponse ??
        resultData.solution?.token ??
        ""
      );
    }

    console.log(`  [CapSolver] Aguardando... ${(elapsed / 1000).toFixed(0)}s (tentativa ${attempt})`);
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error("CapSolver timeout: solução não recebida em 120s");
}

// ─── 2Captcha ─────────────────────────────────────────────────────────────────

async function post2Captcha(endpoint, payload, config, attemptLabel = "") {
  const maxRateLimitRetries = 3;
  const baseDelay = Number(config.captcha_rate_limit_base_ms) || 15000;

  for (let attempt = 1; attempt <= maxRateLimitRetries + 1; attempt++) {
    const response = await fetch(`https://api.2captcha.com/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (response.status !== 429) {
      if (!response.ok) {
        throw new Error(`2Captcha HTTP ${response.status} em ${endpoint}`);
      }
      return response.json();
    }

    if (attempt > maxRateLimitRetries) {
      throw new Error(`2Captcha HTTP 429 persistente em ${endpoint}`);
    }
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : Math.min(baseDelay * (2 ** (attempt - 1)), 60000);
    console.warn(
      `  [2Captcha] ${attemptLabel} — limite HTTP 429; ` +
      `aguardando ${Math.ceil(delay / 1000)}s antes de continuar.`
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`2Captcha sem resposta em ${endpoint}`);
}

async function solveWith2Captcha(pageUrl, sitekey, config, captchaAttempt, maxCaptchaAttempts) {
  if (!TWOCAPTCHA_API_KEY) throw new Error("TWOCAPTCHA_API_KEY não definida no .env");

  const timeoutMs = Number(config.captcha_solver_timeout_ms) || 180000;
  const pollIntervalMs = Math.max(Number(config.captcha_poll_interval_ms) || 5000, 5000);
  const attemptStartedAt = Date.now();
  const attemptLabel = `Tentativa ${captchaAttempt}/${maxCaptchaAttempts}`;

  console.log("  [2Captcha] Criando tarefa...");
  const createData = await post2Captcha("createTask", {
    clientKey: TWOCAPTCHA_API_KEY,
    task: {
      type: "HCaptchaTaskProxyless",
      websiteURL: pageUrl,
      websiteKey: sitekey,
      isInvisible: false,
      enterprisePayload: {}
    }
  }, config, attemptLabel);

  if (createData.errorId !== 0) {
    throw new Error(`2Captcha createTask erro: ${createData.errorCode} - ${createData.errorDescription}`);
  }

  const taskId = createData.taskId;
  console.log(`  [2Captcha] Tarefa criada: ${taskId}`);

  await new Promise((r) => setTimeout(r, pollIntervalMs));

  const TIMEOUT_MS = timeoutMs;
  let attempt = 0;

  while (Date.now() - attemptStartedAt < TIMEOUT_MS) {
    attempt++;
    const elapsed = Date.now() - attemptStartedAt;

    const resultData = await post2Captcha(
      "getTaskResult",
      { clientKey: TWOCAPTCHA_API_KEY, taskId },
      config,
      attemptLabel
    );

    if (resultData.errorId !== 0) {
      throw new Error(`2Captcha getTaskResult erro: ${resultData.errorCode}`);
    }
    if (resultData.status === "ready") {
      const elapsed = ((Date.now() - attemptStartedAt) / 1000).toFixed(1);
      console.log(`  [2Captcha] CAPTCHA resolvido em ${elapsed}s!`);
      return (
        resultData.solution?.gRecaptchaResponse ??
        resultData.solution?.token ??
        ""
      );
    }

    console.log(
      `  [2Captcha] ${attemptLabel} — aguardando ` +
      `${Math.round(elapsed / 1000)}s de ${Math.round(TIMEOUT_MS / 1000)}s`
    );
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`2Captcha timeout: solução não recebida em ${Math.round(TIMEOUT_MS / 1000)}s`);
}

// ─── Orquestrador: CapSolver → 2Captcha ──────────────────────────────────────

async function solveHCaptcha(page, config) {
  const pageUrl = page.url();
  const sitekey = await extractHCaptchaSitekey(page);
  if (!sitekey) throw new Error("Sitekey do hCaptcha não encontrada.");

  console.log(`  [captcha] Sitekey: ${sitekey}`);

  const useCapSolver = config.use_capsolver && CAPSOLVER_API_KEY;
  const use2Captcha  = config.use_2captcha  && TWOCAPTCHA_API_KEY;

  const solvers = [];
  if (useCapSolver) solvers.push({ name: "CapSolver", fn: () => solveWithCapSolver(pageUrl, sitekey) });
  if (use2Captcha)  solvers.push({
    name: "2Captcha",
    fn: (attempt, maxAttempts) => solveWith2Captcha(
      pageUrl,
      sitekey,
      config,
      attempt,
      maxAttempts
    )
  });

  if (solvers.length === 0) {
    throw new Error(
      "Nenhum solver configurado. Defina use_capsolver e/ou use_2captcha no config.json " +
      "e as respectivas chaves no .env."
    );
  }

  for (const solver of solvers) {
    console.log(`\n  [captcha] Tentando solver: ${solver.name}`);

    const maxRetries = Number(config.captcha_max_retries) || 1;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`  [${solver.name}] Tentativa ${attempt}/${maxRetries}...`);
      try {
        const token    = await solver.fn(attempt, maxRetries);
        const accepted = await injectHCaptchaToken(page, token);

        if (accepted) {
          console.log(`  [captcha] Resolvido com ${solver.name}!`);
          return;
        }

        console.log(`  [${solver.name}] Token rejeitado pelo widget, tentando novamente...`);
      } catch (err) {
        console.error(`  [${solver.name}] Erro na tentativa ${attempt}: ${err.message}`);
        if (attempt === maxRetries) {
          console.warn(`  [captcha] ${solver.name} esgotou tentativas. ${solvers.indexOf(solver) + 1 < solvers.length ? "Tentando próximo solver..." : "Sem mais solvers."}`);
          break;
        }
      }

      await page.waitForTimeout(2000);
    }
  }

  throw new Error(`hCaptcha não resolvido após tentar todos os solvers disponíveis.`);
}

// ─── handleCaptcha ────────────────────────────────────────────────────────────

export async function handleCaptcha(page, config, rl) {
  if (!config.use_capsolver && !config.use_2captcha) {
    await waitForManualCaptcha(page, rl);
    return;
  }

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const found = await hasHCaptcha(page);
  console.log(`  [captcha] hCaptcha detectado: ${found}`);

  if (!found) {
    console.log("  [captcha] Nenhum CAPTCHA detectado, prosseguindo...");
    return;
  }

  await solveHCaptcha(page, config);
}

// ─── Configuração ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  storage:           "local_excel",
  input_file:        "Leads_Correlacionados_Codigo_Consulta.xlsx",
  output_file:       "Leads_Correlacionados_Com_Status.xlsx",
  google_sheet_id:   "",
  google_sheet_name: "Pagina1",
  google_credentials_file: "google-service-account.json",
  codigo_coluna:     "codigo_consulta",
  status_coluna:     "status_processo",
  posicao_fase_coluna: "posicao_fase",
  total_fases_coluna: "total_fases",
  data_fase_coluna:  "data_fase",
  notificacao_coluna: "possui_notificacao",
  titulos_notificacoes_coluna: "titulos_notificacoes",
  data_consulta_coluna: "data_ultima_consulta",
  observacao_coluna: "observacao_consulta",
  url_consulta:
    "https://meu.registo.justica.gov.pt/Pedidos/Consultar-estado-do-processo-de-nacionalidade",
  headless:           false,
  timeout_ms:         60000,
  pause_para_captcha: false,
  use_capsolver:      false,
  use_2captcha:       true,
  modo_teste:         true,
  id_registro_teste:  "",
  limite_por_execucao: 1,
  reconsultar_processados: false,
  simular:             true,
  captcha_max_retries: 3,
  captcha_solver_timeout_ms: 180000,
  captcha_poll_interval_ms: 5000,
  captcha_rate_limit_base_ms: 15000,
  captcha_nova_pagina_delay_ms: 5000,
  consulta_max_tentativas: 2,
  consulta_timeout_total_ms: 660000,
  intervalo_entre_consultas_ms: 5000,
  reconsulta_apos_dias: 15,
  usar_controle_ciclo: true,
  ciclo_intervalo_dias: 15,
  forcar_ciclo: false,
  // Consulta de admissao: atende cadastros novos que ainda nunca produziram um
  // resultado, sem esperar o vencimento do ciclo global.
  admissao_ativa: true,
  admissao_limite: 25,
  admissao_reintervalo_horas: 24,
  admissao_max_tentativas: 5
};

// ─── Utilitários ──────────────────────────────────────────────────────────────

export function loadConfig() {
  const configPath = path.resolve("config.json");
  const config = fs.existsSync(configPath)
    ? { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, "utf8")) }
    : { ...DEFAULT_CONFIG };
  if (process.env.POSTGRES_TEST_RECORD_ID) {
    config.id_registro_teste = process.env.POSTGRES_TEST_RECORD_ID;
  }
  if (process.env.POSTGRES_TEST_NACIONALIDADE_ID) {
    config.nacionalidade_id_teste = Number(process.env.POSTGRES_TEST_NACIONALIDADE_ID);
  }
  if (process.env.POSTGRES_SIMULAR) {
    config.simular = process.env.POSTGRES_SIMULAR.toLowerCase() === "true";
  }
  if (process.env.POSTGRES_MODO_TESTE) {
    config.modo_teste = process.env.POSTGRES_MODO_TESTE.toLowerCase() === "true";
  }
  if (process.env.POSTGRES_LIMITE) {
    config.limite_por_execucao = Number(process.env.POSTGRES_LIMITE);
  }
  if (process.env.POSTGRES_HEADLESS) {
    config.headless = process.env.POSTGRES_HEADLESS.toLowerCase() === "true";
  }
  if (process.env.POSTGRES_CONTROLE_CICLO) {
    config.usar_controle_ciclo = process.env.POSTGRES_CONTROLE_CICLO.toLowerCase() === "true";
  }
  if (process.env.POSTGRES_CICLO_DIAS) {
    config.ciclo_intervalo_dias = Number(process.env.POSTGRES_CICLO_DIAS);
  }
  if (process.env.POSTGRES_FORCAR_CICLO) {
    config.forcar_ciclo = process.env.POSTGRES_FORCAR_CICLO.toLowerCase() === "true";
  }
  if (process.env.POSTGRES_ADMISSAO_ATIVA) {
    config.admissao_ativa = process.env.POSTGRES_ADMISSAO_ATIVA.toLowerCase() === "true";
  }
  if (process.env.POSTGRES_ADMISSAO_LIMITE) {
    config.admissao_limite = Number(process.env.POSTGRES_ADMISSAO_LIMITE);
  }
  if (process.env.POSTGRES_ADMISSAO_REINTERVALO_HORAS) {
    config.admissao_reintervalo_horas = Number(process.env.POSTGRES_ADMISSAO_REINTERVALO_HORAS);
  }
  if (process.env.POSTGRES_ADMISSAO_MAX_TENTATIVAS) {
    config.admissao_max_tentativas = Number(process.env.POSTGRES_ADMISSAO_MAX_TENTATIVAS);
  }
  return config;
}

function normalizeHeader(value) {
  return String(value ?? "").trim().toLowerCase();
}

function cellText(cell) {
  if (cell.value == null) return "";
  if (typeof cell.value === "object" && "text"   in cell.value) return String(cell.value.text);
  if (typeof cell.value === "object" && "result" in cell.value) return String(cell.value.result ?? "");
  return String(cell.value);
}

function readHeaders(sheet) {
  const headers = new Map();
  sheet.getRow(1).eachCell((cell, colNumber) => {
    const key = normalizeHeader(cellText(cell));
    if (key) headers.set(key, colNumber);
  });
  return headers;
}

function requireColumn(headers, name) {
  const key = normalizeHeader(name);
  if (!headers.has(key)) {
    throw new Error(
      `Coluna '${name}' não encontrada. Colunas disponíveis: ${[...headers.keys()].join(", ")}`
    );
  }
  return headers.get(key);
}

function ensureColumn(sheet, headers, name) {
  const key = normalizeHeader(name);
  if (headers.has(key)) return headers.get(key);
  const colNumber = sheet.columnCount + 1;
  sheet.getCell(1, colNumber).value = name;
  headers.set(key, colNumber);
  return colNumber;
}

function columnToLetter(colNumber) {
  let letters = "";
  let value = colNumber;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function escapeSheetName(sheetName) {
  return String(sheetName).replaceAll("'", "''");
}

function googleRange(sheetName, colNumber, rowNumber) {
  const column = columnToLetter(colNumber);
  return `'${escapeSheetName(sheetName)}'!${column}${rowNumber}`;
}

function googleCellText(value) {
  return String(value ?? "");
}

function maskCode(value) {
  const code = String(value ?? "");
  if (code.length <= 4) return "****";
  return `${code.slice(0, 2)}${"*".repeat(Math.min(code.length - 4, 8))}${code.slice(-2)}`;
}

async function withTimeout(promise, timeoutMs, message, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
          Promise.resolve(onTimeout?.()).catch(() => {});
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function readGoogleHeaders(rowValues = []) {
  const headers = new Map();
  rowValues.forEach((value, index) => {
    const key = normalizeHeader(value);
    if (key) headers.set(key, index + 1);
  });
  return headers;
}

function outputColumnDefinitions(config) {
  return [
    { key: "status", name: config.status_coluna },
    { key: "position", name: config.posicao_fase_coluna },
    { key: "totalPhases", name: config.total_fases_coluna },
    { key: "phaseDate", name: config.data_fase_coluna },
    { key: "hasNotification", name: config.notificacao_coluna },
    { key: "notificationTitles", name: config.titulos_notificacoes_coluna },
    { key: "consultedAt", name: config.data_consulta_coluna },
    { key: "observation", name: config.observacao_coluna }
  ];
}

async function createGoogleSheetsClient(config) {
  const credentialsFile =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    config.google_credentials_file;

  const authOptions = {
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  };

  if (credentialsFile) {
    authOptions.keyFile = path.resolve(credentialsFile);
  }

  const auth = new google.auth.GoogleAuth(authOptions);
  return google.sheets({ version: "v4", auth });
}

async function openLocalExcelSpreadsheet(config) {
  const inputFile  = path.resolve(config.input_file);
  const outputFile = path.resolve(config.output_file);
  if (!fs.existsSync(inputFile)) throw new Error(`Arquivo de entrada nao encontrado: ${inputFile}`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputFile);
  const sheet     = workbook.worksheets[0];
  const headers   = readHeaders(sheet);
  const codigoCol = requireColumn(headers, config.codigo_coluna);
  const outputColumns = outputColumnDefinitions(config).map((definition) => ({
    ...definition,
    column: ensureColumn(sheet, headers, definition.name)
  }));

  await workbook.xlsx.writeFile(outputFile);

  return {
    rowCount: sheet.rowCount,
    getCodigo(rowNumber) {
      return cellText(sheet.getRow(rowNumber).getCell(codigoCol)).trim();
    },
    async updateRow(rowNumber, result, observacao) {
      const row = sheet.getRow(rowNumber);
      const values = { ...(result ?? {}), observation: observacao };
      for (const definition of outputColumns) {
        row.getCell(definition.column).value = values[definition.key] ?? "";
      }
      await workbook.xlsx.writeFile(outputFile);
    },
    finishMessage: `Planilha gerada/atualizada: ${outputFile}`
  };
}

async function ensureGoogleColumn(sheets, spreadsheetId, sheetName, headerValues, headers, name) {
  const key = normalizeHeader(name);
  if (headers.has(key)) return headers.get(key);

  const colNumber = Math.max(headerValues.length, ...headers.values(), 0) + 1;
  headerValues[colNumber - 1] = name;
  headers.set(key, colNumber);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: googleRange(sheetName, colNumber, 1),
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[name]] }
  });

  return colNumber;
}

async function openGoogleSheetsSpreadsheet(config) {
  const spreadsheetId =
    process.env.GOOGLE_SHEET_ID ||
    config.google_sheet_id;
  const sheetName = config.google_sheet_name;

  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEET_ID nao definido no .env nem em google_sheet_id no config.json.");
  }
  if (!sheetName) {
    throw new Error("google_sheet_name nao definido no config.json.");
  }

  const sheets = await createGoogleSheetsClient(config);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${escapeSheetName(sheetName)}'!A:ZZ`
  });

  const values = response.data.values ?? [];
  if (values.length === 0) {
    throw new Error(`A aba '${sheetName}' esta vazia. A primeira linha precisa conter os cabecalhos.`);
  }

  const headerValues = values[0] ?? [];
  const headers = readGoogleHeaders(headerValues);
  const codigoCol = requireColumn(headers, config.codigo_coluna);
  const outputColumns = [];
  for (const definition of outputColumnDefinitions(config)) {
    outputColumns.push({
      ...definition,
      column: await ensureGoogleColumn(
        sheets,
        spreadsheetId,
        sheetName,
        headerValues,
        headers,
        definition.name
      )
    });
  }

  return {
    rowCount: values.length,
    getCodigo(rowNumber) {
      return googleCellText(values[rowNumber - 1]?.[codigoCol - 1]).trim();
    },
    async updateRow(rowNumber, result, observacao) {
      const rowValues = { ...(result ?? {}), observation: observacao };
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: outputColumns.map((definition) => ({
            range: googleRange(sheetName, definition.column, rowNumber),
            values: [[rowValues[definition.key] ?? ""]]
          }))
        }
      });
    },
    finishMessage: `Planilha do Google atualizada: ${spreadsheetId} / aba '${sheetName}'`
  };
}

function parsePhasePosition(value) {
  const match = String(value ?? "").match(/^(\d+)\s+de\s+(\d+)$/i);
  return match ? { position: Number(match[1]), total: Number(match[2]) } : {};
}

function parsePortalDate(value) {
  const match = String(value ?? "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function isFinalProcess(status, position, total) {
  const normalized = String(status ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
  return (Number.isInteger(position) && Number.isInteger(total) && total > 0 && position === total)
    || ["concluido", "terminado", "encerrado", "finalizado"].includes(normalized);
}

export function isInactiveProcessMessage(value) {
  const normalized = String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return normalized.includes(
    "nao corresponde a nenhum processo de nacionalidade ativo"
  );
}

function classifyError(error) {
  const message = String(error?.message ?? error ?? "Erro desconhecido");
  const firstLine = message.split(/\r?\n/, 1)[0].trim();
  if (/tempo total|timeout total/i.test(message)) return { type: "timeout", message: firstLine };
  if (/captcha/i.test(message)) return { type: "captcha", message: firstLine };
  if (/goto|navega|net::|timeout.*page/i.test(message)) return { type: "navegacao", message: firstLine };
  if (/fase|timeline|identificar/i.test(message)) return { type: "extracao", message: firstLine };
  if (/codigo|código|processo/i.test(message)) return { type: "codigo", message: firstLine };
  return { type: "inesperado", message: firstLine };
}

export function isRetryableConsultationError(type) {
  return ["timeout", "navegacao", "extracao", "codigo", "captcha"].includes(type);
}

export async function openPostgresStorage(config) {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL nao definida no .env.");
  }

  const limit = Number(config.limite_por_execucao);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("limite_por_execucao deve ser um inteiro entre 1 e 1000.");
  }
  const testNacionalidadeId = Number(config.nacionalidade_id_teste);
  const hasNumericTestId = Number.isSafeInteger(testNacionalidadeId)
    && testNacionalidadeId > 0;
  const hasLegacyTestId = Boolean(String(config.id_registro_teste ?? "").trim());
  if (config.modo_teste && !hasNumericTestId && !hasLegacyTestId) {
    throw new Error(
      "No modo_teste, defina nacionalidade_id_teste ou id_registro_teste."
    );
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    statement_timeout: 30000
  });
  const lockClient = await pool.connect();
  const lockResult = await lockClient.query(`
    SELECT pg_try_advisory_lock(hashtext('vne_consulta_nacionalidade')) AS acquired
  `);
  if (!lockResult.rows[0]?.acquired) {
    lockClient.release();
    await pool.end();
    throw new Error("Ja existe uma execucao de consulta de nacionalidade em andamento.");
  }

  let cycleId = null;
  let cycleFinalized = false;
  let nextCycleAt = null;
  let cycleDue = true;
  const useCycleControl = !config.modo_teste && Boolean(config.usar_controle_ciclo);
  const cycleDays = Number(config.ciclo_intervalo_dias);
  if (useCycleControl) {
    if (!Number.isInteger(cycleDays) || cycleDays < 1 || cycleDays > 365) {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext('vne_consulta_nacionalidade'))");
      lockClient.release();
      await pool.end();
      throw new Error("ciclo_intervalo_dias deve ser um inteiro entre 1 e 365.");
    }
    // Somente ciclos completos definem o vencimento. Uma consulta de admissao
    // nunca reinicia a contagem do intervalo global.
    const lastCycle = await lockClient.query(`
      SELECT finalizado_em,
             finalizado_em + ($1 * interval '1 day') AS proxima_execucao_em
        FROM public.ciclos_consulta_nacionalidade
       WHERE status IN ('concluido', 'concluido_com_erros')
         AND tipo = 'completo'
       ORDER BY finalizado_em DESC
       LIMIT 1
    `, [cycleDays]);
    nextCycleAt = lastCycle.rows[0]?.proxima_execucao_em ?? null;
    cycleDue = !nextCycleAt || new Date(nextCycleAt) <= new Date();
    // Abre um ciclo completo mesmo antes do vencimento. Usado na implantacao,
    // quando se quer reprocessar todos os codigos sem esperar o intervalo.
    if (!cycleDue && config.forcar_ciclo) {
      console.warn(
        "[ciclo] POSTGRES_FORCAR_CICLO ativo: abrindo ciclo completo antes do "
        + `vencimento previsto para ${new Date(nextCycleAt).toISOString()}.`
      );
      cycleDue = true;
    }
  }

  // Enquanto o ciclo global nao vence, uma passagem curta atende quem entrou
  // depois do ultimo ciclo e ainda nao tem nenhum resultado. O ciclo completo
  // continua governado apenas por ciclo_intervalo_dias.
  const admissionRun = useCycleControl
    && !cycleDue
    && !config.modo_teste
    && Boolean(config.admissao_ativa);
  const admissionLimit = Number(config.admissao_limite);
  const admissionRetryHours = Number(config.admissao_reintervalo_horas);
  const admissionMaxAttempts = Number(config.admissao_max_tentativas);
  if (admissionRun) {
    if (!Number.isInteger(admissionLimit) || admissionLimit < 1 || admissionLimit > 1000) {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext('vne_consulta_nacionalidade'))");
      lockClient.release();
      await pool.end();
      throw new Error("admissao_limite deve ser um inteiro entre 1 e 1000.");
    }
    if (!Number.isInteger(admissionRetryHours) || admissionRetryHours < 1 || admissionRetryHours > 8760) {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext('vne_consulta_nacionalidade'))");
      lockClient.release();
      await pool.end();
      throw new Error("admissao_reintervalo_horas deve ser um inteiro entre 1 e 8760.");
    }
    if (!Number.isInteger(admissionMaxAttempts) || admissionMaxAttempts < 1 || admissionMaxAttempts > 100) {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext('vne_consulta_nacionalidade'))");
      lockClient.release();
      await pool.end();
      throw new Error("admissao_max_tentativas deve ser um inteiro entre 1 e 100.");
    }
  }

  const params = [];
  const filters = [
    "nullif(btrim(codigo_consulta), '') IS NOT NULL",
    "ativo_na_planilha",
    "NOT registro_duplicado",
    "NOT processo_finalizado"
  ];

  if (config.modo_teste) {
    if (hasNumericTestId) {
      params.push(testNacionalidadeId);
      filters.push(`id = $${params.length}`);
    } else {
      params.push(String(config.id_registro_teste).trim());
      filters.push(`btrim(id_registro) = btrim($${params.length})`);
    }
  } else if (useCycleControl) {
    // Um ciclo vencido sempre percorre todos os codigos do banco.
    if (admissionRun) {
      // Somente cadastros que nunca chegaram a produzir uma fase.
      filters.push("fase_consulta_automatica IS NULL");
      // Espaca as retentativas de um cadastro novo que falhou.
      params.push(admissionRetryHours);
      filters.push(`(
        data_ultima_tentativa IS NULL
        OR data_ultima_tentativa < now() - ($${params.length} * interval '1 hour')
      )`);
      // Um codigo que falha sempre para de ser tentado e aguarda o ciclo completo.
      params.push(admissionMaxAttempts);
      filters.push(`(
        SELECT count(*)
          FROM public.historico_consultas_nacionalidade h
         WHERE h.nacionalidade_id = public.nacionalidade_portuguesa.id
           AND NOT h.sucesso
      ) < $${params.length}`);
    }
  } else if (config.reconsultar_processados) {
    const days = Number(config.reconsulta_apos_dias);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext('vne_consulta_nacionalidade'))");
      lockClient.release();
      await pool.end();
      throw new Error("reconsulta_apos_dias deve ser um inteiro entre 1 e 365.");
    }
    params.push(days);
    filters.push(`(
      fase_consulta_automatica IS NULL
      OR data_ultima_consulta < now() - ($${params.length} * interval '1 day')
    )`);
  } else {
    filters.push("fase_consulta_automatica IS NULL");
  }
  params.push(admissionRun ? admissionLimit : limit);

  const selectedCodes = (cycleDue || admissionRun) ? await pool.query(`
    SELECT btrim(codigo_consulta) AS codigo
      FROM public.nacionalidade_portuguesa
     WHERE ${filters.join(" AND ")}
     GROUP BY btrim(codigo_consulta)
     ORDER BY min(id)
     LIMIT $${params.length}
  `, params) : { rows: [] };

  const entries = [];
  for (const { codigo } of selectedCodes.rows) {
    const relatedParams = [codigo];
    let relatedTestFilter = "";
    if (config.modo_teste) {
      if (hasNumericTestId) {
        relatedTestFilter = `AND id = $${relatedParams.push(testNacionalidadeId)}`;
      } else {
        relatedTestFilter =
          `AND btrim(id_registro) = btrim($${relatedParams.push(
            String(config.id_registro_teste).trim()
          )})`;
      }
    }
    const related = await pool.query(`
      SELECT id, id_registro
        FROM public.nacionalidade_portuguesa
       WHERE btrim(codigo_consulta) = $1
         AND ativo_na_planilha
         AND NOT registro_duplicado
         AND NOT processo_finalizado
         ${relatedTestFilter}
       ORDER BY id
    `, relatedParams);
    entries.push({ codigo, records: related.rows });
  }

  if (admissionRun) {
    console.log(
      `[admissao] Ciclo completo ainda nao vencido (previsto para ${new Date(nextCycleAt).toISOString()}). `
      + `${entries.length} cadastro(s) novo(s) sem resultado selecionado(s), limite ${admissionLimit}.`
    );
  }

  // Uma admissao sem ninguem a atender nao abre registro de ciclo.
  const cycleType = cycleDue ? "completo" : "admissao";
  const shouldOpenCycle = cycleDue || (admissionRun && entries.length > 0);
  if (useCycleControl && shouldOpenCycle && !config.simular) {
    await lockClient.query(`
      UPDATE public.ciclos_consulta_nacionalidade
         SET status = 'interrompido',
             finalizado_em = now(),
             observacao = coalesce(observacao, 'Execucao anterior encerrada sem finalizacao')
       WHERE status = 'em_andamento'
    `);
    const cycle = await lockClient.query(`
      INSERT INTO public.ciclos_consulta_nacionalidade (
        status, tipo, codigos_selecionados, registros_selecionados
      ) VALUES ('em_andamento', $1, $2, $3)
      RETURNING id
    `, [cycleType, entries.length, entries.reduce((total, entry) => total + entry.records.length, 0)]);
    cycleId = cycle.rows[0].id;
  }

  return {
    rowCount: entries.length + 1,
    getCodigo(rowNumber) {
      return entries[rowNumber - 2]?.codigo ?? "";
    },
    describeRow(rowNumber) {
      const entry = entries[rowNumber - 2];
      return entry ? `${entry.records.length} registro(s), codigo ${maskCode(entry.codigo)}` : "sem registro";
    },
    cycleStatus: cycleDue ? "devido" : (admissionRun ? "admissao" : "aguardando"),
    cycleType,
    nextCycleAt,
    async updateRow(rowNumber, result, observacao) {
      const entry = entries[rowNumber - 2];
      if (!entry) throw new Error(`Item PostgreSQL ${rowNumber} nao encontrado.`);

      const parsedPosition = parsePhasePosition(result?.position);
      const position = parsedPosition.position ?? null;
      const total = Number(result?.totalPhases) || parsedPosition.total || null;
      const titles = String(result?.notificationTitles ?? "")
        .split(" | ").map((title) => title.trim()).filter(Boolean);
      const hasNotification = result
        ? String(result.hasNotification).toUpperCase() === "SIM"
        : null;
      const consultedAt = result?.consultedAt ?? new Date().toISOString();
      const processFinished = Boolean(result) && isFinalProcess(result.status, position, total);
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        for (const record of entry.records) {
          await client.query(`
            INSERT INTO public.historico_consultas_nacionalidade (
              nacionalidade_id, codigo_consulta, sucesso, fase, posicao_fase,
              total_fases, data_fase, possui_notificacao, titulos_notificacoes,
              observacao, consultado_em, ciclo_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          `, [
            record.id, entry.codigo, Boolean(result), result?.status ?? null,
            position, total, parsePortalDate(result?.phaseDate), hasNotification,
            titles, observacao, consultedAt, cycleId
          ]);

          if (result) {
            await client.query(`
              UPDATE public.nacionalidade_portuguesa
                 SET fase_consulta_automatica = $2,
                     posicao_fase = $3,
                     total_fases = $4,
                     data_fase = $5,
                     possui_notificacao = $6,
                     titulos_notificacoes = $7,
                     data_ultima_consulta = $8,
                     observacao_consulta = $9,
                     data_ultima_tentativa = $8,
                     status_ultima_tentativa = 'sucesso',
                     erro_ultima_tentativa = NULL,
                     processo_finalizado = $10,
                     processo_finalizado_em = CASE
                       WHEN $10 THEN coalesce(processo_finalizado_em, $8::timestamptz)
                       ELSE processo_finalizado_em
                     END,
                     motivo_finalizacao = CASE
                       WHEN $10 THEN coalesce($11, 'portal:' || $2)
                       ELSE motivo_finalizacao
                     END,
                     atualizado_em = now()
               WHERE id = $1
            `, [record.id, result.status, position, total, parsePortalDate(result.phaseDate),
              hasNotification, titles, consultedAt, observacao, processFinished,
              result.finalizationReason ?? null]);
          } else {
            await client.query(`
              UPDATE public.nacionalidade_portuguesa
                 SET data_ultima_tentativa = $2,
                     status_ultima_tentativa = 'erro',
                     erro_ultima_tentativa = $3,
                     atualizado_em = now()
               WHERE id = $1
            `, [record.id, consultedAt, observacao]);
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async finalize(summary) {
      if (!cycleId || cycleFinalized) return;
      const status = summary.erros > 0 ? "concluido_com_erros" : "concluido";
      // A admissao preserva o vencimento do ciclo completo em andamento.
      const nextRunAt = cycleType === "completo" ? null : nextCycleAt;
      await lockClient.query(`
        UPDATE public.ciclos_consulta_nacionalidade
           SET status = $2,
               finalizado_em = now(),
               proxima_execucao_em = coalesce($9::timestamptz, now() + ($3 * interval '1 day')),
               sucessos = $4,
               erros = $5,
               ignorados = $6,
               detalhes_erros = $7::jsonb,
               observacao = $8
         WHERE id = $1
      `, [
        cycleId, status, cycleDays, summary.sucessos, summary.erros,
        summary.ignorados, JSON.stringify(summary.erros_por_tipo),
        cycleType === "admissao"
          ? (summary.erros > 0
            ? "Consulta de admissao finalizada com erros individuais"
            : "Consulta de admissao finalizada com sucesso")
          : (summary.erros > 0
            ? "Ciclo finalizado com erros individuais"
            : "Ciclo finalizado com sucesso"),
        nextRunAt
      ]);
      cycleFinalized = true;
    },
    async auditReport() {
      if (!cycleId) return null;
      const cycle = await pool.query(`
        SELECT id, status, iniciado_em, finalizado_em, proxima_execucao_em,
               codigos_selecionados, registros_selecionados, sucessos, erros,
               ignorados, detalhes_erros, observacao
          FROM public.ciclos_consulta_nacionalidade
         WHERE id=$1
      `, [cycleId]);
      const details = await pool.query(`
        SELECT h.nacionalidade_id AS id, n.cliente, h.sucesso, h.fase,
               h.posicao_fase, h.total_fases, h.data_fase,
               h.possui_notificacao, h.titulos_notificacoes,
               n.processo_finalizado, h.observacao, h.consultado_em
          FROM public.historico_consultas_nacionalidade h
          JOIN public.nacionalidade_portuguesa n ON n.id=h.nacionalidade_id
         WHERE h.ciclo_id=$1
         ORDER BY h.id
      `, [cycleId]);
      const phases = {};
      for (const detail of details.rows) {
        const phase = detail.fase || (detail.sucesso ? "sem_fase" : "erro");
        phases[phase] = (phases[phase] ?? 0) + 1;
      }
      return {
        tipo: cycleType === "admissao" ? "consulta_admissao" : "ciclo_consulta",
        ciclo: cycle.rows[0] ?? null,
        fases: phases,
        finalizados_neste_resultado: details.rows.filter(
          (detail) => detail.sucesso && detail.processo_finalizado
        ).length,
        detalhes: details.rows
      };
    },
    async close() {
      if (cycleId && !cycleFinalized) {
        await lockClient.query(`
          UPDATE public.ciclos_consulta_nacionalidade
             SET status = 'interrompido', finalizado_em = now(),
                 observacao = 'Worker encerrado antes da finalizacao do ciclo'
           WHERE id = $1 AND status = 'em_andamento'
        `, [cycleId]).catch(() => {});
      }
      await lockClient.query("SELECT pg_advisory_unlock(hashtext('vne_consulta_nacionalidade'))").catch(() => {});
      lockClient.release();
      await pool.end();
    },
    finishMessage: cycleDue
      ? `${entries.length} codigo(s) processado(s) no PostgreSQL`
      : (admissionRun
        ? `Admissao: ${entries.length} cadastro(s) novo(s) processado(s). `
          + `Ciclo completo permanece previsto para ${new Date(nextCycleAt).toISOString()}`
        : `Ciclo ainda nao vencido. Proxima execucao: ${new Date(nextCycleAt).toISOString()}`)
  };
}

async function openSpreadsheet(config) {
  if (config.storage === "postgres") {
    return openPostgresStorage(config);
  }
  if (config.storage === "google_sheets") {
    return openGoogleSheetsSpreadsheet(config);
  }
  if (config.storage === "local_excel") {
    return openLocalExcelSpreadsheet(config);
  }
  throw new Error("storage invalido no config.json. Use 'postgres', 'local_excel' ou 'google_sheets'.");
}

async function firstVisible(page, selectors, timeout = 15000) {
  try {
    return await Promise.any(selectors.map(async (selector) => {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout });
      return locator;
    }));
  } catch {
    return null;
  }
}

export async function fillCode(page, codigo) {
  const field = await firstVisible(page, [
    "input[name*='codigo' i]",
    "input[id*='codigo' i]",
    "input[placeholder*='codigo' i]",
    "input[aria-label*='codigo' i]",
    "input[type='text']"
  ]);
  if (!field) {
    const title = await page.title().catch(() => "");
    throw new Error(
      `Campo do código de consulta não encontrado na página. `
      + `URL=${page.url()} | título=${title || "não informado"}`
    );
  }
  await field.fill(codigo);
}

export async function clickConsultar(page) {
  const button = await firstVisible(page, [
    "button:has-text('Consultar')",
    "input[type='submit'][value*='Consultar' i]",
    "button[type='submit']",
    "input[type='submit']",
    "text=Consultar",
    "text=Pesquisar"
  ]);
  if (!button) throw new Error("Botão de consulta não encontrado na página.");
  await button.click({ noWaitAfter: true });
}

async function waitForManualCaptcha(page, rl) {
  console.log("\nResolva o CAPTCHA no navegador aberto.");
  console.log("Depois clique no botão de consulta, se necessário, e pressione ENTER aqui para continuar.");
  await rl.question("");
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
}

// ─── Extração do status via wizard ───────────────────────────────────────────

// O wizard do portal usa "past" para as etapas ja vencidas, "active" para a
// etapa em curso e "next" para as pendentes. Um pedido em analise, porem,
// chega sem nenhuma etapa "active": apenas "Submetido" aparece como "past".
// Ler a ultima etapa "past" como fase atual congelava esses processos em
// "Submetido" — um pedido submetido em 14-04-2025 continuava reportado na
// fase 1, e a posicao 2 nunca era alcancada. Quando o portal marca a etapa em
// curso ela vale; sem essa marcacao, a fase corrente e a primeira etapa ainda
// pendente depois da ultima vencida.
export function selectCurrentPhase(steps) {
  const usable = (steps ?? []).filter((step) => step.label);
  if (!usable.length) return null;

  // Quando o portal marca a etapa em curso, ela e a resposta.
  const explicit = usable.find((step) => step.current);
  if (explicit) return explicit;

  let lastPastIndex = -1;
  usable.forEach((step, index) => { if (step.past) lastPastIndex = index; });

  const pending = usable[lastPastIndex + 1];
  if (!pending) return usable[usable.length - 1];

  // A etapa pendente nao traz data propria: o processo entrou nela quando a
  // etapa anterior foi vencida.
  return {
    ...pending,
    date: pending.date || usable[lastPastIndex]?.date || ""
  };
}

export async function extractProcessData(page) {
  try {
    await page.waitForFunction(() => {
      if (document.querySelector(".wizard-wrapper-item")) return true;
      const normalized = String(document.body?.innerText ?? "")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/\s+/g, " ")
        .toLowerCase();
      return normalized.includes(
        "nao corresponde a nenhum processo de nacionalidade ativo"
      );
    }, null, {
      timeout: 45000
    });
  } catch {
    throw new Error("Resultado carregou sem apresentar as fases do processo.");
  }
  await page.waitForTimeout(500);

  const pageText = await page.locator("body").innerText().catch(() => "");
  if (isInactiveProcessMessage(pageText)) {
    console.log("  [status] Processo encerrado: senha sem processo de nacionalidade ativo.");
    return {
      status: "Encerrado",
      position: "",
      totalPhases: null,
      phaseDate: "",
      hasNotification: "NÃO",
      notificationTitles: "",
      finalizationReason: "portal_senha_nao_corresponde_processo_ativo",
      observation: "Portal informou que a senha não corresponde a processo de nacionalidade ativo.",
      consultedAt: new Date().toISOString()
    };
  }

  const raw = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".wizard-wrapper-item")];
    if (!items.length) return null;

    const steps = items.map((item, index) => {
      const labelEl = item.querySelector(".bold");
      const label = labelEl?.innerText?.trim().replace(/\s+/g, " ") ?? "";

      let date = "";
      item.querySelectorAll(".wizard-item-label [data-expression]").forEach((span) => {
        const txt = span.innerText?.trim();
        if (txt && /\d{2}-\d{2}-\d{4}/.test(txt)) date = txt;
      });

      return {
        position: index + 1,
        label,
        date,
        past: item.classList.contains("past"),
        current:
          item.classList.contains("active") ||
          item.classList.contains("current") ||
          item.getAttribute("aria-current") === "step" ||
          Boolean(item.querySelector("[aria-current='step']"))
      };
    });

    const notificationsContainer =
      document.querySelector("[id$='-Notificacoes']") ??
      document.querySelector("[id*='Notificacoes']");
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const notificationTitles = [...new Set(
      [...(notificationsContainer?.querySelectorAll(".header-tab-message-title") ?? [])]
        .map((element) => normalize(element.textContent))
        .filter(Boolean)
    )];

    return { steps, totalPhases: items.length, notificationTitles };
  });

  const step = raw ? selectCurrentPhase(raw.steps) : null;
  const result = step ? {
    status: step.label,
    position: step.position,
    totalPhases: raw.totalPhases,
    phaseDate: step.date,
    hasNotification: raw.notificationTitles.length > 0 ? "SIM" : "NÃO",
    notificationTitles: raw.notificationTitles.join(" | ")
  } : null;

  if (result) {
    const positionText = `${result.position} de ${result.totalPhases}`;
    console.log(`  [status] Extraído: ${result.status} (${positionText})`);
    console.log(
      `  [notificações] ${result.hasNotification}` +
      (result.notificationTitles ? ` - ${result.notificationTitles}` : "")
    );
    return {
      ...result,
      position: positionText,
      consultedAt: new Date().toISOString()
    };
  }

  throw new Error("Não foi possível identificar as fases na resposta da página.");
}

// ─── Fluxo principal ──────────────────────────────────────────────────────────

async function consultarStatus(page, codigo, config, rl) {
  await page.goto(config.url_consulta, {
    waitUntil: "domcontentloaded",
    timeout:   config.timeout_ms
  });

  await fillCode(page, codigo);
  await handleCaptcha(page, config, rl);

  if (config.use_capsolver || config.use_2captcha) {
    await clickConsultar(page);
  }

  return extractProcessData(page);
}

async function consultarComTentativas(browser, codigo, config, rl) {
  const maxAttempts = Number(config.consulta_max_tentativas) || 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const page = await browser.newPage();
    try {
      return await withTimeout(
        consultarStatus(page, codigo, config, rl),
        Number(config.consulta_timeout_total_ms) || 240000,
        "Tempo total da consulta excedido",
        () => page.close({ runBeforeUnload: false })
      );
    } catch (error) {
      lastError = error;
      const classified = classifyError(error);
      const retryable = isRetryableConsultationError(classified.type);
      if (!retryable || attempt === maxAttempts) throw error;
      if (classified.type === "captcha") {
        const delayMs = Math.max(Number(config.captcha_nova_pagina_delay_ms) || 5000, 0);
        console.warn(
          `  [retry] captcha; descartando o desafio atual e aguardando ` +
          `${Math.round(delayMs / 1000)}s antes de abrir uma nova pagina ` +
          `(${attempt + 1}/${maxAttempts}).`
        );
        await page.close({ runBeforeUnload: false }).catch(() => {});
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        continue;
      }
      console.warn(`  [retry] ${classified.type}; nova pagina (${attempt + 1}/${maxAttempts}).`);
    } finally {
      await page.close({ runBeforeUnload: false }).catch(() => {});
    }
  }
  throw lastError;
}

async function main() {
  const config = loadConfig();

  if (config.use_capsolver && !CAPSOLVER_API_KEY) {
    console.warn(
      "[aviso] use_capsolver está ativado mas CAPSOLVER_API_KEY não foi definida no .env.\n" +
      "        O CapSolver será ignorado e o 2Captcha será usado diretamente (se configurado)."
    );
  }
  if (config.use_2captcha && !TWOCAPTCHA_API_KEY) {
    console.warn(
      "[aviso] use_2captcha está ativado mas TWOCAPTCHA_API_KEY não foi definida no .env.\n" +
      "        O 2Captcha será ignorado como fallback."
    );
  }
  if (!config.use_capsolver && !config.use_2captcha) {
    console.log("[info] Nenhum solver automático configurado — modo de resolução manual ativado.");
  }

  const spreadsheet = await openSpreadsheet(config);

  if (config.storage === "postgres" && spreadsheet.rowCount <= 1) {
    const emptySummary = { selecionados: 0, sucessos: 0, erros: 0, ignorados: 0, erros_por_tipo: {} };
    await spreadsheet.finalize?.(emptySummary);
    console.log(spreadsheet.finishMessage);
    try {
      const audit = await spreadsheet.auditReport?.();
      if (audit) {
        console.log("\n========== RELATORIO_AUDITORIA_CICLO_CONSULTA ==========");
        console.log(JSON.stringify(audit, null, 2));
      }
    } catch (error) {
      console.warn(`[auditoria] Não foi possível gerar o relatório do ciclo: ${error.message}`);
    }
    await spreadsheet.close?.();
    return;
  }

  if (config.storage === "postgres" && config.simular) {
    console.log(`[simulacao] ${Math.max(spreadsheet.rowCount - 1, 0)} codigo(s) selecionado(s).`);
    for (let rowNumber = 2; rowNumber <= spreadsheet.rowCount; rowNumber++) {
      const description = spreadsheet.describeRow?.(rowNumber) ?? maskCode(spreadsheet.getCodigo(rowNumber));
      console.log(`[simulacao] ${description}`);
    }
    await spreadsheet.close?.();
    console.log("[simulacao] Nenhum portal acessado e nenhum dado alterado.");
    return;
  }

const summary = {
    selecionados: Math.max(spreadsheet.rowCount - 1, 0),
    sucessos: 0,
    erros: 0,
    ignorados: 0,
    erros_por_tipo: {}
  };
  const intervalMs = Number(config.intervalo_entre_consultas_ms);
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 300000) {
    throw new Error("intervalo_entre_consultas_ms deve ser um inteiro entre 0 e 300000.");
  }
  const rl      = readline.createInterface({ input, output });
  const browser = await chromium.launch({ headless: Boolean(config.headless) });

  try {
    for (let rowNumber = 2; rowNumber <= spreadsheet.rowCount; rowNumber++) {
      const codigo = spreadsheet.getCodigo(rowNumber);

      if (!codigo) {
        await spreadsheet.updateRow(rowNumber, null, "Sem codigo de consulta");
        console.log(`Linha ${rowNumber}: sem código de consulta.`);
        summary.ignorados++;
        continue;
      }

      console.log(`\nItem ${rowNumber - 1}: consultando codigo ${maskCode(codigo)}...`);
      try {
        const result = await consultarComTentativas(browser, codigo, config, rl);
        await spreadsheet.updateRow(
          rowNumber,
          result,
          result.observation ?? "Consulta realizada"
        );
        console.log(`Linha ${rowNumber}: ${result.status} (${result.position})`);
        summary.sucessos++;
      } catch (error) {
        const classified = classifyError(error);
        const observation = `Erro [${classified.type}]: ${classified.message}`;
        await spreadsheet.updateRow(rowNumber, null, observation);
        console.error(`Item ${rowNumber - 1}: ${observation}`);
        summary.erros++;
        summary.erros_por_tipo[classified.type] = (summary.erros_por_tipo[classified.type] ?? 0) + 1;
      }

      if (rowNumber < spreadsheet.rowCount && intervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  } finally {
    await browser.close();
    rl.close();
    await spreadsheet.finalize?.(summary);
    try {
      const audit = await spreadsheet.auditReport?.();
      if (audit) {
        console.log("\n========== RELATORIO_AUDITORIA_CICLO_CONSULTA ==========");
        console.log(JSON.stringify(audit, null, 2));
      }
    } catch (error) {
      console.warn(`[auditoria] Não foi possível gerar o relatório do ciclo: ${error.message}`);
    }
    await spreadsheet.close?.();
  }

  console.log(`\n${spreadsheet.finishMessage}`);
  console.log("\nResumo da execucao:");
  console.log(`  Selecionados: ${summary.selecionados}`);
  console.log(`  Sucessos: ${summary.sucessos}`);
  console.log(`  Erros: ${summary.erros}`);
  console.log(`  Ignorados: ${summary.ignorados}`);
  for (const [type, total] of Object.entries(summary.erros_por_tipo)) {
    console.log(`  Erros de ${type}: ${total}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
