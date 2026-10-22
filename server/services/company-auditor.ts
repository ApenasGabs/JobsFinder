import { AppConfig, CompanyAuditReport, CompanyAuditResult, CompanyConfig } from "../types.js";
import { resilientFetch } from "../utils/fetch.js";
import { runWithConcurrency } from "../utils/pool.js";
import { ConfigService } from "./config.js";
import { LoggerService } from "./logger.js";

export type AtsPlatform = "GUPY" | "GREENHOUSE" | "LEVER" | "ASHBY" | "WORKABLE" | "INHIRE";

export interface VerifyResult {
  ok: boolean;
  httpStatus?: number;
  error?: string;
  message: string;
  jobsCount?: number;
  checkedUrl: string;
  durationMs: number;
}

export class CompanyAuditorService {
  private static lastReport: CompanyAuditReport | null = null;
  private static isAuditingNow = false;

  public static normalizeAts(ats: string): AtsPlatform | null {
    const upper = ats.trim().toUpperCase();
    if (["GUPY", "GREENHOUSE", "LEVER", "ASHBY", "WORKABLE", "INHIRE"].includes(upper)) {
      return upper as AtsPlatform;
    }
    return null;
  }

  public static getConfigKeyForAts(ats: AtsPlatform): keyof AppConfig {
    switch (ats) {
      case "GUPY":
        return "gupyCompanies";
      case "GREENHOUSE":
        return "greenhouseCompanies";
      case "LEVER":
        return "leverCompanies";
      case "ASHBY":
        return "ashbyCompanies";
      case "WORKABLE":
        return "workableCompanies";
      case "INHIRE":
        return "inhireCompanies";
    }
  }

