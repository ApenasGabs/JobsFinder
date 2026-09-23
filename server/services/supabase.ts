import type { Job } from "../types.js";
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
}

