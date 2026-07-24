BEGIN;

ALTER TABLE public.sincronizacao_crm_nacionalidade
  ADD COLUMN IF NOT EXISTS etapa_entrou_em timestamptz,
  ADD COLUMN IF NOT EXISTS salesbot_ultimo_disparo_em timestamptz;

UPDATE public.sincronizacao_crm_nacionalidade
   SET etapa_entrou_em = coalesce(sincronizado_em, criado_em, now())
 WHERE etapa_entrou_em IS NULL
   AND status_id_sincronizado IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.disparos_salesbot_nacionalidade (
  id bigserial PRIMARY KEY,
  nacionalidade_id bigint NOT NULL
    REFERENCES public.nacionalidade_portuguesa(id) ON DELETE CASCADE,
  crm_lead_id bigint NOT NULL,
  status_id bigint NOT NULL,
  salesbot_id bigint NOT NULL,
  tipo varchar(30) NOT NULL
    CHECK (tipo IN ('mudanca_fase', 'lembrete_30_dias')),
  chave_idempotencia varchar(180) NOT NULL UNIQUE,
  ciclo_lembrete integer,
  etapa_entrou_em timestamptz NOT NULL,
  status_disparo varchar(20) NOT NULL
    CHECK (status_disparo IN ('processando', 'sucesso', 'erro')),
  http_status integer,
  tentativas integer NOT NULL DEFAULT 1,
  erro text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  ultima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  disparado_em timestamptz
);

CREATE INDEX IF NOT EXISTS idx_salesbot_lembretes
  ON public.disparos_salesbot_nacionalidade
  (nacionalidade_id, status_id, etapa_entrou_em, ciclo_lembrete)
  WHERE tipo = 'lembrete_30_dias';

CREATE INDEX IF NOT EXISTS idx_salesbot_status
  ON public.disparos_salesbot_nacionalidade
  (status_disparo, ultima_tentativa_em);

COMMIT;
