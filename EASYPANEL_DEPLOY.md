# Deploy no EasyPanel

## Modelo de execução

O contêiner permanece ativo como agendador. Diariamente, no horário configurado, ele inicia uma verificação. O PostgreSQL decide se o ciclo de 15 dias está vencido:

- ciclo não vencido: encerra a verificação sem abrir o navegador;
- ciclo vencido: consulta todos os códigos distintos no mesmo lote;
- reinício ou segunda réplica: a trava PostgreSQL impede concorrência;
- cada ciclo fica registrado em `public.ciclos_consulta_nacionalidade`.

O ciclo cobre todos os registros com `codigo_consulta`. Registros sem código não podem ser consultados no portal.

## Serviço

Criar um serviço a partir do repositório usando o `Dockerfile` da raiz.

- comando da imagem: `npm run scheduler`;
- réplicas: `1`;
- domínio público: não necessário;
- porta pública: não necessária;
- memória inicial recomendada: 2 GB;
- timezone: `America/Sao_Paulo`.

## Variáveis de ambiente

Cadastrar como segredos no EasyPanel:

```env
DATABASE_URL=postgresql://USUARIO:SENHA@HOST:PORTA/BANCO
TWOCAPTCHA_API_KEY=...
GOOGLE_SERVICE_ACCOUNT_JSON=...
```

Cadastrar como configuração:

```env
TZ=America/Sao_Paulo
AGENDADOR_HORA=8
AGENDADOR_MINUTO=0
EXECUTAR_AO_INICIAR=true
POSTGRES_CICLO_DIAS=15
POSTGRES_LIMITE=1000
GOOGLE_SHEET_ID=10YNu_c-TGiSpb2QwfWDdQgQYuvXYXqwreCmxRETamFs
GOOGLE_SHEET_NAME=Andamentos
SINCRONIZACAO_ATIVA=true
SINCRONIZACAO_INTERVALO_MINUTOS=10
SINCRONIZAR_AO_INICIAR=true
KOMMO_BASE_URL=https://vocenaeuropa.kommo.com
KOMMO_ACCESS_TOKEN=...
KOMMO_PIPELINE_ID=8322487
KOMMO_STATUS_INICIAR_CONSULTA=106133608
KOMMO_STATUS_FASE_1=106133612
KOMMO_STATUS_FASE_2=100204688
KOMMO_STATUS_FASE_3=100204696
KOMMO_STATUS_FASE_4=100204712
KOMMO_STATUS_EXIGENCIA=76490168
KOMMO_STATUS_RISCO_INDEFERIMENTO=105756056
KOMMO_INTEGRACAO_HABILITADA=false
KOMMO_SINCRONIZACAO_ATIVA=false
KOMMO_INTERVALO_MINUTOS=15
KOMMO_REQUISICOES_POR_SEGUNDO=4
KOMMO_SALESBOT_LEMBRETE_DIAS=30
KOMMO_SALESBOT_LIMITE_POR_EXECUCAO=100
KOMMO_SALESBOT_FASE_1=62867
KOMMO_SALESBOT_LEMBRETE_FASE_1=62869
KOMMO_SALESBOT_FASE_2=62929
KOMMO_SALESBOT_LEMBRETE_FASE_2=62931
KOMMO_SALESBOT_FASE_3=62871
KOMMO_SALESBOT_LEMBRETE_FASE_3=62873
KOMMO_SALESBOT_FASE_4=62875
KOMMO_SALESBOT_EXIGENCIA=
KOMMO_SALESBOT_LEMBRETE_EXIGENCIA=
KOMMO_SALESBOT_FUSO=America/Sao_Paulo
KOMMO_SINCRONIZAR_AO_INICIAR=false
```

## Integração com o Kommo desativada

`KOMMO_INTEGRACAO_HABILITADA=false` é a trava mestre e desliga movimentação de
etapa, nota e Salesbot. Ela tem precedência sobre `KOMMO_SINCRONIZACAO_ATIVA`:
mesmo que essa variável esteja em `true`, o agendador não inicia o ciclo do
Kommo e registra no log:

```text
[kommo] Integracao desativada. Ignorado: ciclo automatico do Kommo.
```

Ao desativar, aplique uma vez para cancelar os Salesbots que ficaram na fila
aguardando a janela comercial:

```bash
npm run db:migrate:desativar-kommo
```

