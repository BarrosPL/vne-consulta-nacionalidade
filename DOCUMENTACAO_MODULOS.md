# Documentação dos módulos do sistema

## 1. Visão geral

O sistema automatiza o acompanhamento de processos de nacionalidade portuguesa.
Ele mantém quatro integrações principais:

1. Google Sheets como origem operacional dos clientes.
2. PostgreSQL como base central e histórico.
3. Portal da Justiça portuguesa como fonte do andamento dos processos.
4. Kommo como CRM de acompanhamento — **reativado**.

> **Estado atual: integração com o Kommo ligada.**
> `KOMMO_INTEGRACAO_HABILITADA=true` reativa movimentação de etapa e Salesbots,
> descritos nas seções 2.4 e 2.5. A nota de status permanece desligada por
> `KOMMO_NOTA_HABILITADA=false`, porque os mesmos dados vão para os campos
> personalizados do lead (seção 2.3.1).
>
> Os lembretes de 30 dias contam a partir de `etapa_entrou_em`, que fica
> congelado enquanto a integração está desligada. Depois de um período parado,
> rode `npm run kommo:diagnostico` antes de aplicar para ver quantos lembretes
> estão vencidos e acumulados.

Fluxo principal em operação:

```text
Google Sheets
    ↓
Sincronização da planilha
    ↓
PostgreSQL
    ↓
Consulta ao portal português  (ciclo completo a cada 15 dias + admissão diária)
    ↓
PostgreSQL atualizado
    ↓
Campos personalizados do lead no Kommo
```

A última etapa tem trava própria, `KOMMO_CAMPOS_HABILITADO`, e escreve apenas
campos personalizados. Ela não move etapa, não cria nota e não dispara
Salesbot.

Etapas governadas pela trava mestre:

```text
PostgreSQL atualizado
    ↓
Sincronização com o Kommo
    ↓
Movimentação de etapa  (nota desligada por KOMMO_NOTA_HABILITADA=false)
    ↓
Salesbot imediato ou agendado
```

O processo que mantém tudo em execução no EasyPanel é
`scripts/agendador.js`, iniciado pelo comando `npm run scheduler`.

## 2. Módulos operacionais

### 2.1. Agendador

Arquivo: `scripts/agendador.js`

Responsabilidade:

- Manter o contêiner em execução.
- Iniciar a sincronização da planilha em intervalos regulares.
- Verificar diariamente se um novo ciclo de consultas deve começar.
- Iniciar a sincronização do Kommo em intervalos regulares.
- Impedir duas execuções simultâneas do mesmo módulo dentro do processo atual.
- Encerrar os processos filhos de forma controlada quando o contêiner recebe
  `SIGTERM` ou `SIGINT`.

Rotinas controladas:

| Rotina | Configuração padrão | Execução imediata |
|---|---:|---|
| Planilha → banco | A cada 10 minutos | `SINCRONIZAR_AO_INICIAR` |
| Consulta no portal | Diariamente às 08:00 | `EXECUTAR_AO_INICIAR` |
| Banco → Kommo (desativado) | A cada 15 minutos | `KOMMO_SINCRONIZAR_AO_INICIAR` |
| Campos personalizados → Kommo | A cada 30 minutos | `KOMMO_CAMPOS_SINCRONIZAR_AO_INICIAR` |

A rotina de campos também é disparada logo após cada execução do worker de
consulta, para que um resultado recém-gravado chegue ao CRM sem esperar o
intervalo de 30 minutos.

As três rotinas são independentes. No início do contêiner elas podem executar
quase simultaneamente. Uma atualização que ainda não estiver disponível será
capturada no ciclo seguinte da respectiva rotina.

### 2.2. Sincronização da planilha

Arquivo: `scripts/sincronizar_planilha.js`

Responsabilidade:

- Ler a aba configurada do Google Sheets.
- Comparar as linhas da planilha com `public.nacionalidade_portuguesa`.
- Criar no banco as pessoas novas.
- Atualizar no banco as pessoas já existentes.
- Gerar e gravar o campo `ID REGISTRO SISTEMA` quando ele estiver ausente.
- Reativar uma pessoa que volte para a planilha.
- Desativar de forma recuperável uma pessoa removida da planilha.
- Identificar registros duplicados pelo código de consulta.
- Reconhecer estados manuais de finalização.

Modos:

```bash
npm run sync:diagnostico
```

Somente analisa e apresenta o que seria alterado.

```bash
npm run sync:aplicar
```

Aplica as inclusões, atualizações, reativações e desativações.

Identificação:

- O identificador técnico principal da integração é `id_planilha`, um UUID.
- O código de consulta não é usado como identificador único porque pode existir
  repetido.

Exclusões:

- Uma exclusão na planilha não apaga fisicamente o registro.
- O registro recebe `ativo_na_planilha=false`.
- A data e o motivo da desativação ficam registrados.
- Caso a linha volte à planilha com o mesmo UUID, o registro pode ser reativado.

Duplicatas:

- Um registro é escolhido como principal para cada código repetido.
- Os demais recebem `registro_duplicado=true` e apontam para o principal.
- Duplicatas não são consultadas e não são enviadas ao Kommo.

Proteção existente:

- Uma planilha completamente vazia ou inválida bloqueia a sincronização.
- Não existe bloqueio percentual para desativações.

### 2.3. Consulta ao portal português

Arquivo: `consulta_status.js`

Responsabilidade:

- Selecionar no PostgreSQL os processos elegíveis.
- Abrir o portal da Justiça com Playwright.
- Informar o código de consulta.
- Resolver o hCaptcha por meio do 2Captcha.
- Extrair fase, posição, total de fases, data e notificações.
- Registrar o resultado atual no cadastro do cliente.
- Registrar cada tentativa no histórico.
- Reconhecer quando um processo chegou à fase final.
- Controlar ciclos globais de consulta.

Regra de elegibilidade:

```text
Possui código de consulta
E está ativo na planilha
E não é uma duplicata
E o processo ainda não foi finalizado
```

Leitura da fase no portal:

- O wizard usa `past` nas etapas já vencidas, `active` na etapa em curso e
  `next` nas pendentes.
- Um pedido em análise, porém, chega sem nenhuma etapa `active`: só `Submetido`
  aparece como `past`. Ler a última etapa `past` como fase atual congelava esses
  processos em `Submetido`, e a posição 2 nunca era alcançada.
- Quando o portal marca a etapa em curso, ela vale. Sem essa marcação, a fase
  corrente é a primeira etapa ainda pendente depois da última vencida. Só quando
  não resta nenhuma pendente o processo está na última etapa.
- No fluxo de 5 etapas, com exigência, o portal chega a marcar duas etapas como
  `active` ao mesmo tempo. Vale a primeira, que é a fase real do processo.
- A etapa pendente não traz data própria; ela herda a data da etapa vencida
  anterior, que é quando o processo entrou na fase atual.
