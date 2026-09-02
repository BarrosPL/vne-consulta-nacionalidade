import assert from "node:assert/strict";
import { selectCurrentPhase } from "../consulta_status.js";

// Estrutura observada no portal: "past" marca as etapas ja vencidas, "active"
// marca a etapa em curso e "next" as pendentes. Um processo em analise, porem,
// chega sem nenhuma etapa "active": so a primeira aparece como "past".
const etapa = (position, label, { past = false, date = "", current = false } = {}) =>
  ({ position, label, date, past, current });

// Caso real: senha 2116-5171-7133, submetida em 14-04-2025 e em analise.
const submetido = [
  etapa(1, "Submetido", { past: true, date: "14-04-2025" }),
  etapa(2, "Em análise"),
  etapa(3, "Para decisão"),
  etapa(4, "Concluído")
];
const emAnalise = selectCurrentPhase(submetido);
assert.equal(emAnalise.label, "Em análise");
assert.equal(emAnalise.position, 2);
// A fase corrente herda a data da etapa concluida anterior.
assert.equal(emAnalise.date, "14-04-2025");

// Nenhuma etapa concluida: o processo esta na primeira.
const semConcluidas = selectCurrentPhase([
  etapa(1, "Submetido"),
  etapa(2, "Em análise")
]);
assert.equal(semConcluidas.position, 1);
assert.equal(semConcluidas.label, "Submetido");

// Caso real: senha 5097-3799-7227, com todas as etapas vencidas. O processo
// esta na ultima etapa e isFinalProcess o fecha.
const tudoConcluido = selectCurrentPhase([
  etapa(1, "Submetido", { past: true, date: "15-11-2024" }),
  etapa(2, "Em análise", { past: true, date: "27-11-2025" }),
  etapa(3, "Para decisão", { past: true, date: "12-05-2026" }),
  etapa(4, "Concluído", { past: true, date: "12-05-2026" })
]);
assert.equal(tudoConcluido.position, 4);
assert.equal(tudoConcluido.label, "Concluído");
assert.equal(tudoConcluido.date, "12-05-2026");

// Caso real: senha 2626-9877-7324, com a etapa em curso marcada pelo portal.
// A etapa "active" tem prioridade e mantem a propria data.
const comAtiva = selectCurrentPhase([
  etapa(1, "Submetido", { past: true, date: "17-07-2024" }),
  etapa(2, "Em análise", { past: true, date: "18-07-2024" }),
  etapa(3, "Para decisão", { current: true, date: "28-09-2024" }),
  etapa(4, "Concluído")
]);
assert.equal(comAtiva.position, 3);
assert.equal(comAtiva.label, "Para decisão");
assert.equal(comAtiva.date, "28-09-2024");

// Caso real: senha 3006-6577-2129, no fluxo de 5 etapas com exigencia. O
// portal marca duas etapas como "active" ao mesmo tempo; vale a primeira.
const duasAtivas = selectCurrentPhase([
  etapa(1, "Submetido", { past: true, date: "01-06-2021" }),
  etapa(2, "Em análise", { past: true, date: "29-09-2024" }),
  etapa(3, "Aguarda resposta", { current: true, date: "06-02-2025" }),
  etapa(4, "Para decisão", { current: true, date: "06-02-2025" }),
  etapa(5, "Concluído")
]);
assert.equal(duasAtivas.position, 3);
assert.equal(duasAtivas.label, "Aguarda resposta");

// Etapas sem rotulo nao entram na decisao.
const comVazias = selectCurrentPhase([
  etapa(1, "", { past: true }),
  etapa(2, "Submetido", { past: true, date: "14-04-2025" }),
  etapa(3, "Em análise")
]);
assert.equal(comVazias.label, "Em análise");

assert.equal(selectCurrentPhase([]), null);
assert.equal(selectCurrentPhase(null), null);

console.log("Regra de fase do wizard validada.");
