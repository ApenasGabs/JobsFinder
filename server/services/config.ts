import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AppConfig, CompanyConfig } from "../types.js";
import { LoggerService } from "./logger.js";
import { SupabaseCompanyRow, SupabaseSyncService } from "./supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_FILE_PATH = path.resolve(
  __dirname,
  "../../config/search.config.json",
);

export const ATS_CONFIG_KEYS: Record<string, keyof AppConfig> = {
  GUPY: "gupyCompanies",
  INHIRE: "inhireCompanies",
  ASHBY: "ashbyCompanies",
  LEVER: "leverCompanies",
  GREENHOUSE: "greenhouseCompanies",
  WORKABLE: "workableCompanies",
  SOLIDES: "solidesCompanies",
  QUICKIN: "quickinCompanies",
  SMARTRECRUITERS: "smartrecruitersCompanies",
  WORKDAY: "workdayCompanies",
  PANDAPE: "pandapeCompanies",
  TOTVS: "totvsCompanies",
  MINDSIGHT: "mindsightCompanies",
  ABLER: "ablerCompanies",
  RECRUTAI: "recrutaiCompanies",
  EIGHTFOLD: "eightfoldCompanies",
  RECRUTEI: "recruteiCompanies",
  RECRUITEE: "recruiteeCompanies",
  TEAMTAILOR: "teamtailorCompanies",
  SELECTY: "selectyCompanies",
};

export const KNOWN_TOTVS_COMPANY_SLUGS: Record<string, string> = {
  brudam: "brudam",
  "e-inscrição tecnologia e inovação": "einscricao",
  "e-inscricao tecnologia e inovacao": "einscricao",
  "estuda.com": "estuda",
  "ff solutions a symetri company": "ffsolutions",
  "ff solutions": "ffsolutions",
  hsystem: "hsystem",
  "morada.ai": "moradaai",
  "morada ai": "moradaai",
  starbem: "starbem",
  "universo e-commerce": "universoecommerce",
  "universo ecommerce": "universoecommerce",
};

