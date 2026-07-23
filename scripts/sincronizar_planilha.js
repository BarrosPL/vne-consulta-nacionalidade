import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { google } from "googleapis";

const APPLY = process.argv.includes("--aplicar");
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID
  ?? "10YNu_c-TGiSpb2QwfWDdQgQYuvXYXqwreCmxRETamFs";
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME ?? "Andamentos";
const CREDENTIALS_FILE = process.env.GOOGLE_CREDENTIALS_FILE
  ?? "google-service-account.json";
const ID_HEADER = "ID REGISTRO SISTEMA";

const sourceColumns = {
  cliente: "CLIENTE",
  esta_no_kommo: "ESTÁ NO KOMMO?",
  numero_processo: "Nº PROCESSO",
  codigo_consulta: "CÓDIGO DE CONSULTA",
  data_entrada: "DATA DE ENTRADA",
  parceria: "PARCERIA",
  status: "STATUS",
  conservatoria: "CONSERVATÓRIA",
  aprovado: "APROVADO",
  prazo: "PRAZO",
  data_submissao: "DATA DE SUBMISSÃO",
  anotacoes: "ANOTAÇÕES",
  contato: "CONTATO",
  email: "E-MAIL",
  google_drive: "GOOGLE DRIVE"
};

function text(value) {
  return String(value ?? "").trim();
}

function normalizeHeader(value) {
  return text(value).normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase();
}

function parseDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!br) return null;
  const [, day, month, year] = br;
  const candidate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : candidate;
}

function columnLetter(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function legacyId(row) {
  return `${row.codigo_consulta}|${row.numero_processo}|${row.cliente}`;
}

function normalizedText(value) {
  return text(value).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function isManualFinalStatus(value) {
  return ["terminado", "concluido", "encerrado", "finalizado"].includes(normalizedText(value));
}

function addCandidate(map, key, row) {
  if (!key) return;
  const candidates = map.get(key) ?? [];
  candidates.push(row);
  map.set(key, candidates);
}

async function openSheet() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : JSON.parse(await fs.readFile(path.resolve(CREDENTIALS_FILE), "utf8"));
  const scope = APPLY
    ? "https://www.googleapis.com/auth/spreadsheets"
    : "https://www.googleapis.com/auth/spreadsheets.readonly";
  const auth = new google.auth.GoogleAuth({ credentials, scopes: [scope] });
  const sheets = google.sheets({ version: "v4", auth });
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "properties.title,sheets.properties"
  });
  const target = metadata.data.sheets?.find((sheet) => sheet.properties?.title === SHEET_NAME);
  if (!target) throw new Error(`Aba ${SHEET_NAME} não encontrada.`);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME.replaceAll("'", "''")}'`
  });
  return {
    sheets,
    title: metadata.data.properties?.title,
    rows: response.data.values ?? []
  };
}

function mapRows(values) {
  if (!values.length) throw new Error("A planilha não retornou cabeçalho.");
  const headers = values[0].map(normalizeHeader);
  const indexes = {};
  for (const [field, header] of Object.entries(sourceColumns)) {
    indexes[field] = headers.indexOf(normalizeHeader(header));
    if (indexes[field] < 0) throw new Error(`Coluna obrigatória ausente: ${header}`);
  }
  const idIndex = headers.indexOf(normalizeHeader(ID_HEADER));
  const rows = [];
  for (let index = 1; index < values.length; index++) {
    const source = values[index] ?? [];
    const cliente = text(source[indexes.cliente]);
    if (!cliente) continue;
    const row = { sheetRow: index + 1, sheetId: idIndex >= 0 ? text(source[idIndex]) : "" };
    for (const [field, columnIndex] of Object.entries(indexes)) row[field] = text(source[columnIndex]);
    row.data_entrada = parseDate(row.data_entrada);
    row.aprovado = parseDate(row.aprovado);
    row.data_submissao = parseDate(row.data_submissao);
    rows.push(row);
  }
  return { rows, idIndex, headerCount: values[0].length };
}

