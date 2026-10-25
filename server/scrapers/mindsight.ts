import { ConfigService } from "../services/config.js";
import { StorageService } from "../services/storage.js";
import {
  ContractType,
  Job,
  ScrapeOptions,
  SeniorityLevel,
  WorkModel,
} from "../types.js";
import { resilientFetch } from "../utils/fetch.js";
import {
  detectContractType,
  detectSeniority,
  detectWorkModel,
  extractStack,
} from "../utils/normalizer.js";
import { runWithConcurrency } from "../utils/pool.js";
import { BaseScraper } from "./base.js";

export interface MindsightRawJob {
  id: number | string;
  name: string;
  status?: string;
  positions?: number;
  start_salary_range?: string | number | null;
  end_salary_range?: string | number | null;
  competencies?: string[];
  country?: string | null;
  state?: string | null;
  city?: string | null;
  work_model?: string | null; // "REMOTE" | "HYBRID" | "IN_PERSON"
  hire_model?: string | null; // "EFFECTIVE_CLT" | "AUTONOMOUS_PJ" | "INTERNSHIP" | "TEMPORARY" | "TRAINEE" | "APRENDICE" | "TALENT_POOL"
  external_publication?: boolean;
  unlisted_external_publication?: boolean;
  already_suspended?: boolean;
  already_canceled?: boolean;
  publication_path_segment?: string | null;
  seniority_level?: number | string | null;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

export function extractMindsightSlug(slugOrUrl: string): string {
  if (!slugOrUrl || typeof slugOrUrl !== "string") return "";
  const raw = slugOrUrl.trim().toLowerCase();
  if (!raw) return "";

  const urlMatch = raw.match(
    /oportunidades\.mindsight\.com\.br\/(?:(?:pt|en|es)\/)?([a-z0-9_-]+)/i,
  );
  if (urlMatch) {
    return urlMatch[1].toLowerCase();
  }

  return raw
    .replace(/^https?:\/\//i, "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")[0];
}

export function parseMindsightHtml(html: string): MindsightRawJob[] {
  if (!html || typeof html !== "string") return [];

  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i,
  );
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[1]);
    const postings = parsed?.props?.pageProps?.publicJobPostings;
    return Array.isArray(postings) ? postings : [];
  } catch {
    return [];
  }
}

export function normalizeMindsightJob(
  item: MindsightRawJob,
  company: { name: string; slug: string; link?: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  if (!item || item.id === undefined || item.id === null) return null;

  const st = (item.status || "").toLowerCase().trim();
  if (
    item.already_canceled === true ||
    item.external_publication === false ||
    item.unlisted_external_publication === true ||
    st === "canceled" ||
    st === "cancelled" ||
    st === "closed" ||
    st === "encerrada"
  ) {
    return null;
  }

  const title = (item.name || "").replace(/\s+/g, " ").trim();
  if (!title) return null;

  const slug =
    extractMindsightSlug(company.slug || company.link || "") || "mindsight";
  const companyName = (company.name || slug).trim();

  const wm = (item.work_model || "").toUpperCase().trim();
  let model: WorkModel = "PRESENCIAL";
  if (wm === "REMOTE" || wm === "REMOTO") {
    model = "REMOTO";
  } else if (wm === "HYBRID" || wm === "HIBRIDO" || wm === "HÍBRIDO") {
    model = "HIBRIDO";
  } else if (wm === "IN_PERSON" || wm === "PRESENCIAL" || wm === "ONSITE") {
    model = "PRESENCIAL";
  } else {
    model = detectWorkModel(title);
  }

  const city = (item.city || "").trim();
  const state = (item.state || "").trim();
  let location =
    city && state
      ? `${city}, ${state}`
      : city || state || (model === "REMOTO" ? "Remoto" : "Brasil");
  if (
    model === "REMOTO" &&
    (!city || city.toLowerCase().includes("remoto"))
  ) {
    location = "Remoto";
  }

  const hm = (item.hire_model || "").toUpperCase().trim();
  let contractType: ContractType;
  if (hm === "AUTONOMOUS_PJ" || hm === "PJ") {
    contractType = "PJ";
  } else if (hm === "INTERNSHIP" || hm === "APRENDICE" || hm === "ESTAGIO") {
    contractType = "ESTAGIO";
  } else if (hm === "TEMPORARY" || hm === "TEMPORARIO") {
    contractType = "TEMPORARIO";
  } else if (hm === "EFFECTIVE_CLT" || hm === "TRAINEE" || hm === "CLT") {
    contractType = detectContractType(title, "CLT");
  } else {
    contractType = detectContractType(`${title} ${hm}`, "CLT");
  }

  const seniorityLevel: SeniorityLevel = detectSeniority(title);

  let salary: string | undefined;
  const startSal = Number(item.start_salary_range || 0);
  const endSal = Number(item.end_salary_range || 0);
  if (startSal > 0 && endSal > 0 && Math.abs(endSal - startSal) > 10) {
    salary = `R$ ${startSal.toLocaleString("pt-BR")} - R$ ${endSal.toLocaleString("pt-BR")}`;
  } else if (startSal > 0) {
    salary = `R$ ${startSal.toLocaleString("pt-BR")}`;
  } else if (endSal > 0) {
    salary = `R$ ${endSal.toLocaleString("pt-BR")}`;
  }

  const competenciesText = Array.isArray(item.competencies)
    ? item.competencies.filter(Boolean).join(" ")
    : "";
  const cleanDescription = (item.description || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);

  const stack = extractStack(`${title} ${competenciesText} ${cleanDescription}`);
  const jobUrl = `https://oportunidades.mindsight.com.br/${slug}/${item.id}`;

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    salary,
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "MINDSIGHT",
    stack,
    description:
      cleanDescription ||
      `Modelo: ${model} | Local: ${location} | ATS: Mindsight | Empresa: ${companyName}`,
  };
}

