-- ==============================================================================
-- Migration: Arquitetura Híbrida para Empresas Monitoradas (public.companies)
-- Issue: #19
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.companies (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  ats TEXT NOT NULL DEFAULT 'OUTRO',
  slug TEXT NOT NULL,
  url TEXT NOT NULL,
  career_url TEXT GENERATED ALWAYS AS (url) STORED,
  enabled BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'MONITORED',
  health_status TEXT NOT NULL DEFAULT 'HEALTHY',
  failure_count INTEGER NOT NULL DEFAULT 0,
  active_jobs_count INTEGER NOT NULL DEFAULT 0,
  has_tech_jobs BOOLEAN NOT NULL DEFAULT true,
  last_scraped_at TIMESTAMPTZ,
  last_audited_at TIMESTAMPTZ,
  last_audit_status INTEGER,
  last_audit_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT uq_companies_ats_slug UNIQUE (ats, slug),
  CONSTRAINT uq_companies_url UNIQUE (url)
);

-- Índices de alta performance para o Hot Cache, Auditor e Portal Web
CREATE INDEX IF NOT EXISTS idx_companies_enabled ON public.companies (enabled);
CREATE INDEX IF NOT EXISTS idx_companies_ats ON public.companies (ats);
CREATE INDEX IF NOT EXISTS idx_companies_health_status ON public.companies (health_status);
CREATE INDEX IF NOT EXISTS idx_companies_slug ON public.companies (slug);
CREATE INDEX IF NOT EXISTS idx_companies_status ON public.companies (status);

-- Trigger para atualização automática de updated_at
CREATE OR REPLACE FUNCTION public.set_companies_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_companies_updated_at ON public.companies;
CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON public.companies
  FOR EACH ROW
  EXECUTE FUNCTION public.set_companies_updated_at();

-- Habilitação de Row Level Security (RLS)
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

-- Política 1: Leitura pública (anon e authenticated) para consulta no Radar de Empresas
DROP POLICY IF EXISTS "Permitir leitura publica de companies" ON public.companies;
CREATE POLICY "Permitir leitura publica de companies"
  ON public.companies
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Política 2: Escrita e gestão completa via service_role (Crawler e Auditor)
DROP POLICY IF EXISTS "Permitir gestao pelo service_role" ON public.companies;
CREATE POLICY "Permitir gestao pelo service_role"
  ON public.companies
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
