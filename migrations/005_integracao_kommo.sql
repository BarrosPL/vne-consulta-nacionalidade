BEGIN;

CREATE TABLE IF NOT EXISTS public.sincronizacao_crm_nacionalidade (
  nacionalidade_id bigint PRIMARY KEY
    REFERENCES public.nacionalidade_portuguesa(id) ON DELETE CASCADE,
  crm_lead_id bigint,
  fase_sincronizada text,
  posicao_fase_sincronizada integer,
  status_id_sincronizado bigint,
  sincronizado_em timestamptz,
  ultima_tentativa_em timestamptz,
  status_ultima_tentativa varchar,
  erro_ultima_tentativa text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sincronizacao_crm_nacionalidade
  ADD COLUMN IF NOT EXISTS crm_nota_status_id bigint,
  ADD COLUMN IF NOT EXISTS conteudo_nota_hash varchar,
  ADD COLUMN IF NOT EXISTS lead_criado_pelo_sistema boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS criado_no_kommo_em timestamptz,
  ADD COLUMN IF NOT EXISTS nota_atualizada_em timestamptz,
  ADD COLUMN IF NOT EXISTS sincronizacao_final_concluida boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS motivo_movimentacao text;

CREATE INDEX IF NOT EXISTS idx_sincronizacao_crm_lead
  ON public.sincronizacao_crm_nacionalidade (crm_lead_id)
  WHERE crm_lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sincronizacao_crm_pendencias
  ON public.sincronizacao_crm_nacionalidade
  (status_ultima_tentativa, ultima_tentativa_em);

COMMIT;
