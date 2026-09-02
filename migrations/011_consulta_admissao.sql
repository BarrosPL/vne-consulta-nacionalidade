BEGIN;

-- Separa o ciclo completo (percorre toda a base a cada POSTGRES_CICLO_DIAS) da
-- consulta de admissao (atende cadastros novos que ainda nunca tiveram
-- resultado, sem esperar o vencimento do ciclo global).
--
-- A coluna e obrigatoria porque o vencimento do ciclo e calculado a partir do
-- ultimo ciclo concluido. Sem a separacao, cada admissao concluida reiniciaria
-- a contagem de 15 dias e o ciclo completo nunca mais venceria.

ALTER TABLE public.ciclos_consulta_nacionalidade
  ADD COLUMN IF NOT EXISTS tipo varchar NOT NULL DEFAULT 'completo';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.ciclos_consulta_nacionalidade'::regclass
       AND conname = 'ciclos_tipo_valido'
  ) THEN
    ALTER TABLE public.ciclos_consulta_nacionalidade
      ADD CONSTRAINT ciclos_tipo_valido CHECK (tipo IN ('completo', 'admissao'));
  END IF;
END
$$;

-- Ciclos anteriores a esta migracao sao todos completos.
UPDATE public.ciclos_consulta_nacionalidade
   SET tipo = 'completo'
 WHERE tipo IS NULL;

-- Usado para localizar o ultimo ciclo completo concluido.
CREATE INDEX IF NOT EXISTS idx_ciclos_consulta_tipo_finalizado
  ON public.ciclos_consulta_nacionalidade (tipo, finalizado_em DESC)
  WHERE status IN ('concluido', 'concluido_com_erros');

-- Acelera a selecao de admissao: cadastros elegiveis que nunca produziram fase.
CREATE INDEX IF NOT EXISTS idx_nacionalidade_admissao
  ON public.nacionalidade_portuguesa (data_ultima_tentativa NULLS FIRST)
  WHERE fase_consulta_automatica IS NULL
    AND ativo_na_planilha
    AND NOT registro_duplicado
    AND NOT processo_finalizado;

COMMIT;
