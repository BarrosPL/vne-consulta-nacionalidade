BEGIN;

ALTER TABLE public.nacionalidade_portuguesa
  ADD COLUMN IF NOT EXISTS fase_consulta_automatica text,
  ADD COLUMN IF NOT EXISTS posicao_fase integer,
  ADD COLUMN IF NOT EXISTS total_fases integer,
  ADD COLUMN IF NOT EXISTS data_fase date,
  ADD COLUMN IF NOT EXISTS possui_notificacao boolean,
  ADD COLUMN IF NOT EXISTS titulos_notificacoes text[],
  ADD COLUMN IF NOT EXISTS data_ultima_consulta timestamptz,
  ADD COLUMN IF NOT EXISTS observacao_consulta text;

CREATE TABLE IF NOT EXISTS public.historico_consultas_nacionalidade (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nacionalidade_id bigint NOT NULL
    REFERENCES public.nacionalidade_portuguesa(id) ON DELETE CASCADE,
  codigo_consulta varchar,
  sucesso boolean NOT NULL,
  fase text,
  posicao_fase integer,
  total_fases integer,
  data_fase date,
  possui_notificacao boolean,
  titulos_notificacoes text[],
  observacao text,
  consultado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT historico_posicao_fase_positiva
    CHECK (posicao_fase IS NULL OR posicao_fase > 0),
  CONSTRAINT historico_total_fases_positivo
    CHECK (total_fases IS NULL OR total_fases > 0),
  CONSTRAINT historico_posicao_valida
    CHECK (posicao_fase IS NULL OR total_fases IS NULL OR posicao_fase <= total_fases)
);

CREATE INDEX IF NOT EXISTS idx_historico_nacionalidade_consultado
  ON public.historico_consultas_nacionalidade
  (nacionalidade_id, consultado_em DESC);

CREATE INDEX IF NOT EXISTS idx_nacionalidade_reconsulta
  ON public.nacionalidade_portuguesa
  (data_ultima_consulta NULLS FIRST)
  WHERE codigo_consulta IS NOT NULL;

COMMIT;