- `selectCurrentPhase` isola essa regra e é coberta por
  `scripts/testar_fases_wizard.js`.

Finalização:

- Um processo é finalizado quando a posição retornada corresponde ao total de
  fases ou quando o texto retornado indica um estado terminal reconhecido.
- A mensagem `não corresponde a nenhum processo de nacionalidade ativo` também
  é tratada como encerramento confirmado. O número da senha é ignorado na
  comparação, permitindo reconhecer a mesma mensagem para qualquer cliente.
- Nesse caso, o banco grava fase `Encerrado` e motivo
  `portal_senha_nao_corresponde_processo_ativo`.
- Depois de finalizado, ele deixa de ser selecionado em consultas futuras.
- Estados manuais como `Terminado`, `Concluído` e `Encerrado` também podem
  marcar o processo como finalizado durante a sincronização da planilha.

Consulta de admissão:

- Um cadastro novo é detectado pela sincronização da planilha em até 10 minutos.
- Ser elegível, porém, não bastava: até esta versão ele aguardava o próximo
  ciclo global, o que podia levar até 15 dias.
- A verificação diária das 08:00 agora faz uma passagem curta quando o ciclo
  completo ainda não venceu, atendendo somente quem nunca produziu uma fase.
- O limite é próprio (`POSTGRES_ADMISSAO_LIMITE`, padrão 25) e não se confunde
  com o limite do ciclo completo.
- Uma falha é repetida a cada `POSTGRES_ADMISSAO_REINTERVALO_HORAS` até o teto
  de `POSTGRES_ADMISSAO_MAX_TENTATIVAS`; depois o cadastro aguarda o próximo
  ciclo completo. Isso impede que um código inválido seja consultado sem fim.
- A admissão **nunca** remarca o vencimento do ciclo global. A coluna `tipo` em
  `ciclos_consulta_nacionalidade` separa `completo` de `admissao`, e a consulta
  do último ciclo filtra por `tipo = 'completo'`.
- Sem essa separação, cada admissão concluída reiniciaria a contagem de 15 dias
  e o ciclo completo nunca mais venceria.

Controle de ciclo:

- O intervalo é global, e não individual por cliente.
- A verificação ocorre diariamente no horário do agendador.
- Um novo ciclo só começa quando o último ciclo concluído já atingiu o intervalo
  configurado, atualmente 15 dias.
- Quando o ciclo vence, todos os códigos elegíveis são percorridos.
- Uma pessoa incluída depois do início de um ciclo pode aguardar o próximo ciclo
  global para ser consultada.

Persistência:

- O resultado mais recente fica em `public.nacionalidade_portuguesa`.
- Cada consulta também gera uma entrada em
  `public.historico_consultas_nacionalidade`.
- O resumo da execução fica em `public.ciclos_consulta_nacionalidade`.
- Erros de uma tentativa não apagam o último resultado bem-sucedido.

Auditoria nos logs:

- Ao finalizar um ciclo, o worker imprime o marcador
  `RELATORIO_AUDITORIA_CICLO_CONSULTA`.
- O JSON contém identificação e horário do ciclo, totais, distribuição por
  fase, finalizações e o resultado individual de cada cliente.
- O relatório é enviado ao stdout e fica disponível nos logs do EasyPanel.

### 2.3.1. Campos personalizados no Kommo

Arquivos:

- `scripts/sincronizar_campos_kommo.js`;
- `scripts/lib/campos_kommo.js`;
- Persistência: `public.campos_kommo_nacionalidade`.

Responsabilidade:

- Selecionar cadastros ativos, principais e com fase automática conhecida.
- Localizar o lead por `sincronizacao_crm_nacionalidade.crm_lead_id` ou, na
  ausência dele, por `agente_kommo_nacionalidade_estado.crm_lead_id`.
- Enviar `PATCH /api/v4/leads/{id}` contendo **apenas** `custom_fields_values`.
- Gravar um hash do conteúdo para não repetir escritas idênticas.
- Registrar sucesso, erro ou ausência de lead por cadastro.

Trava:

- A variável é `KOMMO_CAMPOS_HABILITADO`, independente da trava mestre.
- Ela libera somente a escrita de campos personalizados.
- Movimentação de etapa, nota e Salesbot continuam governados exclusivamente
  por `KOMMO_INTEGRACAO_HABILITADA`, que permanece `false`.
- `validarCorpoSomenteCampos()` recusa qualquer corpo que contenha
  `status_id`, `pipeline_id`, `responsible_user_id`, `name` ou `_embedded`.
  Uma regressão futura falha nessa validação em vez de mover um lead.

Mapeamento:

| Campo no Kommo | ID | Tipo | Origem |
|---|---:|---|---|
| Fase Processual | 2990113 | text | `fase_consulta_automatica` |
| Posição da Fase | 2990115 | numeric | `posicao_fase` |
| Total de Fases | 2990117 | numeric | `total_fases` |
| Data da Fase | 2990119 | date | `data_fase` |
| Ultima Consulta CRC | 2990121 | date_time | `data_ultima_consulta` |
| Possui Notificação | 2990123 | select | `possui_notificacao` |
| Resumo de Notificações | 2990125 | textarea | `titulos_notificacoes` |
| Origem da Sincronização | 2990127 | text | `vne:nacionalidade:<id>` |
| Código CRC | 2990129 | text | `codigo_consulta` |
| N do Processo | 2990131 | text | `numero_processo` |

Cada ID aceita substituição por variável de ambiente
(`KOMMO_CAMPO_FASE_PROCESSUAL`, `KOMMO_CAMPO_POSICAO_FASE` e assim por diante).
O select `Possui Notificação` usa os enums `9258323` (SIM) e `9258325` (NÃO),
configuráveis por `KOMMO_ENUM_NOTIFICACAO_SIM` e `KOMMO_ENUM_NOTIFICACAO_NAO`.

Regras de escrita:

- Um campo sem valor conhecido não é enviado, para nunca apagar um dado
  preenchido manualmente no CRM.
- A única exceção é `Resumo de Notificações`, limpo quando a consulta afirma
  explicitamente que não há notificação.
- O módulo nunca cria leads. Sem `crm_lead_id` conhecido, o cadastro é apenas
  reportado como `sem_lead`.
- Uma trava `pg_try_advisory_lock` impede duas execuções simultâneas.
- `KOMMO_REQUISICOES_POR_SEGUNDO` limita a taxa; `429` respeita `Retry-After`.

Modos:

```bash
npm run campos:diagnostico
npm run campos:aplicar
```

Ao final, o módulo imprime `RELATORIO_AUDITORIA_CAMPOS_KOMMO`, com o
mapeamento em uso, o resumo e o detalhe por cadastro.

Histórico:

- Os campos foram criados no Kommo e preenchidos até maio/junho por workflows
  n8n (`Verificador CRC PT`, `Conservatória PT Monitor v1`, `Concierge
  Operacional`), hoje todos parados.
- Este módulo assume a responsabilidade e mantém a convenção
  `vne:nacionalidade:<id>` já usada por eles em `Origem da Sincronização`.

### 2.4. Sincronização com o Kommo

Arquivo: `scripts/sincronizar_kommo.js`

Responsabilidade:

- Selecionar clientes ativos, principais e pendentes de sincronização.
- Consumir uma fila explícita marcada por `kommo_pendente`.
- Reutilizar o ID do lead salvo anteriormente, quando ele ainda for válido.
- Procurar um lead pelo nome normalizado dentro do funil configurado.
- Criar um lead sem telefone quando nenhum lead for encontrado.
- Comparar a etapa atual do lead com a etapa calculada para o processo.
- Movimentar o lead somente quando as etapas forem diferentes.
- Criar uma nota de andamento ou atualizar a nota já controlada pelo sistema,
  somente quando `KOMMO_NOTA_HABILITADA=true`. Desligada, a nota não é escrita
  e o ID e o hash já gravados são preservados.
- Gravar no banco os IDs do lead e da nota.
- Marcar `ESTÁ NO KOMMO?` como `SIM` no banco e, quando necessário, na planilha.
- Registrar sucesso ou erro de cada tentativa.

Fila de pendências:

- Uma inclusão ou alteração relevante marca `kommo_pendente=true`.
- Um novo resultado de consulta marca novamente a pendência.
- Erros mantêm o registro pendente para nova tentativa.
- O sucesso limpa a pendência somente se não tiver surgido uma alteração mais
  nova durante a chamada ao Kommo.
- Um número de versão crescente protege a baixa contra alterações concorrentes.
- Leituras periódicas da planilha sem mudanças reais não recolocam os clientes
  na fila.

Modos:

```bash
npm run kommo:diagnostico
```

Consulta os dados e informa se o lead foi encontrado ou seria criado, sem
alterar o Kommo.

```bash
npm run kommo:aplicar
```

Cria ou atualiza efetivamente os leads, notas e etapas.

Regra para localizar ou criar:

- A busca usa o nome normalizado no funil de nacionalidade portuguesa.
- Se nenhum lead for encontrado, o sistema cria um novo.
- Isso também acontece quando `ESTÁ NO KOMMO?` já está marcado como `SIM`.
- Portanto, em casos de nomes diferentes ou cadastros antigos inconsistentes,
  pode haver duplicidade no Kommo.

Mapeamento de etapas:

| Condição do processo | Etapa de destino |
|---|---|
| Lead novo, sem fase confiável | Iniciar consulta |
| Fase manual ou automática 1 | Fase 1 |
| Fase manual ou automática 2 | Fase 2 |
| Fase manual ou automática 3 | Fase 3 |
| Fase 4 ou fase 5 | Fase 4 |
| Processo finalizado | Fase 4 |
| Indicação de exigência | Exigência |
| Risco de indeferimento | Risco de indeferimento |

Exigência e risco são detectados a partir dos textos de status, anotações e
notificações. Risco de indeferimento tem prioridade sobre exigência.

Antes de movimentar:

- O sistema lê o `status_id` atual do lead.
- Calcula o `status_id` esperado usando, nesta ordem: finalização, situações
  especiais, fase automática e fase manual.
- Sem fase confiável, preserva a etapa atual de um lead existente.
- Bloqueia regressões automáticas entre Iniciar Consulta e as Fases 1 a 4.
- Nunca reabre automaticamente os status encerrados `142` e `143`.
- Preserva Exigência e Risco de Indeferimento até existir evidência especial
  ou de finalização.
- Se os IDs forem iguais, não envia uma atualização de etapa ao Kommo.
- Se forem diferentes, movimenta o lead e contabiliza a ação como `movidos`.
- Movimentos bloqueados são contabilizados como `movimentacoes_bloqueadas`.
- O resumo contabiliza separadamente `ja_na_etapa_correta`.
- Leads novos já são criados diretamente na etapa calculada e não recebem uma
  segunda movimentação redundante.

Notas:

- O sistema cria uma nota comum no lead.
- O ID dessa nota fica salvo no banco.
- Quando o conteúdo muda, a nota existente é atualizada.
- Tanto na criação quanto na edição, envia a entidade do lead, o tipo da nota e
  o conteúdo, conforme a validação exigida pela API do Kommo.
- Um hash evita atualizações quando o conteúdo não mudou.

Finalização:

- Um processo finalizado ainda recebe uma última sincronização.
- Depois que essa sincronização final é registrada, ele deixa de ser selecionado.

Limite:

- `KOMMO_LIMITE_POR_EXECUCAO` controla quantos registros são processados por
  ciclo.
- Com o valor 30, um volume maior é consumido em lotes nos ciclos seguintes.
- `KOMMO_REQUISICOES_POR_SEGUNDO` limita globalmente buscas, leituras e escritas
  feitas pelo processo.
- O padrão é quatro requisições por segundo, mantendo margem abaixo do limite
  operacional de sete.
- Em uma resposta HTTP 429, o sistema respeita `Retry-After` e tenta novamente
  gradualmente.

Ao final de cada lote, o módulo imprime
`RELATORIO_AUDITORIA_KOMMO`, contendo resumo e detalhes por cliente: destino,
ação, lead, nota, atualização da nota ou erro.

### 2.5. Salesbots, lembretes e janela de envio

Implementação principal: `scripts/sincronizar_kommo.js`

Funções de horário: `scripts/lib/janela_salesbot.js`

Persistência: `public.disparos_salesbot_nacionalidade`

Bots configurados:

| Situação | Bot de entrada | Bot de lembrete |
|---|---:|---:|
| Fase 1 | `62867` | `62869` |
| Fase 2 | `62929` | `62931` |
| Fase 3 | `62871` | `62873` |
| Fase 4/conclusão | `62875` | Não existe |
| Exigência | `KOMMO_SALESBOT_EXIGENCIA` | `KOMMO_SALESBOT_LEMBRETE_EXIGENCIA` |
| Risco de indeferimento | Nunca envia | Nunca envia |

Regras de mudança:

- O bot de entrada é associado à nova etapa confirmada.
- Leads criados diretamente em uma etapa durante a carga inicial não recebem
  uma mensagem de mudança retroativa.
- Uma etapa apenas preservada não gera mensagem.
- Risco de indeferimento recebe movimentação e nota, mas nenhuma comunicação.
- IDs opcionais de Exigência vazios desabilitam os respectivos disparos.

Regras de lembrete:

- O primeiro lembrete vence 30 dias após `etapa_entrou_em`.
- Permanecendo na mesma etapa, novos ciclos vencem em 60, 90, 120 dias e assim
  sucessivamente.