async function loadDatabase(pool) {
  const columns = await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'nacionalidade_portuguesa'
  `);
  const names = new Set(columns.rows.map((row) => row.column_name));
  const migrationReady = [
    "id_planilha", "ativo_na_planilha", "processo_finalizado",
    "registro_duplicado", "registro_principal_id"
  ].every((name) => names.has(name));
  const records = await pool.query(`
    SELECT id, id_registro, cliente, numero_processo, codigo_consulta,
           ${migrationReady ? "id_planilha::text" : "NULL::text AS id_planilha"},
           ${migrationReady ? "ativo_na_planilha" : "true AS ativo_na_planilha"}
      FROM public.nacionalidade_portuguesa
     ORDER BY id
  `);
  return { migrationReady, records: records.rows };
}

function analyze(sheetRows, dbRows) {
  const byUuid = new Map(dbRows.filter((row) => row.id_planilha)
    .map((row) => [row.id_planilha, row]));
  const byLegacy = new Map(dbRows.map((row) => [row.id_registro, row]));
  const byCodeProcess = new Map();
  const byCodeClient = new Map();
  const byProcess = new Map();
  const byClient = new Map();
  for (const row of dbRows) {
    const code = text(row.codigo_consulta);
    const process = normalizedText(row.numero_processo);
    const client = normalizedText(row.cliente);
    addCandidate(byCodeProcess, code && process ? `${code}|${process}` : "", row);
    addCandidate(byCodeClient, code && client ? `${code}|${client}` : "", row);
    addCandidate(byProcess, process, row);
    addCandidate(byClient, client, row);
  }
  const seenDbIds = new Set();
  let matchedUuid = 0;
  let matchedLegacy = 0;
  let matchedReconciled = 0;
  let inserts = 0;
  let invalidIds = 0;
  function uniqueAvailable(map, key) {
    const available = (map.get(key) ?? []).filter((candidate) => !seenDbIds.has(candidate.id));
    return available.length === 1 ? available[0] : null;
  }
  const prepared = sheetRows.map((row) => {
    const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(row.sheetId);
    if (row.sheetId && !validUuid) invalidIds++;
    let existing = validUuid ? byUuid.get(row.sheetId) : null;
    if (existing && seenDbIds.has(existing.id)) existing = null;
    if (existing) matchedUuid++;
    if (!existing) {
      existing = byLegacy.get(legacyId(row));
      if (existing && seenDbIds.has(existing.id)) existing = null;
      if (existing) matchedLegacy++;
    }
    if (!existing) {
      const code = text(row.codigo_consulta);
      const process = normalizedText(row.numero_processo);
      const client = normalizedText(row.cliente);
      existing =
        uniqueAvailable(byCodeProcess, code && process ? `${code}|${process}` : "")
        ?? uniqueAvailable(byCodeClient, code && client ? `${code}|${client}` : "")
        ?? uniqueAvailable(byProcess, process)
        ?? uniqueAvailable(byClient, client);
      if (existing) matchedReconciled++;
    }
    if (!existing) inserts++;
    if (existing) seenDbIds.add(existing.id);
    return { ...row, uuid: validUuid ? row.sheetId : randomUUID(), existing };
  });
  const removals = dbRows.filter((row) => row.ativo_na_planilha && !seenDbIds.has(row.id)).length;
  const codes = new Map();
  for (const row of prepared) {
    const code = text(row.codigo_consulta);
    if (!code) continue;
    codes.set(code, (codes.get(code) ?? 0) + 1);
  }
  const duplicateGroups = [...codes.values()].filter((count) => count > 1).length;
  return {
    prepared,
    summary: {
      linhas_validas: prepared.length,
      encontrados_por_uuid: matchedUuid,
      encontrados_por_id_antigo: matchedLegacy,
      reconciliados_por_dados: matchedReconciled,
      novos: inserts,
      seriam_desativados: removals,
      ids_invalidos: invalidIds,
      grupos_codigo_duplicado: duplicateGroups
    }
  };
}

async function writeIds(sheet, mapped, prepared) {
  let idIndex = mapped.idIndex;
  if (idIndex < 0) {
    idIndex = mapped.headerCount;
    await sheet.sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!${columnLetter(idIndex)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [[ID_HEADER]] }
    });
  }
  const data = prepared
    .filter((row) => row.sheetId !== row.uuid)
    .map((row) => ({
      range: `'${SHEET_NAME}'!${columnLetter(idIndex)}${row.sheetRow}`,
      values: [[row.uuid]]
    }));
  if (data.length) {
    await sheet.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: "RAW", data }
    });
  }
  return data.length;
}

async function applyDatabase(pool, prepared) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('vne_consulta_nacionalidade'))");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('vne_sincronizacao_planilha'))");
    if (!prepared.length) {
      throw new Error("Sincronização bloqueada: a planilha não retornou registros válidos.");
    }
    for (const row of prepared) {
      const values = [
        row.uuid, row.cliente, row.esta_no_kommo || null, row.numero_processo || null,
        row.codigo_consulta || null, row.data_entrada, row.parceria || null, row.status || null,
        row.conservatoria || null, row.aprovado, row.prazo || null, row.data_submissao,
        row.anotacoes || null, row.contato || null, row.email || null, row.google_drive || null,
        isManualFinalStatus(row.status)
      ];
      if (row.existing) {
        await client.query(`
          UPDATE public.nacionalidade_portuguesa
             SET id_planilha=$2, cliente=$3, esta_no_kommo=$4, numero_processo=$5,
                 codigo_consulta=$6, data_entrada=$7, parceria=$8, status=$9::varchar,
                 conservatoria=$10, aprovado=$11, prazo=$12, data_submissao=$13,
                 anotacoes=$14, contato=$15, email=$16, google_drive=$17,
                 processo_finalizado=CASE
                   WHEN $18 THEN true
                   WHEN motivo_finalizacao LIKE 'status_manual:%' THEN false
                   ELSE processo_finalizado
                 END,
                 processo_finalizado_em=CASE
                   WHEN $18 THEN coalesce(processo_finalizado_em, now())
                   WHEN motivo_finalizacao LIKE 'status_manual:%' THEN NULL
                   ELSE processo_finalizado_em
                 END,
                 motivo_finalizacao=CASE
                   WHEN $18 THEN 'status_manual:' || $9::text
                   WHEN motivo_finalizacao LIKE 'status_manual:%' THEN NULL
                   ELSE motivo_finalizacao
                 END,
                 ativo_na_planilha=true, removido_da_planilha_em=NULL,
                 sincronizado_planilha_em=now(),
                 atualizado_em=CASE
                   WHEN ROW(
                     id_planilha::text, cliente, esta_no_kommo, numero_processo,
                     codigo_consulta, data_entrada, parceria, status::text,
                     conservatoria, aprovado, prazo, data_submissao, anotacoes,
                     contato, email, google_drive, ativo_na_planilha
                   ) IS DISTINCT FROM ROW(
                     $2::text, $3, $4, $5, $6, $7, $8, $9::text, $10, $11,
                     $12, $13, $14, $15, $16, $17, true
                   )
                   THEN now()
                   ELSE atualizado_em
                 END
           WHERE id=$1
        `, [row.existing.id, ...values]);
      } else {
        await client.query(`
          INSERT INTO public.nacionalidade_portuguesa (
            id_registro, id_planilha, cliente, esta_no_kommo, numero_processo,
            codigo_consulta, data_entrada, parceria, status, conservatoria, aprovado,
            prazo, data_submissao, anotacoes, contato, email, google_drive,
            processo_finalizado, processo_finalizado_em, motivo_finalizacao,
            ativo_na_planilha, sincronizado_planilha_em, atualizado_em
          ) VALUES (
            $1::varchar,$1::uuid,$2,$3,$4,$5,$6,$7,$8::varchar,$9,$10,$11,$12,$13,$14,$15,$16,
            $17,CASE WHEN $17 THEN now() END,
            CASE WHEN $17 THEN 'status_manual:' || $8::text END,
            true,now(),now()
          )
        `, values);
      }
    }
    const ids = prepared.map((row) => row.uuid);
    await client.query(`
      UPDATE public.nacionalidade_portuguesa
         SET ativo_na_planilha=false, removido_da_planilha_em=coalesce(removido_da_planilha_em, now()),
             motivo_desativacao=coalesce(motivo_desativacao, 'removido_da_planilha')
       WHERE ativo_na_planilha
         AND NOT (id_planilha = ANY($1::uuid[]))
    `, [ids]);
    await client.query(`
      WITH classificados AS (
        SELECT id,
               first_value(id) OVER (
                 PARTITION BY btrim(codigo_consulta)
                 ORDER BY ativo_na_planilha DESC,
                   registro_duplicado ASC,
                   id
               ) AS principal_id
          FROM public.nacionalidade_portuguesa
         WHERE nullif(btrim(codigo_consulta), '') IS NOT NULL
      )
      UPDATE public.nacionalidade_portuguesa n
         SET registro_duplicado=(c.principal_id <> n.id),
             registro_principal_id=CASE WHEN c.principal_id <> n.id THEN c.principal_id END,
             motivo_desativacao=CASE
               WHEN c.principal_id <> n.id THEN 'codigo_consulta_duplicado'
               WHEN n.ativo_na_planilha THEN NULL
               ELSE n.motivo_desativacao
             END
        FROM classificados c
       WHERE c.id=n.id
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL não definida.");
const sheet = await openSheet();
const mapped = mapRows(sheet.rows);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  const database = await loadDatabase(pool);
  const analysis = analyze(mapped.rows, database.records);
  console.log(JSON.stringify({
    modo: APPLY ? "aplicar" : "diagnostico",
    planilha: sheet.title,
    aba: SHEET_NAME,
    migracao_004_aplicada: database.migrationReady,
    ...analysis.summary
  }, null, 2));
  if (APPLY) {
    if (!database.migrationReady) {
      throw new Error("A migração 004 precisa ser aplicada antes da sincronização.");
    }
    const written = await writeIds(sheet, mapped, analysis.prepared);
    await applyDatabase(pool, analysis.prepared);
    console.log(`Sincronização concluída. ${written} UUID(s) gravado(s) na planilha.`);
  } else {
    console.log("Diagnóstico concluído; nenhum dado foi alterado.");
  }
} finally {
  await pool.end().catch(() => {});
}
