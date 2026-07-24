import assert from "node:assert/strict";

process.env.TZ = "America/Sao_Paulo";
const {
  isSalesbotBusinessHours,
  nextSalesbotBusinessTime
} = await import("./lib/janela_salesbot.js");

function localDate(value) {
  return new Date(`${value}-03:00`);
}

assert.equal(isSalesbotBusinessHours(localDate("2026-07-24T08:59:59")), false);
assert.equal(isSalesbotBusinessHours(localDate("2026-07-24T09:00:00")), true);
assert.equal(isSalesbotBusinessHours(localDate("2026-07-24T17:59:59")), true);
assert.equal(isSalesbotBusinessHours(localDate("2026-07-24T18:00:00")), false);
assert.equal(isSalesbotBusinessHours(localDate("2026-07-25T12:00:00")), false);

assert.equal(
  nextSalesbotBusinessTime(localDate("2026-07-24T08:30:00")).toISOString(),
  "2026-07-24T12:00:00.000Z"
);
assert.equal(
  nextSalesbotBusinessTime(localDate("2026-07-24T18:00:00")).toISOString(),
  "2026-07-27T12:00:00.000Z"
);
assert.equal(
  nextSalesbotBusinessTime(localDate("2026-07-25T12:00:00")).toISOString(),
  "2026-07-27T12:00:00.000Z"
);

console.log("Janela de Salesbot validada: seg-sex, 09:00-18:00.");