- A mudança de etapa reinicia a contagem.
- A chave de idempotência impede o mesmo ciclo de ser enviado duas vezes.
- Fases 1, 2 e 3 têm lembrete configurado.
- Fase 4 não tem lembrete.
- Exigência só tem lembrete quando o ID opcional estiver configurado.

Cadência de comunicação:

- `KOMMO_REQUISICOES_POR_SEGUNDO` é o limite técnico da API e **não** serve como
  cadência: com ele sozinho, 100 mensagens saem em cerca de 25 segundos.
- `KOMMO_SALESBOT_INTERVALO_MS` define o espaçamento mínimo entre duas
  mensagens. Com `30000`, sai no máximo uma a cada 30 segundos.
- `KOMMO_SALESBOT_LIMITE_POR_EXECUCAO` define o tamanho do lote por ciclo.
- `KOMMO_SALESBOT_LIMITE_DIARIO` é o teto do dia, somando mudanças de fase e
  lembretes. Zero desliga o teto.
- Ao atingir o teto, a mensagem **não se perde**: recebe `status_disparo`
  `agendado` e `disparar_apos` nas 09:00 do próximo dia útil, pelo mesmo
  caminho de quem cai fora da janela.
- As mudanças de fase são processadas antes dos lembretes, então consomem a
  cota primeiro. Um lembrete de 30 dias cede lugar a uma notificação de
  andamento real.
- O espaçamento acontece antes da reserva do disparo, para não manter um
  registro em `processando` durante a espera.
- Na partida, o módulo registra a cadência em uso:

```text
[salesbot] Cadencia: 30s entre mensagens, 5 por execucao, 120 por dia.
```

Janela de comunicação:

- Segunda a sexta-feira.
- Das `09:00` inclusive até antes das `18:00`.
- Fuso `America/Sao_Paulo`, configurável por `KOMMO_SALESBOT_FUSO`.
- Fora da janela, movimentação e nota são concluídas normalmente.
- A mensagem recebe `status_disparo='agendado'` e `disparar_apos` apontando
  para as `09:00` do próximo dia útil.
- O envio ocorre na primeira execução Kommo elegível a partir desse horário.
- Se o lead mudar de etapa antes do envio, a mensagem antiga recebe
  `status_disparo='cancelado'`.

Estados de um disparo:

| Estado | Significado |
|---|---|
| `agendado` | Aguardando a próxima janela comercial |
| `processando` | Reservado pela execução atual |
| `sucesso` | A API Kommo aceitou o disparo |
| `erro` | O disparo falhou e pode ser repetido |
| `cancelado` | A etapa mudou ou o cadastro ficou inelegível antes do envio |

Uma resposta HTTP `202` significa que a Kommo aceitou a tarefa do bot. O
histórico guarda bot, lead, etapa, tipo, ciclo, tentativas, HTTP, erro e datas.

## 3. Módulos auxiliares

### 3.1. Aplicador de migrações

Arquivo: `scripts/aplicar_migracao.js`

Recebe o caminho de uma migração SQL, conecta ao PostgreSQL por
`DATABASE_URL` e executa seu conteúdo.

É utilizado pelos comandos `db:migrate*` do `package.json`.

### 3.2. Mapeamento do banco

Arquivo: `scripts/mapear_banco.js`

Faz uma inspeção somente leitura da estrutura do PostgreSQL e apresenta:

- schemas;
- tabelas;
- colunas;
- restrições;
- chaves estrangeiras;
- índices.

Comando:

```bash
npm run db:map
```

### 3.3. Inspeção dos dados de nacionalidade

Arquivo: `scripts/inspecionar_nacionalidade.js`

Produz um resumo dos dados e estados existentes nas tabelas relacionadas à
nacionalidade. É usado para diagnóstico e conferência, sem executar consultas
no portal.

Comando:

```bash
npm run db:inspect
```

### 3.4. Validação da integração PostgreSQL

Arquivo: `scripts/validar_integracao_postgres.js`

Valida se tabelas, colunas e estruturas esperadas pela integração existem e
apresenta um resumo da configuração encontrada.

Comando:

```bash
npm run db:validate
```

### 3.5. Teste real controlado

Arquivo: `scripts/executar_teste_real.js`

Seleciona um registro específico e inicia `consulta_status.js` com variáveis
de ambiente próprias para uma consulta real controlada. Deve ser usado apenas
para diagnóstico, evitando testar o lote completo.

Comando:

```bash
npm run test:real
```

### 3.6. Teste do fluxo completo

Arquivo: `scripts/testar_fluxo_completo.js`

Executa uma validação integrada e controlada:

1. Sincroniza a planilha inteira com o banco.
2. Seleciona até 10 pessoas elegíveis.
3. Consulta individualmente essas pessoas no portal.
4. Sincroniza exatamente as mesmas pessoas com o Kommo.
5. Imprime um relatório consolidado com sucessos e erros.

Comando:

```bash
npm run teste:fluxo:10
```

O limite pode ser substituído por `TESTE_FLUXO_LIMITE`, entre 1 e 50. A
sincronização da planilha continua integral porque ela precisa detectar
inclusões e exclusões; o limite se aplica às consultas e ao Kommo.

### 3.7. Teste direto de Salesbot

Arquivo: `scripts/testar_salesbot.js`

Valida a existência de um lead e permite acionar um bot específico de maneira
controlada:

```bash
node scripts/testar_salesbot.js BOT_ID LEAD_ID
node scripts/testar_salesbot.js BOT_ID LEAD_ID --aplicar
```

Sem `--aplicar`, apenas valida o lead. Com `--aplicar`, chama
`POST /api/v4/bots/{id}/run`.

### 3.8. Teste da janela de Salesbots

Arquivos:

- `scripts/testar_janela_salesbot.js`;
- `scripts/lib/janela_salesbot.js`.

Comando:

```bash
npm run teste:janela-salesbot
```

Valida os limites de 09:00, 18:00, dias úteis e a passagem de sexta-feira para
segunda-feira.

### 3.9. Diagnóstico de movimentação Kommo

Arquivo: `scripts/diagnosticar_movimentacao_kommo.js`

Recebe o ID interno de `nacionalidade_portuguesa`, consulta o banco em
transação somente leitura e compara o cadastro com o lead encontrado na Kommo:

```bash
node scripts/diagnosticar_movimentacao_kommo.js ID_INTERNO
```

É usado para explicar por que um lead seria ou não movimentado.

### 3.10. Diagnóstico de partida

Arquivo: `scripts/diagnosticar_partida.js`

Consulta somente o PostgreSQL e informa:

- total de pendências Kommo;
- processos elegíveis e códigos distintos;
- lembretes vencidos;
- falhas e disparos em processamento;
- último ciclo de consulta.

Comando:

```bash
node scripts/diagnosticar_partida.js
```

## 4. Configuração

### 4.1. `config.json`

Contém padrões para execução local do módulo de consulta, incluindo:

