# Mapa inicial do PostgreSQL

Mapeamento realizado em 16/07/2026, usando transação `READ ONLY` e sem leitura de dados pessoais.

## Conexão

- PostgreSQL 17.10;
- banco configurado pela variável `DATABASE_URL`;
- schema de aplicação: `public`;
- o mesmo banco contém tabelas internas do n8n e tabelas de outras automações;
- tabela relevante para este sistema: `public.nacionalidade_portuguesa`.

## Tabela `public.nacionalidade_portuguesa`

- 759 registros;
- chave primária: `id` (`bigint`);
- identificador externo único: `id_registro`;
- nenhuma chave estrangeira;
- 526 registros com `codigo_consulta`;
- 458 códigos de consulta distintos;
- 233 registros sem código de consulta;
- 67 grupos de códigos duplicados.

| Coluna | Tipo | Nulo | Registros preenchidos |
|---|---|---:|---:|
| `id` | bigint | não | 759 |
| `id_registro` | varchar | não | 759 |
| `cliente` | varchar | sim | 759 |
| `esta_no_kommo` | varchar | sim | 120 |
| `numero_processo` | varchar | sim | 306 |
| `codigo_consulta` | varchar | sim | 526 |
| `data_entrada` | date | sim | 85 |
| `parceria` | varchar | sim | 110 |
| `status` | varchar | sim | 187 |
| `conservatoria` | varchar | sim | 200 |
| `aprovado` | date | sim | 34 |
| `prazo` | varchar | sim | 2 |
| `data_submissao` | date | sim | 94 |
| `anotacoes` | text | sim | 70 |
| `contato` | varchar | sim | 82 |
| `email` | varchar | sim | 16 |
| `google_drive` | text | sim | 54 |
| `criado_em` | timestamptz | não | 759 |
| `atualizado_em` | timestamptz | não | 759 |

## Índices

- chave primária em `id`;
- índice único em `id_registro`;
- índices simples em `cliente`, `codigo_consulta`, `numero_processo` e `status`.

## Correspondência com o fluxo atual

| Fluxo atual | PostgreSQL |
|---|---|
| linha da planilha | registro identificado por `id` |
| `CÓDIGO DE CONSULTA` | `codigo_consulta` |
| `STATUS` manual | `status` (preservar) |
| `ANOTAÇÕES` manuais | `anotacoes` (preservar) |
| resultados automáticos | ainda não existem no banco |

Os oito resultados produzidos pelo robô não devem ser gravados em `status` ou `anotacoes`, pois esses campos já representam informações manuais.

## Próxima alteração recomendada

Migração aplicada em 16/07/2026. Foram adicionados campos próprios para o resultado mais recente da automação:

- `fase_consulta_automatica` (`text`);
- `posicao_fase` (`integer`);
- `total_fases` (`integer`);
- `data_fase` (`date`);
- `possui_notificacao` (`boolean`);
- `titulos_notificacoes` (`text[]` ou `text`);
- `data_ultima_consulta` (`timestamptz`);
- `observacao_consulta` (`text`).

Também foi criada `public.historico_consultas_nacionalidade` para registrar cada tentativa sem perder resultados anteriores. A camada PostgreSQL busca registros com código, processa cada código distinto uma vez e, fora do modo de teste, atualiza todos os registros que compartilham o mesmo código.

## Modo de teste PostgreSQL

Para uma simulação sem navegador e sem gravação, configurar:

```json
"storage": "postgres",
"modo_teste": true,
"id_registro_teste": "ID_REGISTRO_ESCOLHIDO",
"limite_por_execucao": 1,
"simular": true
```

No modo de teste, somente o registro indicado por `id_registro_teste` é atualizado, mesmo que seu código apareça em outros cadastros. Depois de conferir a seleção mascarada no terminal, alterar `simular` para `false` executa uma consulta real desse único registro.

Para operação em lote, `modo_teste` deve ser alterado explicitamente para `false`. O limite permanece obrigatório e aceita de 1 a 1000 códigos por execução.

## Proteções operacionais implementadas

- trava PostgreSQL por `pg_try_advisory_lock`, impedindo duas execuções simultâneas;
- limite obrigatório entre 1 e 100 códigos;
- intervalo configurável entre consultas, com padrão de 5 segundos;
- processamento padrão somente de registros ainda sem resultado válido;
- reconsulta opcional após uma quantidade configurável de dias;
- códigos mascarados nos logs;
- erros classificados como `captcha`, `navegacao`, `extracao`, `codigo` ou `inesperado`;
- resumo final com selecionados, sucessos, erros e ignorados;
- falhas gravadas no histórico sem apagar a última fase válida.

Configuração operacional inicial:

```json
"intervalo_entre_consultas_ms": 5000,
"reconsultar_processados": false,
"reconsulta_apos_dias": 7
```

Quando `reconsultar_processados` for `true`, registros com sucesso voltam a ser elegíveis depois de `reconsulta_apos_dias`.

Em 16/07/2026 foi validada uma simulação de lote com três códigos distintos, sem acesso ao portal e sem gravação.

## Próxima etapa: EasyPanel

O sistema é um worker que executa um lote e termina. Portanto, não deve ser publicado inicialmente como serviço com reinicialização automática contínua. A preparação recomendada é:

1. imagem Docker baseada na versão 1.61.0 do Playwright;
2. execução headless;
3. segredos `DATABASE_URL` e `TWOCAPTCHA_API_KEY` apenas no EasyPanel;
4. agendamento controlado por cron;
5. uma única réplica;
6. lote inicial pequeno;
7. logs habilitados e trava PostgreSQL mantida.

## Utilitários adicionados

- `scripts/mapear_banco.js`: inventário geral de schemas, relações, colunas, restrições e índices;
- `scripts/inspecionar_nacionalidade.js`: inspeção estrutural e métricas agregadas da tabela alvo.

Ambos iniciam transação somente de leitura e podem ser executados novamente após mudanças no banco.
