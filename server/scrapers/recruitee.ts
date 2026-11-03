import { ConfigService } from "../services/config.js";
import { ScraperHealthService } from "../services/scraper-health.js";
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
  detectExplicitSeniority,
  detectWorkModel,
  extractStack,
  matchesSearchKeywords,
} from "../utils/normalizer.js";
import { runWithConcurrency } from "../utils/pool.js";
import { BaseScraper } from "./base.js";

export interface RecruiteeRawJob {
  id: number | string;
  title: string;
  slug?: string;
  careers_url?: string;
  city?: string | null;
  state_code?: string | null;
  state_name?: string | null;
  country?: string | null;
  location?: string | null;
  remote?: boolean;
  hybrid?: boolean;
  on_site?: boolean;
  description?: string | null;
  requirements?: string | null;
  department?: string | null;
  employment_type_code?: string | null;
  experience_code?: string | null;
  status?: string | null;
  company_name?: string | null;
  tags?: string[];
}

export function extractRecruiteeSlug(slugOrUrl: string): string {
  const raw = (slugOrUrl || "").trim();
  if (!raw) return "";
  return raw
    .replace(/^https?:\/\/([^.]+)\.recruitee\.com.*$/i, "$1")
    .replace(/\/+$/, "")
    .trim()
    .toLowerCase();
}

export function normalizeRecruiteeJob(
  item: RecruiteeRawJob,
  company: { name: string; slug: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  if (item.status && item.status.toLowerCase() !== "published") {
    return null;
  }

  const title = (item.title || "").trim();
  if (!title) {
    return null;
  }

  const slug = extractRecruiteeSlug(company.slug);
  const companyName = item.company_name?.trim() || company.name.trim();

  let model: WorkModel = "PRESENCIAL";
  if (item.remote === true && !item.hybrid) {
    model = "REMOTO";
  } else if (item.hybrid === true) {
    model = "HIBRIDO";
  } else if (item.remote === true) {
    model = "REMOTO";
  } else if (item.on_site === true) {
    model = "PRESENCIAL";
  } else {
    model = detectWorkModel(`${title} ${item.location || ""}`);
  }

  const city = (item.city || "").trim();
  const state = (item.state_code || item.state_name || "").trim();
  const country = (item.country || "").trim();

  let location = "";
  if (city && state && !city.toLowerCase().includes(state.toLowerCase())) {
    location = `${city}, ${state}`;
  } else if (
    city &&
    country &&
    !city.toLowerCase().includes(country.toLowerCase())
  ) {
    location = `${city}, ${country}`;
  } else if (city) {
    location = city;
  } else if (item.location?.trim()) {
    location = item.location.trim();
  } else {
    location = model === "REMOTO" ? "Remoto" : country || "Brasil";
  }

  if (
    model === "REMOTO" &&
    (!city ||
      city.toLowerCase().includes("remoto") ||
      city.toLowerCase().includes("remote"))
  ) {
    location = "Remoto";
  }

  const empCode = (item.employment_type_code || "").toLowerCase();
  let contractHint = title;
  if (empCode.includes("intern")) {
    contractHint = `${title} estágio`;
  } else if (empCode.includes("freelance")) {
    contractHint = `${title} freelancer`;
  } else if (empCode.includes("contract") || empCode.includes("temporary")) {
    contractHint = `${title} PJ`;
  }
  const contractType: ContractType = detectContractType(contractHint, "CLT");

  const explicitSeniority = detectExplicitSeniority(title);
  let seniorityLevel: SeniorityLevel = explicitSeniority ?? "PLENO";
  if (!explicitSeniority && item.experience_code) {
    const exp = item.experience_code.toLowerCase();
    if (exp.includes("intern")) {
      seniorityLevel = "ESTAGIO";
    } else if (exp.includes("entry") || exp.includes("junior")) {
      seniorityLevel = "JUNIOR";
    } else if (exp.includes("mid")) {
      seniorityLevel = "PLENO";
    } else if (exp.includes("senior")) {
      seniorityLevel = "SENIOR";
    } else if (
      exp.includes("executive") ||
      exp.includes("director") ||
      exp.includes("lead")
    ) {
      seniorityLevel = "ESPECIALISTA";
    }
  }

  const rawDesc = `${item.description || ""} ${item.requirements || ""}`;
  const fullCleanDescription = rawDesc
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  const cleanDescription = fullCleanDescription.slice(0, 1000);

  const dept = (item.department || "").trim();
  const tagsText = Array.isArray(item.tags) ? item.tags.join(" ") : "";
  const stack = extractStack(
    `${title} ${dept} ${tagsText} ${fullCleanDescription}`,
  );

  const jobUrl =
    item.careers_url?.trim() ||
    `https://${slug}.recruitee.com/o/${item.slug || item.id}`;

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "RECRUITEE",
    stack,
    description:
      cleanDescription ||
      `Área: ${dept || "Tecnologia"} | ATS: Recruitee | Empresa: ${companyName}`,
  };
}