- URL do portal;
- tempos máximos;
- configuração do captcha;
- modo de teste;
- simulação;
- limites;
- intervalo de reconsulta;
- dados padrão da planilha.

No EasyPanel, o agendador sobrescreve as opções operacionais relevantes por
variáveis de ambiente.

### 4.2. `.env`

Contém conexões, credenciais, IDs e opções operacionais. Ele não deve ser
enviado ao Git.

Grupos principais:

- PostgreSQL: `DATABASE_URL`.
- Captcha: `TWOCAPTCHA_API_KEY`.
- Google: `GOOGLE_SHEET_ID`, `GOOGLE_SHEET_NAME` e credenciais.
- Consulta: `AGENDADOR_*`, `POSTGRES_*` e `EXECUTAR_AO_INICIAR`.
- Planilha: `SINCRONIZACAO_*`.
- Kommo: `KOMMO_*`.

Variáveis operacionais mais importantes:

| Variável | Função |
|---|---|
| `AGENDADOR_HORA=8` | Hora diária da verificação do ciclo processual |
| `AGENDADOR_MINUTO=0` | Minuto da verificação |
| `POSTGRES_CICLO_DIAS=15` | Intervalo global entre ciclos concluídos |
| `SINCRONIZACAO_INTERVALO_MINUTOS=10` | Frequência planilha → banco |
| `KOMMO_INTERVALO_MINUTOS=15` | Frequência banco → Kommo e Salesbots |
| `KOMMO_LIMITE_POR_EXECUCAO=30` | Quantidade de pendências por lote |
| `KOMMO_SALESBOT_LEMBRETE_DIAS=30` | Tamanho de cada ciclo de lembrete |
| `KOMMO_SALESBOT_LIMITE_POR_EXECUCAO=100` | Limite de bots por execução |
| `KOMMO_SALESBOT_FUSO` | Fuso usado para a janela de mensagens |
| `KOMMO_SALESBOT_EXIGENCIA` | Bot opcional de entrada em Exigência |
| `KOMMO_SALESBOT_LEMBRETE_EXIGENCIA` | Bot opcional de lembrete de Exigência |
| `POSTGRES_ADMISSAO_ATIVA=true` | Liga a consulta de admissão entre ciclos |
| `POSTGRES_ADMISSAO_LIMITE=25` | Cadastros novos por passagem de admissão |
| `POSTGRES_ADMISSAO_REINTERVALO_HORAS=24` | Espaçamento entre retentativas |
| `POSTGRES_ADMISSAO_MAX_TENTATIVAS=5` | Teto de falhas antes de aguardar o ciclo |
| `KOMMO_CAMPOS_HABILITADO` | Trava só dos campos personalizados |
| `KOMMO_CAMPOS_ATIVO` | Liga a rotina de campos no agendador |
| `KOMMO_CAMPOS_INTERVALO_MINUTOS=30` | Frequência banco → campos do lead |
| `KOMMO_CAMPOS_LIMITE_POR_EXECUCAO=100` | Cadastros por lote de campos |

O conteúdo de tokens, senhas e chaves privadas nunca deve aparecer em logs ou
documentação.

### 4.3. Credenciais do Google

O sistema aceita:

- `GOOGLE_SERVICE_ACCOUNT_JSON`, contendo o JSON por variável de ambiente; ou
- `GOOGLE_CREDENTIALS_FILE`, apontando para um arquivo montado no contêiner.

O arquivo `google-service-account.json` é ignorado pelo Git e pelo Docker.
Quando for usado `/app/google-service-account.json`, o EasyPanel deve montar a
credencial exatamente nesse caminho.

## 5. Banco de dados e migrações

### `001_consultas_nacionalidade.sql`

Adiciona os campos do resultado automático e cria o histórico de consultas.

### `002_ciclos_consulta.sql`

Cria o controle de ciclos globais, incluindo início, finalização, próxima
execução, totais e erros.

### `003_tentativas_e_ciclo_historico.sql`

Separa a última tentativa do último sucesso e relaciona o histórico ao ciclo.

### `004_sincronizacao_planilha_e_elegibilidade.sql`

Adiciona UUID da planilha, desativação recuperável, finalização e controle de
duplicatas. Também cria os índices e gatilhos relacionados.

### `005_integracao_kommo.sql`

Cria o controle de sincronização com o CRM, armazenando lead, nota, etapa,
tentativas, erros e conclusão da sincronização final.

### `006_fila_pendencias_kommo.sql`

Cria a fila explícita do Kommo e o gatilho que registra inclusões, reativações,
alterações relevantes, resultados de consulta e finalizações. A baixa da fila
é protegida contra atualizações concorrentes.

### `007_salesbots_kommo.sql`

Adiciona `etapa_entrou_em` e `salesbot_ultimo_disparo_em` ao controle CRM.
Cria `public.disparos_salesbot_nacionalidade`, com chave de idempotência,
tipo de mensagem, ciclo de lembrete, bot, lead, etapa, tentativas e resultado.

### `008_janela_horario_salesbots.sql`

Adiciona `disparar_apos`, os estados `agendado` e `cancelado` e um índice
parcial para localizar rapidamente mensagens que chegaram ao horário de envio.

### `009_normalizar_id_registro.sql`

Remove espaços externos de identificadores antigos. A migração só normaliza
valores únicos após `btrim()`, evitando violar o índice único caso existam dois
identificadores legados que se diferenciem apenas por espaços.

### `011_consulta_admissao.sql`

Adiciona a coluna `tipo` em `ciclos_consulta_nacionalidade`, com o CHECK
`completo` ou `admissao`, e os índices que localizam o último ciclo completo e
os cadastros elegíveis para admissão. Ciclos anteriores viram `completo`.

### `012_campos_personalizados_kommo.sql`

Cria `public.campos_kommo_nacionalidade`, com lead, hash do conteúdo,
datas, status e erro da última tentativa de escrita dos campos personalizados.

Ordem de aplicação em um banco novo:

```bash
npm run db:migrate
npm run db:migrate:cycles
npm run db:migrate:attempts
npm run db:migrate:sync
npm run db:migrate:kommo
npm run db:migrate:kommo-queue
npm run db:migrate:salesbots
npm run db:migrate:salesbot-window
npm run db:migrate:normalize-ids
npm run db:migrate:admissao
npm run db:migrate:campos-kommo
```

As migrações usam `IF NOT EXISTS` onde aplicável, mas devem ser executadas na
ordem numérica porque as posteriores dependem das tabelas e colunas anteriores.

## 6. Implantação

### Docker

Arquivo: `Dockerfile`

- Usa uma imagem do Playwright com navegador e dependências.
- Instala as dependências Node.js de produção.
- Copia o projeto para `/app`.
- Executa com o usuário sem privilégios `pwuser`.
- Inicia `npm run scheduler`.

### EasyPanel

