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

