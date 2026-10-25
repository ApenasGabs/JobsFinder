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

        if (response.ok) {
          const data = await response.json();
          const postings: SmartRecruitersRawJob[] = data.content || [];

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