O EasyPanel deve manter o contêiner continuamente em execução. Não é necessário
criar tarefas cron separadas, pois o agendador Node controla os intervalos.

Depois de alterar código ou variáveis:

1. Enviar o código ao GitHub, quando houver alteração de arquivos.
2. Salvar as variáveis no EasyPanel.
3. Reimplementar o serviço.
4. Conferir os logs das três rotinas.

Mensagens esperadas:

```text
[sincronizacao] Intervalo configurado: 10 minuto(s).
[campos-kommo] Intervalo configurado: 30 minuto(s).
[agendador] Proxima verificacao:
```

Com a integração mestre desligada, a linha do Kommo é substituída pelo aviso
de integração desativada. Isso é esperado: apenas a rotina de campos escreve
no CRM.

Nos dias em que o ciclo completo ainda não venceu, o worker imprime:

```text
[admissao] Ciclo completo ainda nao vencido (previsto para ...). N cadastro(s)
novo(s) sem resultado selecionado(s), limite 25.
```

### Configuração recomendada de produção

```env
TZ=America/Sao_Paulo

SINCRONIZACAO_ATIVA=true
SINCRONIZACAO_INTERVALO_MINUTOS=10
SINCRONIZAR_AO_INICIAR=true

EXECUTAR_AO_INICIAR=true
AGENDADOR_HORA=8
AGENDADOR_MINUTO=0
POSTGRES_CICLO_DIAS=15
POSTGRES_LIMITE=1000

KOMMO_INTEGRACAO_HABILITADA=false
KOMMO_SINCRONIZACAO_ATIVA=true
KOMMO_INTERVALO_MINUTOS=15
KOMMO_SINCRONIZAR_AO_INICIAR=true
KOMMO_LIMITE_POR_EXECUCAO=30
KOMMO_REQUISICOES_POR_SEGUNDO=4
KOMMO_SALESBOT_LEMBRETE_DIAS=30
KOMMO_SALESBOT_LIMITE_POR_EXECUCAO=100
KOMMO_SALESBOT_FUSO=America/Sao_Paulo
KOMMO_SALESBOT_FASE_1=62867
KOMMO_SALESBOT_LEMBRETE_FASE_1=62869
KOMMO_SALESBOT_FASE_2=62929
KOMMO_SALESBOT_LEMBRETE_FASE_2=62931
KOMMO_SALESBOT_FASE_3=62871
KOMMO_SALESBOT_LEMBRETE_FASE_3=62873
KOMMO_SALESBOT_FASE_4=62875
KOMMO_SALESBOT_EXIGENCIA=
KOMMO_SALESBOT_LEMBRETE_EXIGENCIA=
```

`KOMMO_INTEGRACAO_HABILITADA=false` é a trava mestre e tem precedência sobre
`KOMMO_SINCRONIZACAO_ATIVA`. As demais variáveis `KOMMO_*` continuam
cadastradas apenas para uma eventual reativação.

Sequência efetiva **em operação hoje**:

```text
Planilha sincroniza com o PostgreSQL
→ processos elegíveis são consultados
→ cada resultado confirmado cria uma pendência para o Kommo
→ a pendência permanece na fila, sem envio, enquanto a trava estiver ativa
```

Sequência completa, válida somente se a trava for reativada:

```text
→ o Kommo consome as pendências em lotes
→ a etapa só muda quando o status_id atual é diferente
→ a nota é criada ou atualizada
→ o Salesbot é enviado ou agendado conforme a janela comercial
→ o sucesso encerra a pendência correspondente
```

As rotinas têm agendas independentes. Para um cliente específico, o Kommo
somente recebe um resultado depois que a transação da consulta foi confirmada
no PostgreSQL. Se uma alteração mais nova ocorrer durante uma chamada ao Kommo,
o versionamento mantém uma nova pendência para o próximo lote.

### Marcadores de auditoria

Use estes textos para localizar relatórios estruturados nos logs:

```text
RELATORIO_AUDITORIA_CICLO_CONSULTA
RELATORIO_AUDITORIA_KOMMO
```

O primeiro é emitido uma vez ao final do ciclo global de consultas. O segundo
é emitido ao final de cada lote do Kommo. Como o Kommo pode continuar
processando pendências depois que o portal terminou, não existe um único
relatório combinado para os dois módulos.

Os logs são uma visualização operacional. A fonte persistente de auditoria é:

- `public.historico_consultas_nacionalidade`;
- `public.ciclos_consulta_nacionalidade`;
- `public.sincronizacao_crm_nacionalidade`;
- `public.disparos_salesbot_nacionalidade`.

### Estado inicial da entrada em produção

Em 23 de julho de 2026, antes do primeiro ciclo completo desta versão:

- 28 entradas de histórico anteriores foram removidas;
- 3 ciclos anteriores foram removidos;
- as identidades das duas tabelas foram reiniciadas;
- os cadastros, resultados atuais e estados de finalização dos clientes foram
  preservados;
- o próximo início com `EXECUTAR_AO_INICIAR=true` deve abrir um ciclo global
  imediatamente, pois não existe ciclo concluído anterior.

Essa limpeza foi uma ação operacional única e não faz parte do comportamento
recorrente do sistema.

## 7. Comandos principais

| Comando | Função |
|---|---|
| `npm run scheduler` | Inicia toda a automação |
| `npm start` | Executa diretamente o módulo de consulta |
| `npm run sync:diagnostico` | Analisa planilha → banco sem alterar |
| `npm run sync:aplicar` | Aplica planilha → banco |
| `npm run kommo:diagnostico` | Analisa banco → Kommo sem alterar |
| `npm run kommo:aplicar` | Aplica banco → Kommo |
| `npm run teste:fluxo:10` | Testa o fluxo completo com até 10 pessoas |
| `npm run teste:janela-salesbot` | Testa os limites da janela de mensagens |
| `npm run teste:processo-inativo` | Testa a mensagem de processo encerrado |
| `npm run db:map` | Mapeia a estrutura do banco |
| `npm run db:inspect` | Inspeciona os dados de nacionalidade |
| `npm run db:validate` | Valida a integração PostgreSQL |
| `npm run test:real` | Executa um teste real controlado |
| `npm run db:migrate:salesbots` | Aplica persistência dos Salesbots |
| `npm run db:migrate:salesbot-window` | Aplica a fila de horário comercial |
| `npm run db:migrate:desativar-kommo` | Cancela os Salesbots agendados na fila |

## 8. Resumo das regras de negócio

Um processo pode ser consultado quando:

```text
ativo na planilha
+ possui código
+ não é duplicata
+ não está finalizado
```

Um registro pode ser enviado ao Kommo quando:

```text
ativo na planilha
+ não é duplicata
+ possui uma sincronização pendente
```

Um processo finalizado:

```text
deixa de ser consultado
+ recebe a última atualização no Kommo
+ deixa de ser sincronizado após a confirmação final
```