export class MindsightScraper implements BaseScraper {
  public readonly id = "MINDSIGHT";
  public readonly name = "Mindsight (Tech & Startups BR)";
  public readonly type = "CLT" as const;
  public readonly isFastMode = true;

  public async scrape(
    options: ScrapeOptions,
    onJobFound: (job: Job, isNew?: boolean) => void,
    onProgress?: (progress: {
      message: string;
      currentCompany?: string;
      percent?: number;
    }) => void,
  ): Promise<Job[]> {
    const config = ConfigService.getConfig() as any;
    const rawCompanies: Array<{
      name: string;
      slug: string;
      link?: string;
      enabled?: boolean;
    }> = config.mindsightCompanies || [];

    const seenSlugs = new Set<string>();
    const companies = rawCompanies.filter((c) => {
      if (c.enabled === false) return false;
      const s = extractMindsightSlug(c.slug || c.link || "");
      if (!s || seenSlugs.has(s)) return false;
      seenSlugs.add(s);
      return true;
    });

    const keywords = (options.keywords || [])
      .map((k) => k.toLowerCase().trim())
      .filter(Boolean);

    const foundJobs: Job[] = [];
    let completedCount = 0;
    const concurrency = options.concurrency || 6;

    await runWithConcurrency(companies, concurrency, async (company) => {
      try {
        const cleanSlug = extractMindsightSlug(
          company.slug || company.link || "",
        );
        if (cleanSlug) {
          const portalUrl = `https://oportunidades.mindsight.com.br/${encodeURIComponent(cleanSlug)}`;
          const response = await resilientFetch(portalUrl, {
            timeoutMs: 12000,
            maxRetries: 1,
            source: "MINDSIGHT",
            headers: {
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
              "User-Agent":
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            },
          });

          if (response.ok) {
            const html = await response.text();
            const postings = parseMindsightHtml(html);

            for (const raw of postings) {
              const normalized = normalizeMindsightJob(raw, company);
              if (!normalized) continue;

              const textToMatch =
                `${normalized.title} ${normalized.location} ${normalized.stack.join(" ")}`.toLowerCase();
              if (keywords.length > 0) {
                const matches = keywords.some((k) => textToMatch.includes(k));
                if (!matches) continue;
              }

              const { job, isNew } = StorageService.upsertJob(normalized);
              foundJobs.push(job);
              onJobFound(job, isNew);
            }
          }
        }
      } catch {
        // Ignora falhas isoladas de endpoints de empresas
      }

      completedCount++;
      if (onProgress && companies.length > 0) {
        const percent = Math.round((completedCount / companies.length) * 100);
        onProgress({
          message: `Consultando Mindsight: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
