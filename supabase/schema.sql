-- ==============================================================================
-- Schema: Tabela Central de Vagas (Jobs) - QueroVagas & JobsFinder
-- ==============================================================================

-- 1. Criação da tabela de vagas
CREATE TABLE IF NOT EXISTS public.jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL,
  work_model TEXT DEFAULT 'NAO_INFORMADO',
  salary TEXT,
  contract_type TEXT DEFAULT 'CLT',
  seniority_level TEXT DEFAULT 'NAO_INFORMADO',
  url TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  stack TEXT[] DEFAULT '{}',
  description TEXT,
  is_tech BOOLEAN DEFAULT true,
  scraped_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

-- 2. Índices de alta performance para filtros e ordenação no portal
CREATE INDEX IF NOT EXISTS idx_jobs_is_tech ON public.jobs (is_tech);
CREATE INDEX IF NOT EXISTS idx_jobs_scraped_at ON public.jobs (scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_seniority ON public.jobs (seniority_level);
CREATE INDEX IF NOT EXISTS idx_jobs_work_model ON public.jobs (work_model);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON public.jobs (source);

-- 3. Habilitação de Segurança em Nível de Linha (Row Level Security - RLS)
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

-- Política 1: Leitura pública (anon e autenticados) para vagas ativas de TI
DROP POLICY IF EXISTS "Permitir leitura publica de vagas tech" ON public.jobs;
CREATE POLICY "Permitir leitura publica de vagas tech"
  ON public.jobs
  FOR SELECT
  TO anon, authenticated
  USING (is_tech = true);

-- Política 2: Acesso irrestrito de escrita para o serviço de crawler (service_role)
DROP POLICY IF EXISTS "Permitir escrita pelo crawler" ON public.jobs;
CREATE POLICY "Permitir escrita pelo crawler"
  ON public.jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ==============================================================================
-- Schema: Tabela Central de Empresas Monitoradas (public.companies)
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

CREATE INDEX IF NOT EXISTS idx_companies_enabled ON public.companies (enabled);
CREATE INDEX IF NOT EXISTS idx_companies_ats ON public.companies (ats);
CREATE INDEX IF NOT EXISTS idx_companies_health_status ON public.companies (health_status);
CREATE INDEX IF NOT EXISTS idx_companies_slug ON public.companies (slug);
CREATE INDEX IF NOT EXISTS idx_companies_status ON public.companies (status);

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

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Permitir leitura publica de companies" ON public.companies;
CREATE POLICY "Permitir leitura publica de companies"
  ON public.companies
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "Permitir gestao pelo service_role" ON public.companies;
CREATE POLICY "Permitir gestao pelo service_role"
  ON public.companies
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
