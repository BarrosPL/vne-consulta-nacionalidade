// Trava e mapeamento da escrita de campos personalizados no Kommo.
//
// Esta trava e INDEPENDENTE de KOMMO_INTEGRACAO_HABILITADA. Ela libera apenas
// o preenchimento de campos personalizados do lead. Movimentacao de etapa,
// nota e Salesbot continuam governados exclusivamente pela trava mestre e
// seguem desligados.
//
// A separacao existe porque os riscos sao diferentes: escrever um campo do
// lead nao gera nenhuma comunicacao com o cliente final, enquanto mover etapa
// ou disparar bot gera.

const VARIAVEL = "KOMMO_CAMPOS_HABILITADO";

export function camposKommoHabilitado() {
  return String(process.env[VARIAVEL] ?? "false").trim().toLowerCase() === "true";
}

export function avisoCamposKommoDesativado(origem) {
  return `[campos-kommo] Escrita de campos personalizados desativada. Ignorado: ${origem}. `
    + `Para habilitar somente os campos (sem etapa, nota ou Salesbot), defina ${VARIAVEL}=true.`;
}

function campoId(variavel, padrao) {
  const bruto = process.env[variavel];
  if (bruto === undefined || String(bruto).trim() === "") return padrao;
  const numero = Number(bruto);
  if (!Number.isSafeInteger(numero) || numero <= 0) {
    throw new Error(`${variavel} deve ser um ID inteiro positivo ou ficar vazio.`);
  }
  return numero;
}

// IDs conferidos em GET /api/v4/leads/custom_fields na conta vocenaeuropa.
export const CAMPOS = {
  fase: campoId("KOMMO_CAMPO_FASE_PROCESSUAL", 2990113),
  posicao: campoId("KOMMO_CAMPO_POSICAO_FASE", 2990115),
  totalFases: campoId("KOMMO_CAMPO_TOTAL_FASES", 2990117),
  dataFase: campoId("KOMMO_CAMPO_DATA_FASE", 2990119),
  ultimaConsulta: campoId("KOMMO_CAMPO_ULTIMA_CONSULTA", 2990121),
  possuiNotificacao: campoId("KOMMO_CAMPO_POSSUI_NOTIFICACAO", 2990123),
  resumoNotificacoes: campoId("KOMMO_CAMPO_RESUMO_NOTIFICACOES", 2990125),
  origem: campoId("KOMMO_CAMPO_ORIGEM_SINCRONIZACAO", 2990127),
  codigo: campoId("KOMMO_CAMPO_CODIGO_CRC", 2990129),
  numeroProcesso: campoId("KOMMO_CAMPO_NUMERO_PROCESSO", 2990131)
};

// Opcoes do campo select "Possui Notificacao".
export const ENUM_NOTIFICACAO = {
  sim: campoId("KOMMO_ENUM_NOTIFICACAO_SIM", 9258323),
  nao: campoId("KOMMO_ENUM_NOTIFICACAO_NAO", 9258325)
};

function textoLimpo(valor) {
  return String(valor ?? "").trim();
}

function segundos(valor) {
  if (!valor) return null;
  const data = valor instanceof Date ? valor : new Date(valor);
  const ms = data.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function inteiro(valor) {
  const numero = Number(valor);
  return Number.isSafeInteger(numero) ? numero : null;
}

/**
 * Monta o `custom_fields_values` de um cadastro.
 *
 * Campos sem valor conhecido sao omitidos, e nao enviados vazios, para nunca
 * apagar um dado preenchido manualmente na Kommo. A unica excecao e o resumo
 * de notificacoes, que e limpo quando a consulta afirma que nao ha nenhuma.
 */
export function montarCamposPersonalizados(registro) {
  const campos = [];
  const adicionar = (field_id, values) => {
    if (!field_id) return;
    campos.push({ field_id, values });
  };
  const adicionarTexto = (field_id, valor) => {
    const texto = textoLimpo(valor);
    if (!texto) return;
    adicionar(field_id, [{ value: texto }]);
  };
  const adicionarNumero = (field_id, valor) => {
    const numero = inteiro(valor);
    if (numero === null) return;
    adicionar(field_id, [{ value: numero }]);
  };
  const adicionarData = (field_id, valor) => {
    const ts = segundos(valor);
    if (ts === null) return;
    adicionar(field_id, [{ value: ts }]);
  };

  adicionarTexto(CAMPOS.fase, registro.fase_consulta_automatica);
  adicionarNumero(CAMPOS.posicao, registro.posicao_fase);
  adicionarNumero(CAMPOS.totalFases, registro.total_fases);
  adicionarData(CAMPOS.dataFase, registro.data_fase);
  adicionarData(CAMPOS.ultimaConsulta, registro.data_ultima_consulta);

  if (registro.possui_notificacao === true || registro.possui_notificacao === false) {
    adicionar(CAMPOS.possuiNotificacao, [{
      enum_id: registro.possui_notificacao ? ENUM_NOTIFICACAO.sim : ENUM_NOTIFICACAO.nao
    }]);
  }

  const titulos = Array.isArray(registro.titulos_notificacoes)
    ? registro.titulos_notificacoes.map(textoLimpo).filter(Boolean)
    : textoLimpo(registro.titulos_notificacoes)
      ? [textoLimpo(registro.titulos_notificacoes)]
      : [];
  if (titulos.length > 0) {
    adicionarTexto(CAMPOS.resumoNotificacoes, titulos.join(" | "));
  } else if (registro.possui_notificacao === false) {
    // A consulta afirmou que nao ha notificacao: limpa um resumo antigo.
    adicionar(CAMPOS.resumoNotificacoes, []);
  }

  // Mantem a convencao ja usada nos 261 leads preenchidos anteriormente.
  adicionarTexto(CAMPOS.origem, `vne:nacionalidade:${registro.id}`);
  adicionarTexto(CAMPOS.codigo, registro.codigo_consulta);
  adicionarTexto(CAMPOS.numeroProcesso, registro.numero_processo);

  return campos;
}

// Chaves que jamais podem sair deste modulo. Movimentacao de etapa e
// responsabilidade exclusiva do modulo travado por KOMMO_INTEGRACAO_HABILITADA.
const CHAVES_PROIBIDAS = [
  "status_id", "pipeline_id", "responsible_user_id", "loss_reason_id",
  "price", "name", "_embedded"
];

/**
 * Garante que o corpo enviado ao Kommo contem exclusivamente campos
 * personalizados. Uma regressao futura falha aqui em vez de mover um lead.
 */
export function validarCorpoSomenteCampos(corpo) {
  const chaves = Object.keys(corpo ?? {});
  const proibidas = chaves.filter((chave) => CHAVES_PROIBIDAS.includes(chave));
  if (proibidas.length > 0) {
    throw new Error(
      `Corpo do PATCH contem chaves proibidas: ${proibidas.join(", ")}. `
      + "Este modulo so pode escrever custom_fields_values."
    );
  }
  const extras = chaves.filter((chave) => chave !== "custom_fields_values");
  if (extras.length > 0) {
    throw new Error(`Corpo do PATCH contem chaves inesperadas: ${extras.join(", ")}.`);
  }
  if (!Array.isArray(corpo.custom_fields_values) || corpo.custom_fields_values.length === 0) {
    throw new Error("Corpo do PATCH sem custom_fields_values.");
  }
  return true;
}
