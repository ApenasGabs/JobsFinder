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

export interface SolidesRawVacancy {
  id: number | string;
  title: string;
  description?: string;
  currentState?: string;
  companyName?: string;
  slug?: string;
  isHiddenJob?: boolean;
  isDisabled?: boolean;
  homeOffice?: boolean;
  jobType?: string; // "remoto" | "hibrido" | "presencial"
  city?: { name?: string };
  state?: { code?: string; name?: string };
  seniority?: Array<{ id?: number; name?: string }>;
  recruitmentContractType?: Array<{ id?: number; name?: string }>;
  hardSkills?: Array<{ id?: number; name?: string }>;
  createdAt?: string;
}

export function normalizeSolidesVacancy(
  item: SolidesRawVacancy,
  company: { name: string; slug: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  if (
    item.isHiddenJob === true ||
    item.isDisabled === true ||
    (item.currentState && item.currentState.toLowerCase() === "encerrada")
  ) {
    return null;
  }

  const title = (item.title || "Vaga sem título").trim();
  const slug = (item.slug || company.slug).toLowerCase().trim();
  const companyName = item.companyName || company.name;

  let model: WorkModel = "PRESENCIAL";
  const jt = (item.jobType || "").toLowerCase();
  if (item.homeOffice === true || jt === "remoto") {
    model = "REMOTO";
  } else if (jt === "hibrido" || jt === "híbrido") {
    model = "HIBRIDO";
  } else {
    model = detectWorkModel(title);
  }

  const cityName = item.city?.name?.trim() || "";
  const stateCode = item.state?.code?.trim() || item.state?.name?.trim() || "";
  let location =
    cityName && stateCode
      ? `${cityName}, ${stateCode}`
      : cityName || stateCode || "Brasil";
  if (model === "REMOTO" && (!cityName || cityName.toLowerCase().includes("remoto"))) {
    location = "Remoto";
  }

  const rawContract = item.recruitmentContractType?.[0]?.name;
  const contractType: ContractType = rawContract
    ? detectContractType(rawContract, "CLT")
    : detectContractType(title, "CLT");

  const rawSeniority = item.seniority?.[0]?.name;
  const seniorityLevel: SeniorityLevel = rawSeniority
    ? detectSeniority(rawSeniority)
    : detectSeniority(title);

  const cleanDescription = (item.description || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);

  const hardSkillsText = (item.hardSkills || [])
    .map((s) => s.name)
    .filter(Boolean)
    .join(" ");

  const stack = extractStack(`${title} ${cleanDescription} ${hardSkillsText}`);
  const jobUrl = `https://${slug}.vagas.solides.com.br/vaga/${item.id}`;

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "SOLIDES",
    stack,
    description: cleanDescription || `ATS: Sólides | Empresa: ${companyName}`,
  };
}

export class SolidesScraper implements BaseScraper {
  public readonly id = "SOLIDES";
  public readonly name = "Sólides (Vagas PME & Tech)";
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
    const companies = (config.solidesCompanies || []).filter((c) => {
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
    const concurrency = options.concurrency || 8;

    await runWithConcurrency(companies, concurrency, async (company) => {
      try {
        const cleanSlug = company.slug.trim().toLowerCase();
        const apiUrl = `https://apigw.solides.com.br/jobs/v3/companies/${encodeURIComponent(cleanSlug)}/vacancies?take=100`;
        const response = await resilientFetch(apiUrl, {
          timeoutMs: 12000,
          maxRetries: 1,
          source: "SOLIDES",
          headers: {
            Accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
        });

        if (response.ok) {
          const data = await response.json();
          const vacancies: SolidesRawVacancy[] = data.data || [];

          for (const raw of vacancies) {
            const normalized = normalizeSolidesVacancy(raw, company);
            if (!normalized) continue;

            const textToMatch = `${normalized.title} ${normalized.location} ${normalized.stack.join(" ")}`.toLowerCase();
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
          message: `Consultando Sólides: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
