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
AGENDADOR_HORA=2
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
KOMMO_SINCRONIZACAO_ATIVA=false
KOMMO_INTERVALO_MINUTOS=15
KOMMO_SINCRONIZAR_AO_INICIAR=false
```

Após publicar a versão que contém a fila explícita do Kommo, aplique uma vez:

```bash
npm run db:migrate:kommo-queue
```

Essa migração coloca os processos ativos e principais na fila inicial. O
agendador consumirá a fila em lotes definidos por
`KOMMO_LIMITE_POR_EXECUCAO`.

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