  public static getEndpoint(ats: AtsPlatform, slug: string, link?: string): {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
  } {
    const cleanSlug = slug.trim().toLowerCase();
    const defaultHeaders = {
      Accept: "application/json, text/html, */*",
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    };

    switch (ats) {
      case "GUPY": {
        const portalUrl = link?.trim()
          ? link.replace(/\/$/, "")
          : `https://${cleanSlug}.gupy.io`;
        return {
          url: portalUrl,
          method: "GET",
          headers: defaultHeaders,
        };
      }
      case "GREENHOUSE":
        return {
          url: `https://boards-api.greenhouse.io/v1/boards/${cleanSlug}/jobs`,
          method: "GET",
          headers: defaultHeaders,
        };
      case "LEVER":
        return {
          url: `https://api.lever.co/v0/postings/${cleanSlug}?mode=json`,
          method: "GET",
          headers: defaultHeaders,
        };
      case "ASHBY":
        return {
          url: `https://api.ashbyhq.com/posting-api/job-board/${cleanSlug}`,
          method: "GET",
          headers: defaultHeaders,
        };
      case "WORKABLE":
        return {
          url: `https://apply.workable.com/api/v2/accounts/${cleanSlug}/jobs`,
          method: "POST",
          headers: {
            ...defaultHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        };
      case "INHIRE": {
        return {
          url: "https://api.inhire.app/job-posts/public/pages",
          method: "GET",
          headers: {
            ...defaultHeaders,
            "X-Tenant": cleanSlug,
            Origin: `https://${cleanSlug}.inhire.app`,
            Referer: `https://${cleanSlug}.inhire.app/`,
          },
        };
      }
    }
  }

  public static async verifySingle(
    atsInput: string,
    slugInput: string,
    linkInput?: string
  ): Promise<VerifyResult> {
    const ats = this.normalizeAts(atsInput);
    if (!ats) {
      return {
        ok: false,
        message: `Plataforma ATS inválida: "${atsInput}". Suportadas: GUPY, GREENHOUSE, LEVER, ASHBY, WORKABLE, INHIRE.`,
        checkedUrl: "",
        durationMs: 0,
      };
    }

    const start = Date.now();
    const endpoint = this.getEndpoint(ats, slugInput, linkInput);

    try {
      const response = await resilientFetch(endpoint.url, {
        method: endpoint.method,
        headers: endpoint.headers,
        body: endpoint.body,
        timeoutMs: 8000,
        maxRetries: 0,
        source: ats,
      });

      const durationMs = Date.now() - start;

      if (response.status === 404 || response.status === 410) {
        return {
          ok: false,
          httpStatus: response.status,
          error: `HTTP ${response.status} Not Found`,
          message: `Empresa não encontrada no ${ats} (HTTP ${response.status}). Verifique o slug ou se o portal foi migrado/desativado.`,
          checkedUrl: endpoint.url,
          durationMs,
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          httpStatus: response.status,
          error: `HTTP ${response.status}`,
          message: `O endpoint do ${ats} retornou HTTP ${response.status}.`,
          checkedUrl: endpoint.url,
          durationMs,
        };
      }

      let jobsCount: number | undefined;
      try {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await response.json();
          if (Array.isArray(data)) {
            jobsCount = data.length;
          } else if (Array.isArray(data?.jobs)) {
            jobsCount = data.jobs.length;
          } else if (Array.isArray(data?.jobsPage)) {
            jobsCount = data.jobsPage.length;
          } else if (Array.isArray(data?.results)) {
            jobsCount = data.results.length;
          } else if (typeof data?.total === "number") {
            jobsCount = data.total;
          }

          if (ats === "INHIRE" && (!data?.tenantName || jobsCount === 0)) {
            return {
              ok: false,
              httpStatus: 404,
              error: "Tenant inativo ou sem vagas",
              message: `Tenant "${slugInput}" no InHire não possui vagas ativas.`,
              checkedUrl: endpoint.url,
              durationMs,
            };
          }
        }
      } catch {
        // Ignora parsing se não for JSON puro
      }

      return {
        ok: true,
        httpStatus: response.status,
        message: `Empresa validada com sucesso no ${ats}!${
          jobsCount !== undefined ? ` (${jobsCount} vaga(s) encontrada(s))` : ""
        }`,
        jobsCount,
        checkedUrl: endpoint.url,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      return {
        ok: false,
        error: err.message || "Erro de conexão",
        message: `Falha ao conectar com ${endpoint.url}: ${err.message}`,
        checkedUrl: endpoint.url,
        durationMs,
      };
    }
  }

  public static async auditCompany(
    ats: AtsPlatform,
    company: CompanyConfig
  ): Promise<CompanyAuditResult> {
    const start = Date.now();
    const endpoint = this.getEndpoint(ats, company.slug, company.link);

    try {
      const response = await resilientFetch(endpoint.url, {
        method: endpoint.method,
        headers: endpoint.headers,
        body: endpoint.body,
        timeoutMs: 8000,
        maxRetries: 0,
        source: ats,
      });

      const durationMs = Date.now() - start;

      if (response.status === 404 || response.status === 410) {
        return {
          ats,
          name: company.name,
          slug: company.slug,
          link: company.link,
          status: "BROKEN",
          httpStatus: response.status,
          error: `HTTP ${response.status} - Portal ou endpoint não encontrado`,
          checkedUrl: endpoint.url,
          durationMs,
        };
      }

      if (response.status >= 500) {
        return {
          ats,
          name: company.name,
          slug: company.slug,
          link: company.link,
          status: "WARNING",
          httpStatus: response.status,
          error: `HTTP ${response.status} - Instabilidade temporária no servidor do ATS`,
          checkedUrl: endpoint.url,
          durationMs,
        };
      }

      if (response.status >= 400 && response.status !== 404) {
        return {
          ats,
          name: company.name,
          slug: company.slug,
          link: company.link,
          status: "WARNING",
          httpStatus: response.status,
          error: `HTTP ${response.status} - Bloqueio ou restrição de acesso`,
          checkedUrl: endpoint.url,
          durationMs,
        };
      }

      let jobsCount: number | undefined;
      try {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await response.json();
          if (Array.isArray(data)) {
            jobsCount = data.length;
          } else if (Array.isArray(data?.jobs)) {
            jobsCount = data.jobs.length;
          } else if (Array.isArray(data?.jobsPage)) {
            jobsCount = data.jobsPage.length;
          } else if (Array.isArray(data?.results)) {
            jobsCount = data.results.length;
          } else if (typeof data?.total === "number") {
            jobsCount = data.total;
          }

          if (ats === "INHIRE" && (!data?.tenantName || jobsCount === 0)) {
            return {
              ok: false,
              httpStatus: 404,
              error: "Tenant inativo ou sem vagas",
              message: `Tenant "${slugInput}" no InHire não possui vagas ativas.`,
              checkedUrl: endpoint.url,
              durationMs,
            };
          }
        }
      } catch {
        // Ignora se não for JSON
      }

      return {
        ats,
        name: company.name,
        slug: company.slug,
        link: company.link,
        status: "OK",
        httpStatus: response.status,
        jobsCount,
        checkedUrl: endpoint.url,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      return {
        ats,
        name: company.name,
        slug: company.slug,
        link: company.link,
        status: "WARNING",
        error: err.message || "Timeout / Falha de Conexão",
        checkedUrl: endpoint.url,
        durationMs,
      };
    }
  }

  public static async auditAll(options?: {
    ats?: string;
    autoDisableBroken?: boolean;
    concurrency?: number;
  }): Promise<CompanyAuditReport> {
    if (this.isAuditingNow) {
      throw new Error("Uma auditoria de empresas já está em andamento.");
    }

    this.isAuditingNow = true;
    const startTime = Date.now();

    try {
      const config = ConfigService.getConfig();
      const concurrency = options?.concurrency || 6;
      const targetAts = options?.ats ? this.normalizeAts(options.ats) : null;

      const itemsToAudit: Array<{ ats: AtsPlatform; company: CompanyConfig }> = [];

      const platforms: AtsPlatform[] = targetAts
        ? [targetAts]
        : ["GUPY", "GREENHOUSE", "LEVER", "ASHBY", "WORKABLE", "INHIRE"];

      for (const p of platforms) {
        const key = this.getConfigKeyForAts(p);
        const list = (config[key] as CompanyConfig[]) || [];
        for (const c of list) {
          itemsToAudit.push({ ats: p, company: c });
        }
      }

      const results: CompanyAuditResult[] = [];
      let autoDisabledCount = 0;

      await runWithConcurrency(itemsToAudit, concurrency, async (item) => {
        const res = await this.auditCompany(item.ats, item.company);
        results.push(res);
      });

      const nowIso = new Date().toISOString();
      const brokenMap = new Map<string, CompanyAuditResult>();
      for (const r of results) {
        if (r.status === "BROKEN") {
          brokenMap.set(`${r.ats}:${r.slug.toLowerCase()}`, r);
        }
      }

      // Aplica atualização nos metadados de auditoria e auto-disable se solicitado
      if (options?.autoDisableBroken || results.length > 0) {
        const updatedConfig: Partial<AppConfig> = {};

        for (const p of platforms) {
          const key = this.getConfigKeyForAts(p);
          const list = [...((config[key] as CompanyConfig[]) || [])];
          let changed = false;

          for (let i = 0; i < list.length; i++) {
            const comp = list[i];
            const resultKey = `${p}:${comp.slug.toLowerCase()}`;
            const result = results.find(
              (r) => r.ats === p && r.slug.toLowerCase() === comp.slug.toLowerCase()
            );

            if (result) {
              const prevStatus = comp.status;
              const prevEnabled = comp.enabled;

              comp.lastAuditedAt = nowIso;
              comp.lastAuditStatus = result.httpStatus;
              comp.lastAuditError = result.error;

              if (result.status === "BROKEN") {
                comp.status = "broken_link";
                if (options?.autoDisableBroken && comp.enabled) {
                  comp.enabled = false;
                  autoDisabledCount++;
                  console.log(
                    `[CompanyAuditor] ⚠️ Desativando empresa com link quebrado: ${comp.name} (${p} / ${comp.slug})`
                  );
                }
              } else if (result.status === "OK") {
                comp.status = "healthy";
              }

              if (prevStatus !== comp.status || prevEnabled !== comp.enabled) {
                changed = true;
              }
            }
          }

          if (changed) {
            (updatedConfig as any)[key] = list;
          }
        }

        if (Object.keys(updatedConfig).length > 0) {
          ConfigService.updateConfig(updatedConfig);
        }
      }

      const healthyCount = results.filter((r) => r.status === "OK").length;
      const brokenCount = results.filter((r) => r.status === "BROKEN").length;
      const warningCount = results.filter((r) => r.status === "WARNING").length;

      const report: CompanyAuditReport = {
        timestamp: nowIso,
        totalChecked: results.length,
        healthyCount,
        brokenCount,
        warningCount,
        durationMs: Date.now() - startTime,
        results,
        autoDisabledCount,
      };

      this.lastReport = report;

      LoggerService.info(
        "COMPANY_AUDITOR",
        "AUDIT_COMPLETED",
        `Auditoria concluída: ${results.length} empresas verificadas (${healthyCount} OK, ${brokenCount} quebradas, ${warningCount} avisos)`,
        {
          totalChecked: results.length,
          healthyCount,
          brokenCount,
          warningCount,
          autoDisabledCount,
        }
      );

      return report;
    } finally {
      this.isAuditingNow = false;
    }
  }

  public static getLastReport(): CompanyAuditReport | null {
    return this.lastReport;
  }

  public static isAuditing(): boolean {
    return this.isAuditingNow;
  }

  public static addCompany(
    atsInput: string,
    company: { name: string; slug: string; link?: string; enabled?: boolean }
  ): { success: boolean; company?: CompanyConfig; error?: string } {
    const ats = this.normalizeAts(atsInput);
    if (!ats) {
      return { success: false, error: `Plataforma ATS inválida: "${atsInput}"` };
    }

    if (!company.name || !company.slug) {
      return { success: false, error: "Nome e slug são obrigatórios" };
    }

    const cleanSlug = company.slug.trim().toLowerCase();
    const config = ConfigService.getConfig();
    const key = this.getConfigKeyForAts(ats);
    const list = [...((config[key] as CompanyConfig[]) || [])];

    const exists = list.some((c) => c.slug.toLowerCase() === cleanSlug);
    if (exists) {
      return {
        success: false,
        error: `Empresa com slug "${cleanSlug}" já está cadastrada na plataforma ${ats}.`,
      };
    }

    const newCompany: CompanyConfig = {
      name: company.name.trim(),
      slug: cleanSlug,
      link: company.link?.trim() || "",
      enabled: company.enabled ?? true,
      status: "unknown",
    };

    list.push(newCompany);
    ConfigService.updateConfig({ [key]: list });

    LoggerService.info(
      "COMPANY_AUDITOR",
      "COMPANY_ADDED",
      `Nova empresa adicionada: ${newCompany.name} (${ats} / ${newCompany.slug})`,
      { ats, company: newCompany }
    );

    return { success: true, company: newCompany };
  }

  public static updateCompany(
    atsInput: string,
    slugInput: string,
    updates: Partial<CompanyConfig>
  ): { success: boolean; company?: CompanyConfig; error?: string } {
    const ats = this.normalizeAts(atsInput);
    if (!ats) {
      return { success: false, error: `Plataforma ATS inválida: "${atsInput}"` };
    }

    const cleanSlug = slugInput.trim().toLowerCase();
    const config = ConfigService.getConfig();
    const key = this.getConfigKeyForAts(ats);
    const list = [...((config[key] as CompanyConfig[]) || [])];

    const index = list.findIndex((c) => c.slug.toLowerCase() === cleanSlug);
    if (index === -1) {
      return { success: false, error: `Empresa "${cleanSlug}" não encontrada em ${ats}.` };
    }

    const updatedCompany: CompanyConfig = {
      ...list[index],
      ...updates,
      // slug original mantido se não fornecido
      slug: updates.slug ? updates.slug.trim().toLowerCase() : list[index].slug,
    };

    list[index] = updatedCompany;
    ConfigService.updateConfig({ [key]: list });

    LoggerService.info(
      "COMPANY_AUDITOR",
      "COMPANY_UPDATED",
      `Empresa atualizada: ${updatedCompany.name} (${ats} / ${updatedCompany.slug})`,
      { ats, updates }
    );

    return { success: true, company: updatedCompany };
  }

  public static deleteCompany(
    atsInput: string,
    slugInput: string
  ): { success: boolean; error?: string } {
    const ats = this.normalizeAts(atsInput);
    if (!ats) {
      return { success: false, error: `Plataforma ATS inválida: "${atsInput}"` };
    }

    const cleanSlug = slugInput.trim().toLowerCase();
    const config = ConfigService.getConfig();
    const key = this.getConfigKeyForAts(ats);
    const list = [...((config[key] as CompanyConfig[]) || [])];

    const filtered = list.filter((c) => c.slug.toLowerCase() !== cleanSlug);
    if (filtered.length === list.length) {
      return { success: false, error: `Empresa "${cleanSlug}" não encontrada em ${ats}.` };
    }

    ConfigService.updateConfig({ [key]: filtered });

    LoggerService.info(
      "COMPANY_AUDITOR",
      "COMPANY_DELETED",
      `Empresa removida: ${cleanSlug} de ${ats}`,
      { ats, slug: cleanSlug }
    );

    return { success: true };
  }
}