As variáveis `KOMMO_*` restantes podem permanecer cadastradas; elas só voltam a
ter efeito quando a trava for reativada. O relatório
`RELATORIO_AUDITORIA_KOMMO` deixa de ser emitido enquanto isso.

Após publicar a versão que contém a fila explícita do Kommo, aplique uma vez:

```bash
npm run db:migrate:kommo-queue
npm run db:migrate:salesbots
npm run db:migrate:salesbot-window
```

A migração de Salesbots registra a entrada em cada etapa e o histórico
idempotente dos disparos. Os lembretes usam ciclos de 30 dias, mesmo que o nome
de algum bot no Kommo ainda mencione 20 dias. `Risco de Indeferimento` nunca
aciona Salesbot.

`KOMMO_SALESBOT_EXIGENCIA` é opcional e aciona o bot quando o processo entra
em Exigência. `KOMMO_SALESBOT_LEMBRETE_EXIGENCIA` também é opcional; quando
preenchido, usa os mesmos ciclos de 30 dias. Variáveis vazias desabilitam esses
disparos.

As consultas processuais começam diariamente às `08:00`. Movimentações e
notas da Kommo podem ocorrer a qualquer hora, mas os Salesbots somente são
enviados de segunda a sexta, das `09:00` até antes das `18:00`, no fuso
`America/Sao_Paulo`. Fora da janela, o disparo fica persistido para as `09:00`
do próximo dia útil. Se a etapa mudar antes do envio, a mensagem antiga é
cancelada.

Essa migração coloca os processos ativos e principais na fila inicial. O
agendador consumirá a fila em lotes definidos por
`KOMMO_LIMITE_POR_EXECUCAO`.

O limite padrão de quatro requisições por segundo mantém margem abaixo do
limite operacional do Kommo. O controle se aplica a buscas, leituras,
movimentações e notas. Respostas HTTP 429 respeitam o cabeçalho `Retry-After`
antes de uma nova tentativa.

`EXECUTAR_AO_INICIAR=true` faz uma verificação no deploy ou reinício. Isso não força um novo ciclo: se os 15 dias ainda não venceram, o banco encerra a verificação sem processar registros.

Não cadastrar `CAPSOLVER_API_KEY`, pois o projeto usa exclusivamente 2Captcha.

## Primeiro deploy

1. Fazer backup do PostgreSQL.
2. Confirmar que as migrações `001` e `002` foram aplicadas.
3. Publicar o serviço com uma réplica.
4. Conferir no log a próxima verificação agendada.
5. Manter `EXECUTAR_AO_INICIAR=false` se ainda não quiser iniciar o primeiro ciclo.
6. Quando estiver pronto, alterar para `true` e reiniciar uma vez.
7. Acompanhar os primeiros códigos e o saldo do 2Captcha.
8. Ao final, conferir o resumo e a tabela de ciclos.

## Consultas de acompanhamento

Último ciclo:

```sql
SELECT *
FROM public.ciclos_consulta_nacionalidade
ORDER BY id DESC
LIMIT 1;
```

Progresso do ciclo atual:

```sql
SELECT
  count(*) FILTER (WHERE sucesso) AS sucessos,
  count(*) FILTER (WHERE NOT sucesso) AS erros
FROM public.historico_consultas_nacionalidade
WHERE consultado_em >= (
  SELECT iniciado_em
  FROM public.ciclos_consulta_nacionalidade
  ORDER BY id DESC
  LIMIT 1
);
```

## Observações operacionais

- O lote atual possui aproximadamente 458 códigos distintos e pode durar várias horas.
- O intervalo padrão entre consultas é de 5 segundos.
- Uma falha individual é registrada e não interrompe o restante do lote.
- O último resultado válido não é apagado por uma falha posterior.
- Códigos duplicados são consultados uma vez e atualizam todos os registros relacionados.
- Não usar mais de uma réplica, embora a trava do banco ofereça uma segunda proteção.

## Auditoria nos logs

Ao final de cada ciclo completo de consultas, procure:

```text
========== RELATORIO_AUDITORIA_CICLO_CONSULTA ==========
```

O JSON seguinte contém o ciclo, totais, fases, finalizações e detalhes por
cliente. Cada lote do Kommo gera:

```text
========== RELATORIO_AUDITORIA_KOMMO ==========
```

Esse relatório contém criações, movimentações, etapas mantidas, notas e erros.
O histórico e os ciclos também permanecem registrados no PostgreSQL caso a
retenção dos logs do EasyPanel expire.
