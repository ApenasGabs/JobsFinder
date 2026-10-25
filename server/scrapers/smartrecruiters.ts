import * as cheerio from "cheerio";
import { ConfigService } from "../services/config.js";
import { StorageService } from "../services/storage.js";
import {
  Job,
  ScrapeOptions,
  WorkModel,
  ContractType,
  SeniorityLevel,
} from "../types.js";
import {
  detectContractType,
  detectSeniority,
  detectWorkModel,
  extractStack,
} from "../utils/normalizer.js";
import { runWithConcurrency } from "../utils/pool.js";
import { resilientFetch } from "../utils/fetch.js";
import { BaseScraper } from "./base.js";

export interface SmartRecruitersRawJob {
  id: string;
  name: string;
  company?: { name?: string; identifier?: string };
  releasedDate?: string;
  location?: {
    city?: string;
    region?: string;
    country?: string;
    remote?: boolean;
    hybrid?: boolean;
    fullLocation?: string;
  };
  department?: { label?: string };
  function?: { label?: string };
  typeOfEmployment?: { label?: string };
  experienceLevel?: { label?: string };
  ref?: string;
}

export function normalizeSmartRecruitersJob(
  item: SmartRecruitersRawJob,
  company: { name: string; slug: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  const title = (item.name || "Vaga sem título").trim();
  const dept = item.department?.label || item.function?.label || "";
  const companyName = item.company?.name || company.name;
  const slug = company.slug.trim();

  // Modelo de trabalho
  let model: WorkModel = "PRESENCIAL";
  if (item.location?.remote === true) {
    model = "REMOTO";
  } else if (item.location?.hybrid === true) {
    model = "HIBRIDO";
  } else {
    model = detectWorkModel(`${title} ${item.location?.fullLocation || ""}`);
  }

  // Localidade
  const city = item.location?.city?.trim() || "";
  const region = item.location?.region?.trim() || "";
  const country = item.location?.country?.trim() || "";
  let location = item.location?.fullLocation?.trim() || "";
  if (!location) {
    location =
      [city, region, country].filter(Boolean).join(", ") ||
      (model === "REMOTO" ? "Remoto" : "Global");
  }
  if (model === "REMOTO" && (!city || city.toLowerCase().includes("remoto"))) {
    location = "Remoto";
  }

  const contractType: ContractType = detectContractType(
    `${title} ${item.typeOfEmployment?.label || ""}`,
    "CLT",
  );
  const seniorityLevel: SeniorityLevel = detectSeniority(
    `${title} ${item.experienceLevel?.label || ""}`,
  );

  const jobUrl = `https://jobs.smartrecruiters.com/${slug}/${item.id}`;
  const stack = extractStack(`${title} ${dept}`);

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "SMARTRECRUITERS",
    stack,
    description: `Área: ${dept || "Tecnologia"} | ATS: SmartRecruiters | Empresa: ${companyName}`,
  };
}

/**
 * Extrai vagas diretamente do portal SSR próprio da CI&T (https://ciandt.com/br/pt-br/carreiras/oportunidades)
 * pois o tenant legado no SmartRecruiters (CIT / CIAndT) migrou as vagas abertas do Brasil para o portal próprio.
 */
export function parseCiandtPortalHtml(
  html: string,
  companyName = "CI&T",
): Array<Omit<Job, "id" | "scrapedAt">> {
  const $ = cheerio.load(html);
  const results: Array<Omit<Job, "id" | "scrapedAt">> = [];

  $(".opprtunity-item").each((_, el) => {
    const title = $(el).find("h2").first().text().replace(/\s+/g, " ").trim();
    const rawLoc = $(el)
      .find(".short-text-caption")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const filters = $(el)
      .find(".filters-item")
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const href = $(el).find('a[href*="opportunity="]').attr("href") || "";

    if (!title || !href) return;

    const url = href.startsWith("http") ? href : `https://ciandt.com${href}`;
    let workModel: WorkModel = "NAO_INFORMADO";
    if (/Workplace_type_Remote|Homeoffice|\bremoto\b|\bremote\b/i.test(`${filters} ${title}`)) {
      workModel = "REMOTO";
    } else if (/Workplace_type_Hybrid|\bhibrido\b|\bhíbrido\b|\bhybrid\b/i.test(`${filters} ${title}`)) {
      workModel = "HIBRIDO";
    } else if (/Workplace_type_Onsite|\bpresencial\b/i.test(`${filters} ${title}`)) {
      workModel = "PRESENCIAL";
    } else {
      workModel = detectWorkModel(title);
    }

    const location =
      rawLoc.includes("Brazil") || /Pa[ií]s_Brazil/i.test(filters)
        ? workModel === "REMOTO"
          ? "Remoto, Brasil"
          : "Brasil"
        : rawLoc || "Brasil";

    const contractType = detectContractType(`${title} ${filters}`, "CLT");
    const seniorityLevel = detectSeniority(title);
    const stack = extractStack(`${title} ${filters}`);

    results.push({
      title,
      company: companyName,
      location,
      workModel,
      contractType,
      seniorityLevel,
      url,
      source: "SMARTRECRUITERS",
      stack,
      description: `Portal CI&T Carreiras | Filtros: ${filters || "Tecnologia"}`,
    });
  });

  return results;
}

export class SmartRecruitersScraper implements BaseScraper {
  public readonly id = "SMARTRECRUITERS";
  public readonly name = "SmartRecruiters (Top Global & Tech)";
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
    const config = ConfigService.getConfig();
    const seenSlugs = new Set<string>();
    const companies = (config.smartrecruitersCompanies || []).filter((c) => {
      if (c.enabled === false) return false;
      const s = c.slug.trim().toLowerCase();
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
    let ciandtPortalScraped = false;

    await runWithConcurrency(companies, concurrency, async (company) => {
      try {
        const cleanSlug = company.slug.trim();
        const apiUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(cleanSlug)}/postings?limit=100`;
        const response = await resilientFetch(apiUrl, {
          timeoutMs: 12000,
          maxRetries: 1,
          source: "SMARTRECRUITERS",
          headers: {
            Accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
        });

        let postings: SmartRecruitersRawJob[] = [];
        if (response.ok) {
          const data = await response.json();
          postings = data.content || [];
        }

        if (postings.length > 0) {
          for (const item of postings) {
            const normalized = normalizeSmartRecruitersJob(item, company);
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
        } else if (
          !ciandtPortalScraped &&
          (/^(ciandt|cit)$/i.test(cleanSlug) || /ci&t|ciandt/i.test(company.name))
        ) {
          ciandtPortalScraped = true;
          const ciRes = await resilientFetch(
            "https://ciandt.com/br/pt-br/carreiras/oportunidades",
            {
              timeoutMs: 15000,
              maxRetries: 1,
              source: "SMARTRECRUITERS",
              headers: {
                Accept: "text/html",
                "User-Agent":
                  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
              },
            },
          );
          if (ciRes.ok) {
            const html = await ciRes.text();
            const ciJobs = parseCiandtPortalHtml(html, "CI&T");
            for (const normalized of ciJobs) {
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
          message: `Consultando SmartRecruiters: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
