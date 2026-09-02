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

## Integração com Kommo (reativada)

A integração está **ligada**: `KOMMO_INTEGRACAO_HABILITADA=true`. O sistema
volta a movimentar o lead entre as etapas conforme a fase identificada e a
disparar Salesbots.

A nota de status ficou **desligada** por `KOMMO_NOTA_HABILITADA=false`, porque
os mesmos dados agora vão para os campos personalizados do lead. Com a nota
desligada, o ID e o hash já gravados são preservados: nada é escrito no Kommo e
nada é sobrescrito no banco. Para voltar a ter a nota, defina
`KOMMO_NOTA_HABILITADA=true`.

A trava mestre continua valendo para todos os caminhos de escrita e, quando
`false`, desliga movimentação, nota e Salesbot de uma vez:

- o agendador não inicia o ciclo do Kommo, mesmo com `KOMMO_SINCRONIZACAO_ATIVA=true`;
- `npm run kommo:aplicar` e `npm run kommo:diagnostico` encerram com aviso;
- `scripts/testar_salesbot.js --aplicar` recusa o disparo manual;
- `npm run teste:fluxo:10` pula a etapa de Kommo e a marca como `ignorado`.

Se precisar desligar de novo, cancele os Salesbots que ficarem na fila
aguardando a janela comercial:

```powershell
npm.cmd run db:migrate:desativar-kommo
```

**Atenção na primeira execução após a reativação.** Os lembretes de 30 dias são
contados a partir de `etapa_entrou_em`, que ficou congelado durante o período
desligado. Rode sempre o diagnóstico antes de aplicar, para ver quantos
lembretes estão vencidos:

```powershell
npm.cmd run kommo:diagnostico
```

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

## Consulta de admissao

O ciclo completo e global e roda a cada 15 dias. Para que um cliente novo nao
espere ate 15 dias pela primeira consulta, a verificacao diaria das 08:00 faz
uma passagem curta de admissao quando o ciclo ainda nao venceu.

A admissao seleciona apenas cadastros elegiveis que ainda nao produziram
nenhuma fase, com limite proprio:

```env
POSTGRES_ADMISSAO_ATIVA=true
POSTGRES_ADMISSAO_LIMITE=25
POSTGRES_ADMISSAO_REINTERVALO_HORAS=24
POSTGRES_ADMISSAO_MAX_TENTATIVAS=5
```

Um cadastro que falha e tentado novamente a cada 24 horas ate o teto de
tentativas; depois disso ele aguarda o proximo ciclo completo. Isso impede que
um codigo invalido seja consultado indefinidamente.

A admissao **nunca** reinicia a contagem do ciclo global. A coluna `tipo` em
`ciclos_consulta_nacionalidade` separa `completo` de `admissao`, e somente os
ciclos completos definem o proximo vencimento.

```powershell
npm.cmd run db:migrate:admissao
```

## Campos personalizados no Kommo

Os resultados da consulta sao gravados em campos personalizados do lead, no
lugar da nota. Essa escrita tem trava propria e independente da trava mestre:

```env
KOMMO_CAMPOS_HABILITADO=true
KOMMO_CAMPOS_ATIVO=true
KOMMO_CAMPOS_INTERVALO_MINUTOS=30
KOMMO_CAMPOS_LIMITE_POR_EXECUCAO=100
```

`KOMMO_CAMPOS_HABILITADO` libera **somente** o preenchimento de campos. Nenhuma
movimentacao de etapa, nota ou Salesbot acontece por esse caminho: isso
continua governado apenas por `KOMMO_INTEGRACAO_HABILITADA`, que segue `false`.

Mapeamento aplicado:

| Campo no Kommo | ID | Origem no banco |
|---|---:|---|
| Fase Processual | 2990113 | `fase_consulta_automatica` |
| Posicao da Fase | 2990115 | `posicao_fase` |
| Total de Fases | 2990117 | `total_fases` |
| Data da Fase | 2990119 | `data_fase` |
| Ultima Consulta CRC | 2990121 | `data_ultima_consulta` |
| Possui Notificacao | 2990123 | `possui_notificacao` |
| Resumo de Notificacoes | 2990125 | `titulos_notificacoes` |
| Origem da Sincronizacao | 2990127 | `vne:nacionalidade:<id>` |
| Codigo CRC | 2990129 | `codigo_consulta` |
| N do Processo | 2990131 | `numero_processo` |

Um campo sem valor conhecido nao e enviado, para nunca apagar um dado
preenchido manualmente. O modulo nao cria leads: sem `crm_lead_id` conhecido, o
cadastro e apenas reportado como `sem_lead`.

```powershell
npm.cmd run db:migrate:campos-kommo
npm.cmd run campos:diagnostico
npm.cmd run campos:aplicar
```

O agendador tambem dispara essa rotina logo apos cada execucao do worker de
consulta, para que um resultado novo chegue ao CRM sem esperar o intervalo.

## EasyPanel

O `Dockerfile` inicia um agendador diário. O worker só abre um ciclo completo quando o intervalo configurado de 15 dias estiver vencido.

Para abrir um ciclo já na implantação, use `EXECUTAR_AO_INICIAR=true` junto de
`FORCAR_CICLO_AO_INICIAR=true`. O forçamento vale apenas para a execução de
partida; as verificações diárias seguem respeitando o intervalo.

Consulte `EASYPANEL_DEPLOY.md` para o passo a passo de publicação, variáveis e acompanhamento.
