BEGIN;

ALTER TABLE public.nacionalidade_portuguesa
  ADD COLUMN IF NOT EXISTS id_planilha uuid,
  ADD COLUMN IF NOT EXISTS ativo_na_planilha boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS removido_da_planilha_em timestamptz,
  ADD COLUMN IF NOT EXISTS processo_finalizado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS processo_finalizado_em timestamptz,
  ADD COLUMN IF NOT EXISTS motivo_finalizacao text,
  ADD COLUMN IF NOT EXISTS registro_duplicado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS registro_principal_id bigint
    REFERENCES public.nacionalidade_portuguesa(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS motivo_desativacao text,
  ADD COLUMN IF NOT EXISTS sincronizado_planilha_em timestamptz;

UPDATE public.nacionalidade_portuguesa
   SET id_planilha = gen_random_uuid()
 WHERE id_planilha IS NULL;

ALTER TABLE public.nacionalidade_portuguesa
  ALTER COLUMN id_planilha SET NOT NULL,
  ALTER COLUMN id_planilha SET DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS uq_nacionalidade_id_planilha
  ON public.nacionalidade_portuguesa (id_planilha);

UPDATE public.nacionalidade_portuguesa
   SET processo_finalizado = true,
       processo_finalizado_em = coalesce(
         processo_finalizado_em, data_ultima_consulta, aprovado::timestamptz, atualizado_em
       ),
       motivo_finalizacao = coalesce(motivo_finalizacao, 'status_manual:' || btrim(status))
 WHERE lower(translate(btrim(coalesce(status, '')), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc'))
       IN ('terminado', 'concluido', 'encerrado');

WITH classificados AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY btrim(codigo_consulta)
           ORDER BY
             (numero_processo IS NOT NULL AND btrim(numero_processo) <> '') DESC,
             (
               (cliente IS NOT NULL)::int +
               (numero_processo IS NOT NULL)::int +
               (data_entrada IS NOT NULL)::int +
               (parceria IS NOT NULL)::int +
               (status IS NOT NULL)::int +
               (conservatoria IS NOT NULL)::int +
               (aprovado IS NOT NULL)::int +
               (data_submissao IS NOT NULL)::int +
               (contato IS NOT NULL)::int +
               (email IS NOT NULL)::int +
               (google_drive IS NOT NULL)::int
             ) DESC,
             id
         ) AS principal_id
    FROM public.nacionalidade_portuguesa
   WHERE nullif(btrim(codigo_consulta), '') IS NOT NULL
)
UPDATE public.nacionalidade_portuguesa n
   SET registro_duplicado = (c.principal_id <> n.id),
       registro_principal_id = CASE WHEN c.principal_id <> n.id THEN c.principal_id END,
       motivo_desativacao = CASE
         WHEN c.principal_id <> n.id THEN 'codigo_consulta_duplicado'
         WHEN n.motivo_desativacao = 'codigo_consulta_duplicado' THEN NULL
         ELSE n.motivo_desativacao
       END
  FROM classificados c
 WHERE c.id = n.id;

CREATE INDEX IF NOT EXISTS idx_nacionalidade_elegibilidade
  ON public.nacionalidade_portuguesa (processo_finalizado, registro_duplicado, ativo_na_planilha, id)
  WHERE nullif(btrim(codigo_consulta), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nacionalidade_registro_principal
  ON public.nacionalidade_portuguesa (registro_principal_id)
  WHERE registro_principal_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.classificar_duplicata_nacionalidade()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  principal_id bigint;
BEGIN
  IF nullif(btrim(NEW.codigo_consulta), '') IS NULL THEN
    NEW.registro_duplicado := false;
    NEW.registro_principal_id := NULL;
    IF NEW.motivo_desativacao = 'codigo_consulta_duplicado' THEN
      NEW.motivo_desativacao := NULL;
    END IF;
    RETURN NEW;
  END IF;

  SELECT id
    INTO principal_id
    FROM public.nacionalidade_portuguesa
   WHERE id IS DISTINCT FROM NEW.id
     AND btrim(codigo_consulta) = btrim(NEW.codigo_consulta)
     AND NOT registro_duplicado
   ORDER BY ativo_na_planilha DESC, id
   LIMIT 1;

  IF principal_id IS NOT NULL THEN
    NEW.registro_duplicado := true;
    NEW.registro_principal_id := principal_id;
    NEW.motivo_desativacao := 'codigo_consulta_duplicado';
  ELSIF NEW.registro_duplicado AND NEW.motivo_desativacao = 'codigo_consulta_duplicado' THEN
    NEW.registro_duplicado := false;
    NEW.registro_principal_id := NULL;
    NEW.motivo_desativacao := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_classificar_duplicata_nacionalidade
  ON public.nacionalidade_portuguesa;
CREATE TRIGGER trg_classificar_duplicata_nacionalidade
BEFORE INSERT OR UPDATE OF codigo_consulta, ativo_na_planilha
ON public.nacionalidade_portuguesa
FOR EACH ROW
EXECUTE FUNCTION public.classificar_duplicata_nacionalidade();

CREATE TABLE IF NOT EXISTS public.sincronizacoes_planilha_nacionalidade (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status varchar NOT NULL,
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz,
  total_linhas integer NOT NULL DEFAULT 0,
  inseridos integer NOT NULL DEFAULT 0,
  atualizados integer NOT NULL DEFAULT 0,
  reativados integer NOT NULL DEFAULT 0,
  desativados integer NOT NULL DEFAULT 0,
  duplicados integer NOT NULL DEFAULT 0,
  observacao text,
  CONSTRAINT sincronizacoes_status_valido CHECK (
    status IN ('em_andamento', 'concluida', 'falhou', 'diagnostico')
  )
);

COMMIT;
