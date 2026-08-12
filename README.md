# Sistema de consulta de nacionalidade

Worker Node.js que lê os códigos de consulta no PostgreSQL, consulta o portal do Registo/Justiça, resolve o hCaptcha pelo 2Captcha e grava o resultado atual e o histórico no banco.

## Armazenamento

O PostgreSQL é a única fonte operacional. A conexão é definida por `DATABASE_URL` no `.env` local ou nos segredos do EasyPanel.

Tabelas principais:

- `public.nacionalidade_portuguesa`;
- `public.historico_consultas_nacionalidade`;
- `public.ciclos_consulta_nacionalidade`.
- `public.sincronizacoes_planilha_nacionalidade`.

Os campos manuais `status` e `anotacoes` não são sobrescritos.

## Instalação local

```powershell
npm.cmd install
npx.cmd playwright install chromium
```

## Teste protegido

O `config.json` inicia com modo de teste e simulação ativos. Para uma seleção segura, informe temporariamente um `id_registro_teste` e execute:

```powershell
npm.cmd start
```

Com `simular: true`, nenhum navegador é aberto e nenhum dado é alterado.

## Banco de dados

```powershell
npm.cmd run db:validate
npm.cmd run db:inspect
npm.cmd run db:map
```

Migrações:

- `migrations/001_consultas_nacionalidade.sql`;
- `migrations/002_ciclos_consulta.sql`.
- `migrations/003_tentativas_e_ciclo_historico.sql`.
- `migrations/004_sincronizacao_planilha_e_elegibilidade.sql`.
- `migrations/005_integracao_kommo.sql`;
- `migrations/006_fila_pendencias_kommo.sql`;
- `migrations/007_salesbots_kommo.sql`.

## Sincronização da planilha

A aba `Andamentos` é sincronizada com o PostgreSQL sem excluir fisicamente
cadastros. Linhas removidas são marcadas como inativas e podem ser reativadas.
Cada linha recebe um UUID na coluna `ID REGISTRO SISTEMA`.

O diagnóstico é somente leitura:

```powershell
npm.cmd run sync:diagnostico
```

Depois de aplicar a migração 004 e conferir o diagnóstico:

```powershell
npm.cmd run sync:aplicar
```

Um registro só é elegível para consulta quando está ativo na planilha, não é
duplicata, possui código e ainda não foi finalizado.

## Integração com Kommo (desativada)

A integração com o Kommo está **desligada**. O sistema hoje faz apenas
planilha → consulta no portal → PostgreSQL. Nenhuma movimentação de etapa,
nota ou Salesbot é enviada ao CRM.

A trava é `KOMMO_INTEGRACAO_HABILITADA`, que fica em `false` por padrão e vale
para todos os caminhos de escrita:

- o agendador não inicia o ciclo do Kommo, mesmo com `KOMMO_SINCRONIZACAO_ATIVA=true`;
- `npm run kommo:aplicar` e `npm run kommo:diagnostico` encerram com aviso;
- `scripts/testar_salesbot.js --aplicar` recusa o disparo manual;
- `npm run teste:fluxo:10` pula a etapa de Kommo e a marca como `ignorado`.

Ao desativar, cancele os Salesbots que ficaram na fila aguardando a janela
comercial, para que nenhuma mensagem antiga seja enviada em uma reativação
futura:

```powershell
npm.cmd run db:migrate:desativar-kommo
```

A fila de pendências (`kommo_pendente`) continua sendo alimentada pelo banco.
Ela não envia nada enquanto a trava estiver ativa e serve para retomar a
sincronização caso a integração volte.

Para reativar, defina `KOMMO_INTEGRACAO_HABILITADA=true` junto de
`KOMMO_SINCRONIZACAO_ATIVA=true`. A documentação abaixo descreve o
comportamento nesse caso.

O diagnóstico consulta o Kommo, mas não cria nem altera leads:

```powershell
npm.cmd run kommo:diagnostico
```

O modo de aplicação localiza ou cria leads pelo nome dentro do funil, movimenta
para a etapa correspondente e mantém uma única nota de status:

```powershell
npm.cmd run db:migrate:kommo
npm.cmd run db:migrate:kommo-queue
npm.cmd run db:migrate:salesbots
npm.cmd run kommo:aplicar
```

Ao detectar uma mudança para as Fases 1, 2 ou 3, a sincronização aciona o
Salesbot de atualização da nova etapa. A Fase 4 recebe apenas o bot de
conclusão. Clientes que permanecem nas Fases 1, 2 ou 3 recebem o Salesbot de
lembrete a cada ciclo completo de 30 dias, contado desde a entrada na etapa.
Uma nova mudança reinicia essa contagem.

As etapas `Risco de Indeferimento` e `Iniciar Consulta` não disparam Salesbot.
Em especial, `Risco de Indeferimento` recebe somente a movimentação e a nota
para análise interna. `Exigência` aceita IDs opcionais para o bot de entrada e
para o lembrete de 30 dias; enquanto não configurados, nenhum bot é acionado
nessa etapa.

A decisão de movimentação segue estas proteções:

- processo finalizado, risco de indeferimento e exigência têm prioridade;
- uma fase automática válida tem prioridade sobre a fase manual;
- sem fase automática, uma fase manual válida pode avançar o lead;
- sem fase confiável, a etapa atual da Kommo é preservada;
- um lead novo sem fase confiável começa em `Iniciar Consulta`;
- regressões automáticas de fase são bloqueadas;
- etapas encerradas (`142` e `143`) nunca são reabertas automaticamente;
- etapas especiais não são abandonadas sem evidência especial ou finalização.

As consultas processuais são iniciadas às `08:00`. Salesbots somente são
enviados de segunda a sexta, das `09:00` até antes das `18:00`, no fuso de São
Paulo. Fora desse período, a movimentação e a nota são concluídas normalmente,
mas a mensagem fica agendada para as `09:00` do próximo dia útil. Mensagens
agendadas são canceladas se o lead mudar novamente de etapa antes do envio.

Quando o portal informa que a senha não corresponde a nenhum processo de
nacionalidade ativo, o resultado é tratado como encerramento confirmado: o
banco marca o processo como finalizado, a Kommo recebe a atualização para Fase
4, a nota é atualizada e o Salesbot de conclusão é enviado ou agendado.

Testes controlados selecionam o cadastro pelo ID numérico interno. O modo
legado aplica `btrim()` ao `id_registro`. Se o campo do código não aparecer, o
worker aguarda o DOM, procura seletores em paralelo e repete a consulta em uma
nova página antes de registrar a falha.

Falhas de hCaptcha também são repetidas em uma página nova. Cada página admite
até `captcha_max_retries` soluções do provedor. Se nenhuma funcionar ou o portal
rejeitar o desafio, a página é descartada, o sistema aguarda
`captcha_nova_pagina_delay_ms` e inicia outra rodada, respeitando
`consulta_max_tentativas`.

Por segurança, `KOMMO_SINCRONIZACAO_ATIVA` e
`KOMMO_SINCRONIZAR_AO_INICIAR` começam desabilitados.

## EasyPanel

O `Dockerfile` inicia um agendador diário. O worker só abre um ciclo completo quando o intervalo configurado de 15 dias estiver vencido.

Para abrir um ciclo já na implantação, use `EXECUTAR_AO_INICIAR=true` junto de
`FORCAR_CICLO_AO_INICIAR=true`. O forçamento vale apenas para a execução de
partida; as verificações diárias seguem respeitando o intervalo.

Consulte `EASYPANEL_DEPLOY.md` para o passo a passo de publicação, variáveis e acompanhamento.
