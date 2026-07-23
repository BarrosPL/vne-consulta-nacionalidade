# Documentação dos módulos do sistema

## 1. Visão geral

O sistema automatiza o acompanhamento de processos de nacionalidade portuguesa.
Ele mantém quatro integrações principais:

1. Google Sheets como origem operacional dos clientes.
2. PostgreSQL como base central e histórico.
3. Portal da Justiça portuguesa como fonte do andamento dos processos.
4. Kommo como CRM de acompanhamento.

Fluxo principal:

```text
Google Sheets
    ↓
Sincronização da planilha
    ↓
PostgreSQL
    ↓
Consulta ao portal português
    ↓
PostgreSQL atualizado
    ↓
Sincronização com o Kommo
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
| Consulta no portal | Diariamente às 02:00 | `EXECUTAR_AO_INICIAR` |
| Banco → Kommo | A cada 15 minutos | `KOMMO_SINCRONIZAR_AO_INICIAR` |

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

Finalização:

- Um processo é finalizado quando a posição retornada corresponde ao total de
  fases ou quando o texto retornado indica um estado terminal reconhecido.
- Depois de finalizado, ele deixa de ser selecionado em consultas futuras.
- Estados manuais como `Terminado`, `Concluído` e `Encerrado` também podem
  marcar o processo como finalizado durante a sincronização da planilha.

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
- Criar uma nota de andamento ou atualizar a nota já controlada pelo sistema.
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
| Ainda sem resultado | Iniciar consulta |
| Fase 1 | Fase 1 |
| Fase 2 | Fase 2 |
| Fase 3 | Fase 3 |
| Fase 4 ou fase 5 | Fase 4 |
| Processo finalizado | Fase 4 |
| Indicação de exigência | Exigência |
| Risco de indeferimento | Risco de indeferimento |

Exigência e risco são detectados a partir dos textos de status, anotações e
notificações. Risco de indeferimento tem prioridade sobre exigência.

Antes de movimentar:

- O sistema lê o `status_id` atual do lead.
- Calcula o `status_id` esperado com base no resultado da consulta.
- Se os IDs forem iguais, não envia uma atualização de etapa ao Kommo.
- Se forem diferentes, movimenta o lead e contabiliza a ação como `movidos`.
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
[kommo] Intervalo configurado: 15 minuto(s).
[agendador] Proxima verificacao:
```

### Configuração recomendada de produção

```env
TZ=America/Sao_Paulo

SINCRONIZACAO_ATIVA=true
SINCRONIZACAO_INTERVALO_MINUTOS=10
SINCRONIZAR_AO_INICIAR=true

EXECUTAR_AO_INICIAR=true
AGENDADOR_HORA=2
AGENDADOR_MINUTO=0
POSTGRES_CICLO_DIAS=15
POSTGRES_LIMITE=1000

KOMMO_SINCRONIZACAO_ATIVA=true
KOMMO_INTERVALO_MINUTOS=15
KOMMO_SINCRONIZAR_AO_INICIAR=true
KOMMO_LIMITE_POR_EXECUCAO=30
KOMMO_REQUISICOES_POR_SEGUNDO=4
```

Sequência efetiva:

```text
Planilha sincroniza com o PostgreSQL
→ processos elegíveis são consultados
→ cada resultado confirmado cria uma pendência para o Kommo
→ o Kommo consome as pendências em lotes
→ a etapa só muda quando o status_id atual é diferente
→ a nota é criada ou atualizada
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
- `public.sincronizacao_crm_nacionalidade`.

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
| `npm run db:map` | Mapeia a estrutura do banco |
| `npm run db:inspect` | Inspeciona os dados de nacionalidade |
| `npm run db:validate` | Valida a integração PostgreSQL |
| `npm run test:real` | Executa um teste real controlado |

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