## 9. Mapa técnico de arquivos e funções

Esta seção indica onde cada responsabilidade está implementada. Funções
auxiliares pequenas também estão listadas para facilitar manutenção e busca no
código.

### 9.1. `scripts/agendador.js`

| Função | Responsabilidade |
|---|---|
| `nextExecution` | Calcula a próxima verificação diária, padrão 08:00 |
| `schedule` | Agenda a próxima execução do portal |
| `execute` | Inicia `consulta_status.js` com controle de ciclo e modo real |
| `executeSync` | Inicia planilha → PostgreSQL com `--aplicar` |
| `scheduleSync` | Mantém o intervalo da planilha, padrão 10 minutos |
| `executeKommo` | Inicia banco → Kommo com `--aplicar` |
| `scheduleKommo` | Mantém o intervalo Kommo, padrão 15 minutos |
| `shutdown` | Encerra timers e processos filhos ao receber sinal |

O arquivo também mantém referências aos processos filhos para impedir duas
execuções locais simultâneas de cada rotina.

### 9.2. `scripts/sincronizar_planilha.js`

| Função | Responsabilidade |
|---|---|
| `text` | Converte valores da planilha em texto seguro |
| `normalizeHeader` | Normaliza nomes de colunas |
| `parseDate` | Converte datas da planilha |
| `columnLetter` | Converte índice em letra de coluna |
| `legacyId` | Obtém identificadores antigos quando existirem |
| `normalizedText` | Normaliza textos usados em comparação |
| `dateKey` | Uniformiza datas para detectar mudanças |
| `sourceDataChanged` | Decide se os dados de origem realmente mudaram |
| `isManualFinalStatus` | Reconhece status manuais terminais |
| `addCandidate` | Agrupa possíveis correspondências de uma linha |
| `openSheet` | Autentica e lê a planilha Google |
| `mapRows` | Transforma linhas em objetos do domínio |
| `loadDatabase` | Carrega cadastros e estados atuais do PostgreSQL |
| `analyze` | Calcula inclusões, alterações, reativações e desativações |
| `writeIds` | Grava UUIDs ausentes na planilha |
| `applyDatabase` | Aplica as mudanças calculadas em transação |

### 9.3. `consulta_status.js`

Captcha e navegação:

| Função | Responsabilidade |
|---|---|
| `extractHCaptchaSitekey` | Localiza a sitekey do hCaptcha |
| `hasHCaptcha` | Detecta se o desafio está presente |
| `injectHCaptchaToken` | Injeta o token resolvido na página |
| `solveWithCapSolver` | Implementação legada de provedor alternativo |
| `post2Captcha` | Executa chamadas HTTP ao 2Captcha |
| `solveWith2Captcha` | Cria e acompanha uma tarefa do 2Captcha |
| `solveHCaptcha` | Orquestra a resolução automática |
| `handleCaptcha` | Decide entre resolução automática e intervenção manual |
| `firstVisible` | Retorna o primeiro seletor visível |
| `fillCode` | Preenche o código de consulta |
| `clickConsultar` | Aciona a consulta no portal |
| `waitForManualCaptcha` | Aguarda confirmação manual quando configurado |
| `consultarStatus` | Executa uma tentativa completa no portal |
| `consultarComTentativas` | Repete falhas transitórias; para captcha, descarta a página, aguarda e obtém um desafio novo |

Configuração, planilhas e utilitários:

| Função | Responsabilidade |
|---|---|
| `loadConfig` | Combina `config.json` com variáveis de ambiente |
| `normalizeHeader` | Normaliza cabeçalhos |
| `cellText` | Extrai texto de uma célula local |
| `readHeaders` | Lê cabeçalhos do Excel |
| `requireColumn` | Exige uma coluna obrigatória |
| `ensureColumn` | Cria uma coluna local ausente |
| `columnToLetter` | Converte posição em letra |
| `escapeSheetName` | Escapa nome de aba |
| `googleRange` | Monta intervalos A1 do Google Sheets |
| `googleCellText` | Normaliza valores retornados pelo Google |
| `maskCode` | Mascara códigos nos logs |
| `withTimeout` | Aplica tempo máximo a uma promessa |
| `readGoogleHeaders` | Lê cabeçalhos retornados pela API Google |
| `outputColumnDefinitions` | Define colunas de saída da consulta |
| `createGoogleSheetsClient` | Cria cliente autenticado do Google |
| `openLocalExcelSpreadsheet` | Abre armazenamento Excel local |
| `ensureGoogleColumn` | Cria uma coluna ausente no Google Sheets |
| `openGoogleSheetsSpreadsheet` | Abre o adaptador Google Sheets |
| `openSpreadsheet` | Seleciona o adaptador de armazenamento |

Domínio e persistência:

| Função | Responsabilidade |
|---|---|
| `parsePhasePosition` | Extrai a posição numérica da fase |
| `parsePortalDate` | Converte datas retornadas pelo portal |
| `isFinalProcess` | Decide se o processo chegou ao estado final |
| `isInactiveProcessMessage` | Reconhece a mensagem de senha sem processo ativo |
| `isRetryableConsultationError` | Define quais falhas abrem uma página nova, incluindo captcha |
| `classifyError` | Classifica falhas para histórico e retentativa |
| `openPostgresStorage` | Seleciona elegíveis, controla ciclos e persiste resultados |
| `selectCurrentPhase` | Escolhe a fase corrente entre as etapas do wizard |
| `extractProcessData` | Extrai fase, data, posição e notificações da página |
| `main` | Inicializa navegador, percorre registros e emite a auditoria |

### 9.4. `scripts/sincronizar_kommo.js`

Decisão de etapa e conteúdo:

| Função | Responsabilidade |
|---|---|
| `optionalPositiveInteger` | Valida IDs opcionais de bot |
| `text` | Converte valores em texto |
| `normalize` | Normaliza texto para comparação |
| `positiveMention` | Detecta termos positivos ignorando negações conhecidas |
| `manualPhaseTarget` | Mapeia Fases 1 a 3 e Iniciar Consulta do status manual |
| `targetCandidate` | Calcula o destino usando prioridades de negócio |
| `preservedTarget` | Representa uma etapa Kommo que deve ser mantida |
| `resolveTarget` | Aplica proteções contra regressão, reabertura e dados vazios |
| `formatDate` | Formata datas no fuso de São Paulo |
| `noteContent` | Monta a nota controlada pelo sistema |

Comunicação com a Kommo:

| Função | Responsabilidade |
|---|---|
| `waitForKommoRateLimit` | Respeita o limite global de chamadas |
| `retryAfterMs` | Calcula espera para HTTP 429 e erros temporários |
| `kommoRequest` | Cliente HTTP comum com autenticação e retentativas |
| `findLeadByName` | Busca nome exato normalizado no funil configurado |
| `validateStoredLead` | Valida o lead previamente vinculado |
| `createLead` | Cria um lead na etapa calculada |
| `moveLead` | Atualiza funil e etapa |
| `upsertNote` | Cria ou atualiza a nota controlada |
| `markKommoInSheet` | Marca `ESTÁ NO KOMMO?` na planilha |

