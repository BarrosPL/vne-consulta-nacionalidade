BEGIN;

ALTER TABLE public.disparos_salesbot_nacionalidade
  ADD COLUMN IF NOT EXISTS disparar_apos timestamptz;

ALTER TABLE public.disparos_salesbot_nacionalidade
  DROP CONSTRAINT IF EXISTS disparos_salesbot_nacionalidade_status_disparo_check;

ALTER TABLE public.disparos_salesbot_nacionalidade
  ADD CONSTRAINT disparos_salesbot_nacionalidade_status_disparo_check
  CHECK (status_disparo IN ('agendado', 'processando', 'sucesso', 'erro', 'cancelado'));

CREATE INDEX IF NOT EXISTS idx_salesbot_agendados
  ON public.disparos_salesbot_nacionalidade (disparar_apos, id)
  WHERE status_disparo = 'agendado';

COMMIT;
