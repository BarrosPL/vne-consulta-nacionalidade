BEGIN;

CREATE TABLE IF NOT EXISTS public.ciclos_consulta_nacionalidade (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status varchar NOT NULL,
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz,
  proxima_execucao_em timestamptz,
  codigos_selecionados integer NOT NULL DEFAULT 0,
  registros_selecionados integer NOT NULL DEFAULT 0,
  sucessos integer NOT NULL DEFAULT 0,
  erros integer NOT NULL DEFAULT 0,
  ignorados integer NOT NULL DEFAULT 0,
  detalhes_erros jsonb NOT NULL DEFAULT '{}'::jsonb,
  observacao text,
  CONSTRAINT ciclos_status_valido CHECK (
    status IN ('em_andamento', 'concluido', 'concluido_com_erros', 'interrompido')
  )
);

CREATE INDEX IF NOT EXISTS idx_ciclos_consulta_status_inicio
  ON public.ciclos_consulta_nacionalidade (status, iniciado_em DESC);

CREATE INDEX IF NOT EXISTS idx_ciclos_consulta_finalizado
  ON public.ciclos_consulta_nacionalidade (finalizado_em DESC)
  WHERE status IN ('concluido', 'concluido_com_erros');

COMMIT;
