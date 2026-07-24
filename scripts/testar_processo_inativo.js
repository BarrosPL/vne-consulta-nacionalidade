import assert from "node:assert/strict";
import {
  extractProcessData,
  isInactiveProcessMessage,
  isRetryableConsultationError
} from "../consulta_status.js";

const message = `
  A senha 7701-3959-2172 não corresponde a nenhum processo de nacionalidade ativo.
  Verifique que digitou a sua senha corretamente.
  Caso não encontre o seu processo dirija-se à conservatória onde entregou o seu pedido.
`;

assert.equal(isInactiveProcessMessage(message), true);
assert.equal(
  isInactiveProcessMessage("A senha está correta e o processo está ativo."),
  false
);
assert.equal(isRetryableConsultationError("codigo"), true);
assert.equal(isRetryableConsultationError("extracao"), true);
assert.equal(isRetryableConsultationError("captcha"), true);

const fakePage = {
  waitForFunction: async () => {},
  waitForTimeout: async () => {},
  locator: () => ({
    innerText: async () => message
  })
};

const result = await extractProcessData(fakePage);
assert.equal(result.status, "Encerrado");
assert.equal(result.finalizationReason, "portal_senha_nao_corresponde_processo_ativo");
assert.equal(result.hasNotification, "NÃO");

console.log("Mensagem de processo inativo reconhecida como encerramento.");
