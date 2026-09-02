BEGIN;

-- Controle da escrita de campos personalizados no Kommo.
--
-- Tabela propria, separada de sincronizacao_crm_nacionalidade, porque este
-- caminho e governado por outra trava (KOMMO_CAMPOS_HABILITADO) e nao envolve
-- movimentacao de etapa, nota nem Salesbot.

CREATE TABLE IF NOT EXISTS public.campos_kommo_nacionalidade (
  nacionalidade_id bigint PRIMARY KEY
    REFERENCES public.nacionalidade_portuguesa(id) ON DELETE CASCADE,
  crm_lead_id bigint,
  conteudo_hash varchar,
  sincronizado_em timestamptz,
  ultima_tentativa_em timestamptz,
  status_ultima_tentativa varchar,
  erro_ultima_tentativa text,
  tentativas integer NOT NULL DEFAULT 0,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campos_kommo_status_valido CHECK (
    status_ultima_tentativa IS NULL
    OR status_ultima_tentativa IN ('sucesso', 'erro', 'sem_lead', 'sem_dados')
  )
);

CREATE INDEX IF NOT EXISTS idx_campos_kommo_lead
  ON public.campos_kommo_nacionalidade (crm_lead_id)
  WHERE crm_lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_campos_kommo_pendencias
  ON public.campos_kommo_nacionalidade (status_ultima_tentativa, ultima_tentativa_em);

COMMIT;