Salesbots:

| Função | Responsabilidade |
|---|---|
| `launchSalesbot` | Chama `POST /api/v4/bots/{id}/run` |
| `salesbotFor` | Obtém o bot de entrada ou lembrete de uma etapa |
| `stageKeyDate` | Normaliza a data usada na idempotência |
| `scheduleSalesbotDispatch` | Persiste um bot fora da janela comercial |
| `reserveSalesbotDispatch` | Reserva de forma idempotente um disparo |
| `executeSalesbotDispatch` | Agenda ou executa conforme dia e horário |
| `dispatchStageChangeSalesbot` | Cria o evento de bot para mudança de fase |
| `loadDueReminders` | Localiza ciclos de 30 dias ainda não enviados |
| `processDueReminders` | Processa ou agenda os lembretes vencidos |
| `processScheduledSalesbots` | Envia agendados e cancela mensagens obsoletas |
| `processFailedStageChanges` | Repete falhas confirmadas de mudança |

Fila e banco:

| Função | Responsabilidade |
|---|---|
| `loadCandidates` | Seleciona o lote de pendências Kommo |
| `saveSuccess` | Persiste lead, nota, etapa e baixa a versão processada |
| `saveError` | Registra a falha sem perder a pendência |

O bloco principal do arquivo obtém uma trava consultiva PostgreSQL, percorre o
lote, executa agendados, falhas e lembretes, atualiza a planilha e libera a
trava no `finally`.

### 9.5. `scripts/lib/janela_salesbot.js`

| Função | Responsabilidade |
|---|---|
| `isSalesbotBusinessHours` | Informa se o momento está entre 09:00 e 18:00 em dia útil |
| `nextSalesbotBusinessTime` | Calcula 09:00 do mesmo dia ou do próximo dia útil |

### 9.6. `scripts/lib/integracao_kommo.js`

Trava mestre da integração com o Kommo. Fica no código, e não somente na
configuração do EasyPanel, para que `KOMMO_SINCRONIZACAO_ATIVA` ou uma execução
manual não consigam reativar os envios por engano.

| Função | Responsabilidade |
|---|---|
| `integracaoKommoHabilitada` | Informa se `KOMMO_INTEGRACAO_HABILITADA` é exatamente `true` |
| `avisoIntegracaoKommoDesativada` | Monta a mensagem padrão de bloqueio para os logs |

Pontos protegidos pela trava:

| Arquivo | Comportamento com a trava ativa |
|---|---|
| `scripts/sincronizar_kommo.js` | Encerra com aviso e código de saída `0`, antes de exigir token |
| `scripts/agendador.js` | Não agenda nem executa o ciclo do Kommo |
| `scripts/testar_salesbot.js` | Recusa `--aplicar`; a leitura do lead continua permitida |
| `scripts/testar_fluxo_completo.js` | Pula a etapa 3/3 e marca os detalhes como `ignorado` |

### 9.7. Scripts sem API interna

Estes arquivos executam seu trabalho no bloco principal, sem expor funções de
domínio reutilizáveis:

| Arquivo | Responsabilidade |
|---|---|
| `scripts/aplicar_migracao.js` | Executar um arquivo SQL |
| `scripts/diagnosticar_fases.js` | Imprimir como o portal marca cada etapa de um código |
| `scripts/diagnosticar_movimentacao_kommo.js` | Comparar banco e lead |
| `scripts/diagnosticar_partida.js` | Resumir o estado antes da partida |
| `scripts/executar_teste_real.js` | Executar uma consulta real isolada |
| `scripts/inspecionar_nacionalidade.js` | Inspecionar dados e estrutura |
| `scripts/validar_integracao_postgres.js` | Validar objetos obrigatórios |

Outros auxiliares com função local:

| Arquivo/função | Responsabilidade |
|---|---|
| `scripts/mapear_banco.js` / `query` | Consultar metadados do PostgreSQL |
| `scripts/testar_fluxo_completo.js` / `runNode` | Iniciar subprocessos do teste integrado |
| `scripts/testar_salesbot.js` / `request` | Fazer chamadas controladas à Kommo |
| `scripts/testar_janela_salesbot.js` / `localDate` | Criar datas dos testes de fronteira |
| `scripts/testar_processo_inativo.js` | Validar a detecção de processo encerrado sem fases |
| `scripts/testar_fases_wizard.js` | Validar a leitura da fase corrente no wizard |

## 10. Mapa das tabelas persistentes

| Tabela | Papel |
|---|---|
| `public.nacionalidade_portuguesa` | Cadastro central, resultado atual, elegibilidade e fila Kommo |
| `public.historico_consultas_nacionalidade` | Histórico de tentativas e resultados do portal |
| `public.ciclos_consulta_nacionalidade` | Execuções globais de consulta a cada 15 dias |
| `public.sincronizacoes_planilha_nacionalidade` | Auditoria da planilha |
| `public.sincronizacao_crm_nacionalidade` | Vínculo com lead/nota, etapa e última tentativa CRM |
| `public.disparos_salesbot_nacionalidade` | Idempotência, agenda e histórico de Salesbots |

Relações principais:

```text
nacionalidade_portuguesa
    ├── historico_consultas_nacionalidade
    ├── sincronizacao_crm_nacionalidade
    └── disparos_salesbot_nacionalidade

ciclos_consulta_nacionalidade
    └── historico_consultas_nacionalidade
```

## 11. Fluxos completos por evento

### Mudança detectada na consulta

```text
Portal retorna nova fase
→ consulta_status.js atualiza PostgreSQL
→ gatilho marca kommo_pendente
→ sincronizar_kommo.js calcula destino seguro
→ lead é movimentado
→ nota é atualizada
→ Salesbot é enviado ou agendado
→ evento e sincronização são persistidos
```

### Permanência por 30 dias

```text
Rotina Kommo encontra ciclo vencido
→ confirma que lead continua na mesma etapa
→ gera chave idempotente para o ciclo
→ envia na janela comercial ou agenda
→ registra sucesso, erro ou cancelamento
```

### Risco de indeferimento

```text
Texto indica risco
→ lead vai para Risco de Indeferimento
→ nota é atualizada
→ nenhum Salesbot é criado
→ equipe analisa manualmente
```

### Mensagem criada fora do horário

```text
Movimentação ocorre fora de seg-sex 09:00–18:00
→ Salesbot recebe status agendado
→ disparar_apos aponta para 09:00 do próximo dia útil
→ rotina Kommo revisa se a etapa continua válida
    ├── válida: dispara
    └── alterada/inativa: cancela
```