export class RecruiteeScraper implements BaseScraper {
  public readonly id = "RECRUITEE";
  public readonly name = "Recruitee (CPQD & Startups)";
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
    const rawCompanies: Array<{
      name: string;
      slug: string;
      link?: string;
      enabled?: boolean;
    }> = ConfigService.getConfig().recruiteeCompanies || [];

    const seenSlugs = new Set<string>();
    const companies = rawCompanies.filter((c) => {
      if (c.enabled === false) return false;
      const s = extractRecruiteeSlug(c.slug || c.link || "");
      if (!s || seenSlugs.has(s)) return false;
      seenSlugs.add(s);
      return true;
    });

    const rawKeywords = options.keywords || [];

    const foundJobs: Job[] = [];
    let completedCount = 0;
    let failedCompanies = 0;
    let lastCompanyError: Error | null = null;
    const concurrency = options.concurrency || 6;

    await runWithConcurrency(companies, concurrency, async (company) => {
      try {
        const cleanSlug = extractRecruiteeSlug(
          company.slug || company.link || "",
        );
        if (cleanSlug) {
          const apiUrl = `https://${encodeURIComponent(cleanSlug)}.recruitee.com/api/offers/`;
          const response = await resilientFetch(apiUrl, {
            timeoutMs: 12000,
            maxRetries: 1,
            source: "RECRUITEE",
            headers: {
              Accept: "application/json",
              "User-Agent":
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            },
          });

          if (!response.ok) {
            const httpMsg = `Recruitee (${cleanSlug}) retornou HTTP ${response.status}`;
            ScraperHealthService.recordTermError("RECRUITEE", cleanSlug, httpMsg);
            failedCompanies++;
            lastCompanyError = new Error(httpMsg);
          } else {
            const data = await response.json();
            if (!data || !Array.isArray(data?.offers)) {
              const receivedKeys =
                data && typeof data === "object"
                  ? Object.keys(data).join(",")
                  : "non-object";
              const schemaMsg = `Contrato inesperado na API Recruitee (${cleanSlug}): campo offers ausente ou inválido (keys: ${receivedKeys})`;
              ScraperHealthService.recordSchemaChange(
                "RECRUITEE",
                schemaMsg,
                cleanSlug,
              );
              failedCompanies++;
              lastCompanyError = new Error(schemaMsg);
            } else {
              const offers: RecruiteeRawJob[] = data.offers;

              for (const raw of offers) {
                const normalized = normalizeRecruiteeJob(raw, {
                  name: company.name,
                  slug: cleanSlug,
                });
                if (!normalized) continue;

                const fullRawText = `${raw.description || ""} ${raw.requirements || ""}`
                  .replace(/<[^>]+>/g, " ")
                  .replace(/&nbsp;/gi, " ")
                  .replace(/&amp;/gi, "&")
                  .replace(/\s+/g, " ")
                  .trim();
                const tagsText = Array.isArray(raw.tags)
                  ? raw.tags.join(" ")
                  : "";
                const dept = (raw.department || "").trim();

                const textToMatch = [
                  normalized.title,
                  dept,
                  tagsText,
                  normalized.seniorityLevel,
                  normalized.contractType,
                  normalized.location,
                  normalized.stack.join(" "),
                  fullRawText,
                ].join(" ");

                if (
                  !matchesSearchKeywords(textToMatch, rawKeywords, {
                    semanticRoleText: `${normalized.title} ${dept}`,
                  })
                ) {
                  continue;
                }

                const { job, isNew } = StorageService.upsertJob(normalized);
                if (job.isTech === false) continue;

                foundJobs.push(job);
                onJobFound(job, isNew);
              }
            }
          }
        }
      } catch (err: unknown) {
        failedCompanies++;
        lastCompanyError =
          err instanceof Error ? err : new Error(String(err));
      }

      completedCount++;
      if (onProgress && companies.length > 0) {
        const percent = Math.round((completedCount / companies.length) * 100);
        onProgress({
          message: `Consultando Recruitee: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    if (
      companies.length > 0 &&
      failedCompanies === companies.length &&
      lastCompanyError
    ) {
      throw lastCompanyError;
    }

    return foundJobs;
  }
}
