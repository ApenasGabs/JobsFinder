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

  let seniorityLevel: SeniorityLevel = detectSeniority(title);
  if (seniorityLevel === "NAO_INFORMADO" && item.experience_code) {
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
  const cleanDescription = rawDesc
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);

  const dept = (item.department || "").trim();
  const tagsText = Array.isArray(item.tags) ? item.tags.join(" ") : "";
  const stack = extractStack(
    `${title} ${dept} ${tagsText} ${cleanDescription}`,
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
    }> = (ConfigService.getConfig() as any).recruiteeCompanies || [];

    const seenSlugs = new Set<string>();
    const companies = rawCompanies.filter((c) => {
      if (c.enabled === false) return false;
      const s = extractRecruiteeSlug(c.slug || c.link || "");
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

          if (response.ok) {
            const data = await response.json();
            const offers: RecruiteeRawJob[] = Array.isArray(data?.offers)
              ? data.offers
              : [];

            for (const raw of offers) {
              const normalized = normalizeRecruiteeJob(raw, {
                name: company.name,
                slug: cleanSlug,
              });
              if (!normalized) continue;

              const textToMatch =
                `${normalized.title} ${normalized.location} ${normalized.stack.join(" ")} ${normalized.description || ""}`.toLowerCase();
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
          message: `Consultando Recruitee: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
