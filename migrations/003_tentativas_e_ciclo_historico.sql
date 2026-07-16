BEGIN;

ALTER TABLE public.nacionalidade_portuguesa
  ADD COLUMN IF NOT EXISTS data_ultima_tentativa timestamptz,
  ADD COLUMN IF NOT EXISTS status_ultima_tentativa varchar,
  ADD COLUMN IF NOT EXISTS erro_ultima_tentativa text;

ALTER TABLE public.historico_consultas_nacionalidade
  ADD COLUMN IF NOT EXISTS ciclo_id bigint
    REFERENCES public.ciclos_consulta_nacionalidade(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_historico_ciclo
  ON public.historico_consultas_nacionalidade (ciclo_id, consultado_em);

UPDATE public.nacionalidade_portuguesa
   SET data_ultima_tentativa = data_ultima_consulta,
       status_ultima_tentativa = CASE
         WHEN observacao_consulta LIKE 'Erro%' THEN 'erro'
         WHEN data_ultima_consulta IS NOT NULL THEN 'sucesso'
       END,
       erro_ultima_tentativa = CASE
         WHEN observacao_consulta LIKE 'Erro%' THEN observacao_consulta
       END
 WHERE data_ultima_tentativa IS NULL
   AND data_ultima_consulta IS NOT NULL;

UPDATE public.nacionalidade_portuguesa n
   SET data_ultima_consulta = h.consultado_em,
       observacao_consulta = h.observacao
  FROM (
    SELECT DISTINCT ON (nacionalidade_id)
           nacionalidade_id, consultado_em, observacao
      FROM public.historico_consultas_nacionalidade
     WHERE sucesso
     ORDER BY nacionalidade_id, consultado_em DESC
  ) h
 WHERE n.id = h.nacionalidade_id;

UPDATE public.nacionalidade_portuguesa n
   SET data_ultima_consulta = NULL,
       observacao_consulta = NULL
 WHERE n.fase_consulta_automatica IS NULL
   AND EXISTS (
     SELECT 1
       FROM public.historico_consultas_nacionalidade h
      WHERE h.nacionalidade_id = n.id
        AND NOT h.sucesso
   )
   AND NOT EXISTS (
     SELECT 1
       FROM public.historico_consultas_nacionalidade h
      WHERE h.nacionalidade_id = n.id
        AND h.sucesso
   );

COMMIT;