export function normalizeTotvsCompanyList(list: CompanyConfig[]): CompanyConfig[] {
  const result: CompanyConfig[] = [];
  const seenSlugs = new Set<string>();

  for (const comp of list) {
    let cleanSlug = (comp.slug || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\/atracaodetalentos\.totvs\.app\//i, "")
      .replace(/\/.*$/, "");
    const nameKey = (comp.name || "").trim().toLowerCase();
    const unaccentedNameKey = nameKey
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    if (
      cleanSlug === "vempratotvs" &&
      (KNOWN_TOTVS_COMPANY_SLUGS[nameKey] ||
        KNOWN_TOTVS_COMPANY_SLUGS[unaccentedNameKey])
    ) {
      cleanSlug =
        KNOWN_TOTVS_COMPANY_SLUGS[nameKey] ||
        KNOWN_TOTVS_COMPANY_SLUGS[unaccentedNameKey];
    }

    if (!cleanSlug || seenSlugs.has(cleanSlug)) continue;
    seenSlugs.add(cleanSlug);

    const normalizedName =
      cleanSlug === "vempratotvs" && nameKey !== "totvs" ? "TOTVS" : comp.name;
    const normalizedLink =
      cleanSlug !== (comp.slug || "").trim().toLowerCase()
        ? `https://atracaodetalentos.totvs.app/${cleanSlug}`
        : comp.link;

    result.push({
      ...comp,
      name: normalizedName,
      slug: cleanSlug,
      link: normalizedLink,
    });
  }

  if (list.length > 0 && !seenSlugs.has("vempratotvs")) {
    result.unshift({
      id: "comp-totvs-vempratotvs",
      name: "TOTVS",
      slug: "vempratotvs",
      link: "https://atracaodetalentos.totvs.app/vempratotvs",
      enabled: true,
      status: "healthy",
      healthStatus: "HEALTHY",
      failureCount: 0,
      lastScrapedAt: null,
    });
  }

  return result;
}

export interface CacheStats {
  source: "supabase" | "local_fallback";
  lastHydratedAt: string | null;
  totalCompanies: number;
  byAts: Record<string, number>;
  lastError?: string | null;
}

export class ConfigService {
  private static cachedConfig: AppConfig | null = null;
  private static configFilePath: string = DEFAULT_CONFIG_FILE_PATH;
  private static cacheSource: "supabase" | "local_fallback" = "local_fallback";
  private static lastHydratedAt: string | null = null;
  private static lastHydrationError: string | null = null;

  public static setConfigFilePath(customPath: string): void {
    this.configFilePath = customPath;
  }

  public static resetCache(): void {
    this.cachedConfig = null;
    this.cacheSource = "local_fallback";
    this.lastHydratedAt = null;
    this.lastHydrationError = null;
  }

  public static getConfigKeyForAts(ats: string): keyof AppConfig | null {
    const clean = ats.trim().toUpperCase();
    return ATS_CONFIG_KEYS[clean] || null;
  }

  private static loadLocalConfigFromDisk(): AppConfig {
    try {
      if (fs.existsSync(this.configFilePath)) {
        const raw = fs.readFileSync(this.configFilePath, "utf-8");
        const parsed = JSON.parse(raw) as AppConfig;
        if (parsed.totvsCompanies) {
          parsed.totvsCompanies = normalizeTotvsCompanyList(parsed.totvsCompanies);
        }
        return parsed;
      }
    } catch (err) {
      console.error("[ConfigService] Erro ao carregar config local:", err);
    }

    return {
      searchTerms: ["java", "react", "node", "fullstack"],
      seniorityLevels: ["ESTAGIO", "JUNIOR", "PLENO", "SENIOR"],
      contractTypes: ["CLT", "PJ", "FREELANCER"],
      sources: [],
      gupyCompanies: [],
    };
  }

  /**
   * Retorna a configuração diretamente do Hot Cache em RAM (sub-microssegundo).
   * Se ainda não inicializada, carrega do fallback local search.config.json.
   */
  public static getConfig(): AppConfig {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }

    this.cachedConfig = this.loadLocalConfigFromDisk();
    this.cacheSource = "local_fallback";
    return this.cachedConfig;
  }

  /**
   * Inicializa ou atualiza o Hot Cache em RAM a partir da tabela `public.companies`
   * no Supabase. Caso o Supabase esteja offline, não configurado ou retorne lista vazia,
   * mantém o fallback resiliente a partir do `search.config.json` local sem interromper o crawler.
   */
  public static async initializeHotCache(options?: {
    persistToDisk?: boolean;
  }): Promise<CacheStats> {
    const baseConfig = this.cachedConfig ?? this.loadLocalConfigFromDisk();
    this.cachedConfig = baseConfig;

    if (!SupabaseSyncService.isConfigured()) {
      this.cacheSource = "local_fallback";
      this.lastHydrationError = "Supabase não configurado; operando em fallback local.";
      return this.getCacheStats();
    }

    const fetchResult = await SupabaseSyncService.fetchCompanies();
    if (!fetchResult.success || fetchResult.rows.length === 0) {
      this.cacheSource = "local_fallback";
      this.lastHydrationError =
        fetchResult.error ||
        "Tabela public.companies vazia ou indisponível; mantendo fallback local.";

      LoggerService.warn(
        "STORAGE",
        "CONFIG_CACHE_FALLBACK",
        `Hot Cache operando via fallback local (search.config.json): ${this.lastHydrationError}`,
      );
      return this.getCacheStats();
    }

    this.applyRowsToHotCache(fetchResult.rows, options?.persistToDisk ?? false);
    this.cacheSource = "supabase";
    this.lastHydratedAt = new Date().toISOString();
    this.lastHydrationError = null;

    const stats = this.getCacheStats();
    LoggerService.info(
      "STORAGE",
      "CONFIG_CACHE_HYDRATED",
      `Hot Cache em RAM carregado do Supabase com ${stats.totalCompanies} empresas monitoradas`,
      { totalCompanies: stats.totalCompanies, byAts: stats.byAts },
    );

    return stats;
  }

  /**
   * Aplica linhas vindas do Supabase diretamente no Hot Cache em RAM,
   * mesclando de forma não-destrutiva com a configuração base.
   */
  public static applyRowsToHotCache(
    rows: SupabaseCompanyRow[],
    persistToDisk = false,
  ): AppConfig {
    const current = this.getConfig();
    const grouped: Record<string, CompanyConfig[]> = {};

    for (const row of rows) {
      const { ats, company } = SupabaseSyncService.mapRowToCompanyConfig(row);
      const key = this.getConfigKeyForAts(ats);
      if (!key) continue;

      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(company);
    }

    const updated: AppConfig = { ...current };
    for (const [key, list] of Object.entries(grouped)) {
      const finalList =
        key === "totvsCompanies" ? normalizeTotvsCompanyList(list) : list;
      finalList.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
      (updated as unknown as Record<string, unknown>)[key] = finalList;
    }

    this.cachedConfig = updated;
    if (persistToDisk) {
      this.saveConfigToDisk(updated);
    }

    return updated;
  }

  /**
   * Extrai todas as empresas atualmente em memória para linhas compatíveis com `public.companies`.
   */
  public static extractAllCompaniesAsRows(
    configInput?: AppConfig,
  ): SupabaseCompanyRow[] {
    const cfg = configInput || this.getConfig();
    const rows: SupabaseCompanyRow[] = [];
    const seenSlugKeys = new Set<string>();
    const seenUrls = new Set<string>();

    for (const [ats, key] of Object.entries(ATS_CONFIG_KEYS)) {
      const rawList = (cfg[key] as CompanyConfig[] | undefined) || [];
      const list =
        key === "totvsCompanies" ? normalizeTotvsCompanyList(rawList) : rawList;
      for (const comp of list) {
        if (!comp || !comp.slug || !comp.name) continue;
        const row = SupabaseSyncService.mapCompanyToRow(ats, comp);
        const slugKey = `${row.ats}:${row.slug}`;
        if (seenSlugKeys.has(slugKey)) {
          continue;
        }
        seenSlugKeys.add(slugKey);

        let finalUrl = row.url || `https://${row.slug}.${row.ats.toLowerCase()}.local`;
        const normUrl = finalUrl.toLowerCase();
        if (seenUrls.has(normUrl)) {
          const sep = finalUrl.includes("#") ? "-" : "#";
          finalUrl = `${finalUrl}${sep}${row.slug}`;
        }
        seenUrls.add(finalUrl.toLowerCase());

        rows.push({
          ...row,
          url: finalUrl,
        });
      }
    }

    return rows;
  }

  public static getCacheStats(): CacheStats {
    const cfg = this.getConfig();
    const byAts: Record<string, number> = {};
    let totalCompanies = 0;

    for (const [ats, key] of Object.entries(ATS_CONFIG_KEYS)) {
      const list = (cfg[key] as CompanyConfig[] | undefined) || [];
      byAts[ats] = list.length;
      totalCompanies += list.length;
    }

    return {
      source: this.cacheSource,
      lastHydratedAt: this.lastHydratedAt,
      totalCompanies,
      byAts,
      lastError: this.lastHydrationError,
    };
  }

  private static saveConfigToDisk(configToSave: AppConfig): void {
    try {
      const configDir = path.dirname(this.configFilePath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(
        this.configFilePath,
        JSON.stringify(configToSave, null, 2),
        "utf-8",
      );
    } catch (err) {
      console.error("[ConfigService] Erro ao salvar config:", err);
    }
  }

  public static updateConfig(newConfig: Partial<AppConfig>): AppConfig {
    const current = this.getConfig();
    const updated = { ...current, ...newConfig };
    this.cachedConfig = updated;
    this.saveConfigToDisk(updated);
    return updated;
  }

  /**
   * Atualiza em memória (e opcionalmente no Supabase em background) a telemetria de uma empresa.
   */
  public static recordCompanyScrapeOutcome(
    ats: string,
    slug: string,
    outcome: {
      success: boolean;
      error?: string;
      scrapedAt?: string;
    },
  ): void {
    const key = this.getConfigKeyForAts(ats);
    if (!key) return;

    const cfg = this.getConfig();
    const list = (cfg[key] as CompanyConfig[] | undefined) || [];
    const cleanSlug = slug.trim().toLowerCase();
    const target = list.find((c) => c.slug.toLowerCase() === cleanSlug);
    const nowIso = outcome.scrapedAt || new Date().toISOString();

    let nextFailureCount = 0;
    let nextHealthStatus: "HEALTHY" | "BROKEN" | "WARNING" | "UNKNOWN" = "HEALTHY";

    if (target) {
      if (outcome.success) {
        nextFailureCount = 0;
        nextHealthStatus = "HEALTHY";
        target.status = "healthy";
      } else {
        nextFailureCount = (target.failureCount || 0) + 1;
        nextHealthStatus = nextFailureCount >= 3 ? "BROKEN" : "WARNING";
      }
      target.failureCount = nextFailureCount;
      target.healthStatus = nextHealthStatus;
      target.lastScrapedAt = nowIso;
    }

    if (SupabaseSyncService.isConfigured()) {
      void SupabaseSyncService.updateCompanyTelemetry(ats, cleanSlug, {
        healthStatus: nextHealthStatus,
        failureCount: nextFailureCount,
        lastScrapedAt: nowIso,
      });
    }
  }
}
