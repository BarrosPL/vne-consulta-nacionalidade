-- Desativacao da integracao com o Kommo.
--
-- Cancela os Salesbots que ficaram na fila aguardando a janela comercial, para
-- que nenhuma mensagem antiga seja enviada caso a integracao seja reativada no
-- futuro. O historico de disparos ja concluidos ('sucesso') e preservado.
--
-- A migracao e idempotente: uma segunda execucao nao encontra mais registros
-- em 'agendado' e nao altera nada.

BEGIN;

UPDATE public.disparos_salesbot_nacionalidade
   SET status_disparo = 'cancelado',
       disparar_apos = NULL,
       erro = 'Integracao Kommo desativada: disparo cancelado pela migracao 010',
       ultima_tentativa_em = now()
 WHERE status_disparo = 'agendado';

COMMIT;
