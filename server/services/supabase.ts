import type { CompanyConfig, Job } from "../types.js";
import { LoggerService } from "./logger.js";

export interface SupabaseJobRow {
  id: string;
  title: string;
  company: string;
  location: string;
  work_model: string;
  salary: string | null;
  contract_type: string;
  seniority_level: string;
  url: string;
  source: string;
  stack: string[];
  description: string | null;
  is_tech: boolean;
  scraped_at: string;
}

export interface SupabaseCompanyRow {
  id: string;
  name: string;
  ats: string;
  slug: string;
  url: string;
  enabled: boolean;
  status?: string;
  health_status: string;
  failure_count: number;
  last_scraped_at: string | null;
  last_audited_at?: string | null;
  last_audit_status?: number | null;
  last_audit_error?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Cliente PostgREST ultraleve e sem dependências externas para sincronizar
 * vagas capturadas pelo crawler diretamente com a tabela `jobs` no Supabase.
 */
export class SupabaseSyncService {
  private static envLoaded = false;

  private static ensureEnvLoaded(): void {
    if (this.envLoaded) return;
    this.envLoaded = true;

    if (!process.env.SUPABASE_URL && typeof process.loadEnvFile === "function") {
      try {
        process.loadEnvFile();
      } catch {
        try {
          process.loadEnvFile("/app/.env");
        } catch {
          // Ignore
        }
      }
    }
  }

  private static getCredentials(): { url: string; key: string } | null {
    this.ensureEnvLoaded();
    const url = process.env.SUPABASE_URL?.trim();
    const key = (
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_KEY ||
      process.env.SUPABASE_ANON_KEY
    )?.trim();

    if (!url || !key) {
      return null;
    }

    return { url: url.replace(/\/+$/, ""), key };
  }

  public static isConfigured(): boolean {
    return this.getCredentials() !== null;
  }

  /**
   * Converte o modelo interno de `Job` no formato da tabela PostgreSQL do Supabase.
   */
  public static mapJobToRow(job: Job): SupabaseJobRow {
    return {
      id: job.id,
      title: job.title || "Vaga sem título",
      company: job.company || "Empresa não informada",
      location: job.location || "Brasil",
      work_model: job.workModel || "NAO_INFORMADO",
      salary: job.salary || null,
      contract_type: job.contractType || "CLT",
      seniority_level: job.seniorityLevel || "NAO_INFORMADO",
      url: job.url,
      source: job.source || "OUTRO",
      stack: Array.isArray(job.stack) ? job.stack : [],
      description: job.description || null,
      is_tech: job.isTech ?? true,
      scraped_at: job.scrapedAt || new Date().toISOString(),
    };
  }

