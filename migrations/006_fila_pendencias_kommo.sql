BEGIN;

ALTER TABLE public.nacionalidade_portuguesa
  ADD COLUMN IF NOT EXISTS kommo_pendente boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS kommo_pendente_desde timestamptz,
  ADD COLUMN IF NOT EXISTS motivo_pendencia_kommo text,
  ADD COLUMN IF NOT EXISTS kommo_versao bigint NOT NULL DEFAULT 1;

UPDATE public.nacionalidade_portuguesa n
   SET kommo_pendente = (
         n.ativo_na_planilha
         AND NOT n.registro_duplicado
         AND (
           NOT n.processo_finalizado
           OR NOT coalesce(s.sincronizacao_final_concluida, false)
         )
       ),
       kommo_pendente_desde = CASE
         WHEN n.ativo_na_planilha
          AND NOT n.registro_duplicado
          AND (
            NOT n.processo_finalizado
            OR NOT coalesce(s.sincronizacao_final_concluida, false)
          )
         THEN coalesce(n.data_ultima_consulta, n.atualizado_em, now())
       END,
       motivo_pendencia_kommo = CASE
         WHEN n.ativo_na_planilha
          AND NOT n.registro_duplicado
          AND (
            NOT n.processo_finalizado
            OR NOT coalesce(s.sincronizacao_final_concluida, false)
          )
         THEN 'migracao_fila_kommo'
       END
  FROM (
    SELECT base.id,
           crm.nacionalidade_id,
           crm.sincronizacao_final_concluida
      FROM public.nacionalidade_portuguesa base
      LEFT JOIN public.sincronizacao_crm_nacionalidade crm
        ON crm.nacionalidade_id = base.id
  ) s
 WHERE s.id = n.id;

CREATE INDEX IF NOT EXISTS idx_nacionalidade_fila_kommo
  ON public.nacionalidade_portuguesa
  (processo_finalizado DESC, kommo_pendente_desde, id)
  WHERE kommo_pendente AND ativo_na_planilha AND NOT registro_duplicado;

CREATE OR REPLACE FUNCTION public.marcar_pendencia_kommo_nacionalidade()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  dados_relevantes_alterados boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.kommo_pendente := NEW.ativo_na_planilha AND NOT NEW.registro_duplicado;
    NEW.kommo_pendente_desde := CASE WHEN NEW.kommo_pendente THEN now() END;
    NEW.motivo_pendencia_kommo := CASE
      WHEN NEW.kommo_pendente THEN 'novo_registro'
    END;
    RETURN NEW;
  END IF;

  dados_relevantes_alterados :=
    ROW(
      OLD.cliente,
      OLD.status,
      OLD.anotacoes,
      OLD.fase_consulta_automatica,
      OLD.posicao_fase,
      OLD.total_fases,
      OLD.data_fase,
      OLD.possui_notificacao,
      OLD.titulos_notificacoes,
      OLD.data_ultima_consulta,
      OLD.processo_finalizado,
      OLD.ativo_na_planilha,
      OLD.registro_duplicado
    ) IS DISTINCT FROM ROW(
      NEW.cliente,
      NEW.status,
      NEW.anotacoes,
      NEW.fase_consulta_automatica,
      NEW.posicao_fase,
      NEW.total_fases,
      NEW.data_fase,
      NEW.possui_notificacao,
      NEW.titulos_notificacoes,
      NEW.data_ultima_consulta,
      NEW.processo_finalizado,
      NEW.ativo_na_planilha,
      NEW.registro_duplicado
    );

  IF dados_relevantes_alterados THEN
    NEW.kommo_versao := OLD.kommo_versao + 1;
  END IF;

  IF NOT NEW.ativo_na_planilha OR NEW.registro_duplicado THEN
    NEW.kommo_pendente := false;
    NEW.kommo_pendente_desde := NULL;
    NEW.motivo_pendencia_kommo := NULL;
  ELSIF dados_relevantes_alterados THEN
    NEW.kommo_pendente := true;
    NEW.kommo_pendente_desde := now();
    NEW.motivo_pendencia_kommo := CASE
      WHEN NOT OLD.ativo_na_planilha AND NEW.ativo_na_planilha THEN 'reativado_na_planilha'
      WHEN OLD.processo_finalizado IS DISTINCT FROM NEW.processo_finalizado
        AND NEW.processo_finalizado THEN 'processo_finalizado'
      WHEN OLD.data_ultima_consulta IS DISTINCT FROM NEW.data_ultima_consulta
        THEN 'resultado_consulta'
      ELSE 'dados_relevantes_alterados'
    END;
    NEW.atualizado_em := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_marcar_pendencia_kommo_nacionalidade
  ON public.nacionalidade_portuguesa;
CREATE TRIGGER trg_marcar_pendencia_kommo_nacionalidade
BEFORE INSERT OR UPDATE OF
  cliente,
  status,
  anotacoes,
  fase_consulta_automatica,
  posicao_fase,
  total_fases,
  data_fase,
  possui_notificacao,
  titulos_notificacoes,
  data_ultima_consulta,
  processo_finalizado,
  ativo_na_planilha,
  registro_duplicado
ON public.nacionalidade_portuguesa
FOR EACH ROW
EXECUTE FUNCTION public.marcar_pendencia_kommo_nacionalidade();

COMMIT;
