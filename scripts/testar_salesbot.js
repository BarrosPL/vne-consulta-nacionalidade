import "dotenv/config";

const args = process.argv.slice(2);
const BOT_ID = Number(args[0]);
const LEAD_ID = Number(args[1]);
const APPLY = args.includes("--aplicar");
const BASE_URL = String(
  process.env.KOMMO_BASE_URL ?? "https://vocenaeuropa.kommo.com"
).replace(/\/$/, "");
const TOKEN = process.env.KOMMO_ACCESS_TOKEN;

if (!Number.isSafeInteger(BOT_ID) || BOT_ID <= 0) {
  throw new Error("Informe um ID de Salesbot válido como primeiro argumento.");
}
if (!Number.isSafeInteger(LEAD_ID) || LEAD_ID <= 0) {
  throw new Error("Informe um ID de lead válido como segundo argumento.");
}
if (!TOKEN) {
  throw new Error("KOMMO_ACCESS_TOKEN não definido.");
}

async function request(route, options = {}) {
  const response = await fetch(`${BASE_URL}${route}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json, application/problem+json, text/html",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const rawBody = await response.text();
  let body = rawBody;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    // O endpoint de execução pode responder text/html.
  }
  if (!response.ok) {
    const detail = typeof body === "object"
      ? body?.detail ?? body?.title ?? JSON.stringify(body)
      : body;
    throw new Error(`Kommo HTTP ${response.status}: ${detail || "falha sem detalhes"}`);
  }
  return { status: response.status, body };
}

const leadResponse = await request(`/api/v4/leads/${LEAD_ID}`);
const lead = leadResponse.body;

console.log(
  `[salesbot] Lead encontrado: id=${lead.id}, nome=${JSON.stringify(lead.name)}, `
  + `pipeline=${lead.pipeline_id}, etapa=${lead.status_id}.`
);

if (!APPLY) {
  console.log(
    `[salesbot] Diagnóstico concluído. Para acionar o bot ${BOT_ID}, repita com --aplicar.`
  );
  process.exit(0);
}

const runResponse = await request(`/api/v4/bots/${BOT_ID}/run`, {
  method: "POST",
  body: JSON.stringify({
    entity_id: LEAD_ID,
    entity_type: "leads"
  })
});

console.log(
  `[salesbot] Bot ${BOT_ID} acionado no lead ${LEAD_ID}; HTTP ${runResponse.status}.`
);
