// Trava mestre da integração com o Kommo.
//
// Enquanto KOMMO_INTEGRACAO_HABILITADA não for exatamente "true", o sistema
// opera apenas como planilha -> consulta no portal -> PostgreSQL. Nenhuma
// movimentação de etapa, nota ou Salesbot é enviada ao Kommo.
//
// A trava fica no código, e não somente na configuração do EasyPanel, para que
// KOMMO_SINCRONIZACAO_ATIVA ou uma execução manual de `npm run kommo:aplicar`
// não consigam reativar os envios por engano.

const VARIAVEL = "KOMMO_INTEGRACAO_HABILITADA";

export function integracaoKommoHabilitada() {
  return String(process.env[VARIAVEL] ?? "false").trim().toLowerCase() === "true";
}

// A nota de status foi substituida pelos campos personalizados do lead
// (KOMMO_CAMPOS_HABILITADO). Ela fica desligada por padrao para nao duplicar a
// mesma informacao em dois lugares. Defina KOMMO_NOTA_HABILITADA=true para
// voltar a criar e atualizar a nota junto da movimentacao.
export function notaKommoHabilitada() {
  return String(process.env.KOMMO_NOTA_HABILITADA ?? "false").trim().toLowerCase() === "true";
}

export function avisoIntegracaoKommoDesativada(origem) {
  return `[kommo] Integracao desativada. Ignorado: ${origem}. `
    + "O sistema apenas consulta o portal e atualiza o PostgreSQL. "
    + `Para reativar movimentacao de etapa, nota e Salesbot, defina ${VARIAVEL}=true.`;
}