  /**
   * Sincroniza uma única vaga com o Supabase (Upsert).
   * Execução segura e silenciosa: não lança erros não tratados para não interromper o robô.
   */
  public static async syncJob(job: Job): Promise<boolean> {
    const creds = this.getCredentials();
    if (!creds) {
      return false;
    }

    // Só sincroniza vagas confirmadas como Tech/TI
    if (job.isTech === false) {
      return false;
    }

    try {
      const row = this.mapJobToRow(job);
      
      const endpoint = `${creds.url}/rest/v1/jobs?on_conflict=url`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          apikey: creds.key,
          Authorization: `Bearer ${creds.key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify(row),
      });

      if (!response.ok) {
        const errorText = await response.text();
        LoggerService.warn(
          "STORAGE",
          "SUPABASE_SYNC_FAILED",
          `Falha ao sincronizar vaga ${job.id} com Supabase (${response.status}): ${errorText}`,
          { jobId: job.id, status: response.status }
        );
        return false;
      }

      return true;
    } catch (err) {
      LoggerService.warn(
        "STORAGE",
        "SUPABASE_SYNC_ERROR",
        `Erro de conexão ao sincronizar vaga com Supabase: ${err instanceof Error ? err.message : String(err)}`,
        { jobId: job.id }
      );
      return false;
    }
  }

  /**
   * Sincroniza um lote de vagas em uma única chamada HTTP (Upsert em massa).
   */
  public static async syncBatch(
    jobs: Job[]
  ): Promise<{ success: boolean; count: number; error?: string }> {
    const creds = this.getCredentials();
    if (!creds) {
      return {
        success: false,
        count: 0,
        error: "Supabase não configurado (SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes).",
      };
    }

    const techJobs = jobs.filter((j) => j.isTech !== false);
    if (techJobs.length === 0) {
      return { success: true, count: 0 };
    }

    try {
      
      
      // Deduplica em memória pela URL para evitar cardinalidade dupla no mesmo lote
      const uniqueByUrlMap = new Map<string, (typeof techJobs)[0]>();
      for (const job of techJobs) {
        if (job.url) {
          uniqueByUrlMap.set(job.url, job);
        } else {
          uniqueByUrlMap.set(job.id, job);
        }
      }
      const uniqueJobs = Array.from(uniqueByUrlMap.values());

      const rows = uniqueJobs.map((j) => this.mapJobToRow(j));
      const endpoint = `${creds.url}/rest/v1/jobs?on_conflict=url`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          apikey: creds.key,
          Authorization: `Bearer ${creds.key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify(rows),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          count: 0,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      return { success: true, count: rows.length };
    } catch (err) {
      return {
        success: false,
        count: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Consulta estatísticas do Radar Comunitário (`companies` e `company_suggestions`)
   * para o resumo semanal de domingo. Nunca lança exceção; se indisponível, retorna vazio.
   */
  public static async fetchCommunityRadarStats(since: Date): Promise<{
    monitoredCompaniesCount: number | null;
    newSuggestions: Array<{
      name: string;
      suggestedBy?: string | null;
      votesCount?: number | null;
      createdAt?: string | null;
    }>;
    topVotedSuggestions: Array<{
      name: string;
      suggestedBy?: string | null;
      votesCount?: number | null;
      createdAt?: string | null;
    }>;
  }> {
    const creds = this.getCredentials();
    if (!creds) {
      return {
        monitoredCompaniesCount: null,
        newSuggestions: [],
        topVotedSuggestions: [],
      };
    }

    const headers = {
      apikey: creds.key,
      Authorization: `Bearer ${creds.key}`,
      "Content-Type": "application/json",
    };

    let monitoredCompaniesCount: number | null = null;
    const newSuggestions: Array<{
      name: string;
      suggestedBy?: string | null;
      votesCount?: number | null;
      createdAt?: string | null;
    }> = [];
    const topVotedSuggestions: Array<{
      name: string;
      suggestedBy?: string | null;
      votesCount?: number | null;
      createdAt?: string | null;
    }> = [];

    try {
      const compRes = await fetch(
        `${creds.url}/rest/v1/companies?select=id&status=eq.MONITORED`,
        {
          method: "GET",
          headers: { ...headers, Prefer: "count=exact" },
        },
      );
      if (compRes.ok) {
        const range = compRes.headers.get("content-range");
        if (range && range.includes("/")) {
          const totalStr = range.split("/")[1];
          const parsed = Number.parseInt(totalStr, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            monitoredCompaniesCount = parsed;
          }
        }
        if (monitoredCompaniesCount === null) {
          const data = await compRes.json();
          if (Array.isArray(data) && data.length > 0) {
            monitoredCompaniesCount = data.length;
          }
        }
      }
    } catch {
      // Silencioso: omite se falhar
    }

    try {
      const sugRes = await fetch(
        `${creds.url}/rest/v1/company_suggestions?select=id,name,suggested_by,votes_count,created_at,status&order=votes_count.desc&limit=50`,
        {
          method: "GET",
          headers,
        },
      );
      if (sugRes.ok) {
        const rows = await sugRes.json();
        if (Array.isArray(rows)) {
          const cutoff = since.getTime();
          for (const r of rows) {
            if (!r || typeof r.name !== "string" || !r.name.trim()) continue;
            const item = {
              name: r.name.trim(),
              suggestedBy:
                typeof r.suggested_by === "string" ? r.suggested_by : null,
              votesCount:
                typeof r.votes_count === "number" ? r.votes_count : null,
              createdAt:
                typeof r.created_at === "string" ? r.created_at : null,
            };

            if (item.createdAt) {
              const createdTs = new Date(item.createdAt).getTime();
              if (!Number.isNaN(createdTs) && createdTs >= cutoff) {
                newSuggestions.push(item);
              }
            }

            if (
              r.status !== "MONITORED" &&
              typeof item.votesCount === "number" &&
              item.votesCount > 0 &&
              topVotedSuggestions.length < 3
            ) {
              topVotedSuggestions.push(item);
            }
          }
        }
      }
    } catch {
      // Silencioso: omite se falhar
    }

    return {
      monitoredCompaniesCount,
      newSuggestions,
      topVotedSuggestions,
    };
  }

  /**
   * Converte uma empresa configurada localmente para o formato da tabela `public.companies`.
   */
  public static mapCompanyToRow(ats: string, company: CompanyConfig): SupabaseCompanyRow {
    const cleanAts = ats.trim().toUpperCase();
    const cleanSlug = company.slug.trim().toLowerCase();
    const cleanUrl = (company.link || "").trim();

    let healthStatus = company.healthStatus || "HEALTHY";
    if (!company.healthStatus) {
      if (company.status === "broken_link") healthStatus = "BROKEN";
      else if (company.status === "unknown") healthStatus = "UNKNOWN";
      else healthStatus = "HEALTHY";
    }

    return {
      id: company.id || `comp-${cleanAts.toLowerCase()}-${cleanSlug}`,
      name: company.name.trim(),
      ats: cleanAts,
      slug: cleanSlug,
      url: cleanUrl,
      enabled: company.enabled !== false,
      status: "MONITORED",
      health_status: healthStatus,
      failure_count: typeof company.failureCount === "number" ? company.failureCount : 0,
      last_scraped_at: company.lastScrapedAt ?? null,
      last_audited_at: company.lastAuditedAt ?? null,
      last_audit_status: company.lastAuditStatus ?? null,
      last_audit_error: company.lastAuditError ?? null,
    };
  }

  /**
   * Converte uma linha da tabela `public.companies` no formato interno `CompanyConfig`.
   */
  public static mapRowToCompanyConfig(row: SupabaseCompanyRow): {
    ats: string;
    company: CompanyConfig;
  } {
    const rawHealth = (row.health_status || "HEALTHY").toUpperCase();
    const healthStatus: "HEALTHY" | "BROKEN" | "WARNING" | "UNKNOWN" =
      rawHealth === "BROKEN"
        ? "BROKEN"
        : rawHealth === "WARNING"
          ? "WARNING"
          : rawHealth === "UNKNOWN"
            ? "UNKNOWN"
            : "HEALTHY";

    const status: "healthy" | "broken_link" | "unknown" =
      healthStatus === "BROKEN"
        ? "broken_link"
        : healthStatus === "UNKNOWN"
          ? "unknown"
          : "healthy";

    return {
      ats: (row.ats || "OUTRO").trim().toUpperCase(),
      company: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        link: row.url || (row as unknown as { career_url?: string }).career_url || "",
        enabled: row.enabled !== false,
        status,
        healthStatus,
        failureCount: typeof row.failure_count === "number" ? row.failure_count : 0,
        lastScrapedAt: row.last_scraped_at ?? null,
        lastAuditedAt: row.last_audited_at ?? undefined,
        lastAuditStatus: row.last_audit_status ?? undefined,
        lastAuditError: row.last_audit_error ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    };
  }

  /**
   * Carrega todas as empresas da tabela `public.companies` no Supabase em lote.
   */
  public static async fetchCompanies(): Promise<{
    success: boolean;
    rows: SupabaseCompanyRow[];
    error?: string;
  }> {
    const creds = this.getCredentials();
    if (!creds) {
      return {
        success: false,
        rows: [],
        error: "Supabase não configurado (SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes).",
      };
    }

    try {
      const allRows: SupabaseCompanyRow[] = [];
      const pageSize = 1000;
      let offset = 0;

      while (true) {
        const endpoint = `${creds.url}/rest/v1/companies?select=*&order=ats.asc,name.asc&limit=${pageSize}&offset=${offset}`;
        const response = await fetch(endpoint, {
          method: "GET",
          headers: {
            apikey: creds.key,
            Authorization: `Bearer ${creds.key}`,
            "Content-Type": "application/json",
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            success: false,
            rows: [],
            error: `HTTP ${response.status}: ${errorText}`,
          };
        }

        const page = (await response.json()) as SupabaseCompanyRow[];
        if (!Array.isArray(page) || page.length === 0) {
          break;
        }

        allRows.push(...page);
        if (page.length < pageSize) {
          break;
        }
        offset += pageSize;
      }

      return { success: true, rows: allRows };
    } catch (err) {
      return {
        success: false,
        rows: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Faz upsert de um lote de empresas na tabela `public.companies` do Supabase.
   */
  public static async syncCompaniesBatch(
    rows: SupabaseCompanyRow[],
  ): Promise<{ success: boolean; count: number; error?: string }> {
    const creds = this.getCredentials();
    if (!creds) {
      return {
        success: false,
        count: 0,
        error: "Supabase não configurado (SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes).",
      };
    }

    if (rows.length === 0) {
      return { success: true, count: 0 };
    }

    try {
      // Deduplica por (ats, slug) e por url para evitar violação de constraints no mesmo lote
      const bySlugMap = new Map<string, SupabaseCompanyRow>();
      const byUrlSet = new Set<string>();

      for (const row of rows) {
        const slugKey = `${row.ats.toUpperCase()}:${row.slug.toLowerCase()}`;
        let candidateUrl = row.url.trim();
        const normUrl = candidateUrl.toLowerCase();

        if (byUrlSet.has(normUrl) && !bySlugMap.has(slugKey)) {
          const sep = candidateUrl.includes("#") ? "-" : "#";
          candidateUrl = `${candidateUrl}${sep}${row.slug.toLowerCase()}`;
        }

        byUrlSet.add(candidateUrl.toLowerCase());
        bySlugMap.set(slugKey, { ...row, url: candidateUrl });
      }

      const uniqueRows = Array.from(bySlugMap.values());
      const endpoint = `${creds.url}/rest/v1/companies?on_conflict=ats,slug`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          apikey: creds.key,
          Authorization: `Bearer ${creds.key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify(uniqueRows),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          count: 0,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      return { success: true, count: uniqueRows.length };
    } catch (err) {
      return {
        success: false,
        count: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Atualiza atomicamente a telemetria de saúde de uma empresa no Supabase.
   */
  public static async updateCompanyTelemetry(
    ats: string,
    slug: string,
    telemetry: {
      enabled?: boolean;
      healthStatus?: "HEALTHY" | "BROKEN" | "WARNING" | "UNKNOWN";
      failureCount?: number;
      lastScrapedAt?: string;
      lastAuditedAt?: string;
      lastAuditStatus?: number;
      lastAuditError?: string | null;
    },
  ): Promise<boolean> {
    const creds = this.getCredentials();
    if (!creds) {
      return false;
    }

    const cleanAts = encodeURIComponent(ats.trim().toUpperCase());
    const cleanSlug = encodeURIComponent(slug.trim().toLowerCase());

    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (telemetry.enabled !== undefined) payload.enabled = telemetry.enabled;
    if (telemetry.healthStatus !== undefined) payload.health_status = telemetry.healthStatus;
    if (telemetry.failureCount !== undefined) payload.failure_count = telemetry.failureCount;
    if (telemetry.lastScrapedAt !== undefined) payload.last_scraped_at = telemetry.lastScrapedAt;
    if (telemetry.lastAuditedAt !== undefined) payload.last_audited_at = telemetry.lastAuditedAt;
    if (telemetry.lastAuditStatus !== undefined) payload.last_audit_status = telemetry.lastAuditStatus;
    if (telemetry.lastAuditError !== undefined) payload.last_audit_error = telemetry.lastAuditError;

    try {
      const endpoint = `${creds.url}/rest/v1/companies?ats=eq.${cleanAts}&slug=eq.${cleanSlug}`;
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: {
          apikey: creds.key,
          Authorization: `Bearer ${creds.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}

