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

export interface SelectyRawJob {
  id: number | string;
  selective_process_id?: number | string;
  occupation?: string;
  title?: string;
  activities?: string;
  requirements?: string;
  benefits?: string;
  company_name?: string;
  city?: string;
  state?: string;
  country?: string;
  workplace_type?: string; // "Presencial" | "Híbrido" | "Remoto"
  contract_type?: string; // "{\"CLT (Efetivo)\"}" | "{Temporário}" | "{Estágio}"
  interest_area?: string;
  salary?: string;
  slug?: string;
  url?: string;
  published?: boolean;
  finished_date?: string | null;
  cancelation_date?: string | null;
  isDisabled?: boolean;
}

export interface SelectyApiResponse {
  qtd_result?: number;
  qtd_positions?: number;
  items?: SelectyRawJob[];
}

export function normalizeSelectyJob(
  item: SelectyRawJob,
  company: { name: string; slug: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  if (
    item.isDisabled === true ||
    item.published === false ||
    Boolean(item.cancelation_date) ||
    Boolean(item.finished_date)
  ) {
    return null;
  }

  const title = (item.occupation || item.title || "").trim();
  if (!title) {
    return null;
  }

  const slug = (company.slug || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, "")
    .replace(/\.selecty\.com\.br.*$/i, "")
    .replace(/\/.*$/, "");

  const companyName = (
    item.company_name ||
    company.name ||
    "Selecty"
  ).trim();

  const city = (item.city || "").trim();
  const state = (item.state || "").trim();

  let model: WorkModel = detectWorkModel(
    `${item.workplace_type || ""} ${title}`,
  );
  if (model === "NAO_INFORMADO" && city) {
    model = "PRESENCIAL";
  }

  let location = "Brasil";
  if (city && state) {
    location = `${city}, ${state}`;
  } else if (city) {
    location = city;
  } else if (model === "REMOTO") {
    location = "Remoto";
  } else if (state) {
    location = state;
  }

  if (model === "REMOTO" && (!city || city.toLowerCase().includes("remoto"))) {
    location = "Remoto";
  }

  const rawContract = (item.contract_type || "").replace(/[{}"]/g, " ");
  const contractType: ContractType = detectContractType(
    `${rawContract} ${title}`,
    "CLT",
  );
  const seniorityLevel: SeniorityLevel = detectSeniority(title);

  let salary: string | undefined;
  if (
    item.salary &&
    item.salary.trim() &&
    item.salary.trim().toLowerCase() !== "a combinar"
  ) {
    salary = item.salary.trim();
  }

  const rawDesc = `${item.activities || ""} ${item.requirements || ""}`
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cleanDescription = rawDesc.slice(0, 1000);

  const stack = extractStack(
    `${title} ${item.interest_area || ""} ${rawDesc}`,
  );
  const jobUrl =
    item.url?.trim() ||
    `https://${slug}.selecty.com.br/vaga/${item.id}${item.slug ? `/${item.slug}` : ""}`;

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    salary,
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "SELECTY",
    stack,
    description:
      cleanDescription ||
      `Área: ${item.interest_area || "Geral"} | ATS: Selecty | Empresa: ${companyName}`,
  };
}

export class SelectyScraper implements BaseScraper {
  public readonly id = "SELECTY";
  public readonly name = "Selecty ATS (Brasil)";
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
    }> = ((ConfigService.getConfig() as any).selectyCompanies || []);

    const seenSlugs = new Set<string>();
    const companies = rawCompanies.filter((c) => {
      if (c.enabled === false) return false;
      const s = (c.slug || "")
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//i, "")
        .replace(/\.selecty\.com\.br.*$/i, "")
        .replace(/\/.*$/, "");
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
        const cleanSlug = company.slug
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//i, "")
          .replace(/\.selecty\.com\.br.*$/i, "")
          .replace(/\/.*$/, "");

        const apiUrl = `https://${encodeURIComponent(cleanSlug)}.selecty.com.br/backend/vacancy`;
        const response = await resilientFetch(apiUrl, {
          method: "POST",
          timeoutMs: 12000,
          maxRetries: 1,
          source: "SELECTY",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Origin: `https://${cleanSlug}.selecty.com.br`,
            Referer: `https://${cleanSlug}.selecty.com.br/`,
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
          body: JSON.stringify({ page: 1, limit: 100 }),
        });

        if (response.ok) {
          const payload: SelectyApiResponse = await response.json();
          const items: SelectyRawJob[] = Array.isArray(payload?.items)
            ? payload.items
            : [];

          for (const raw of items) {
            const normalized = normalizeSelectyJob(raw, {
              name: company.name,
              slug: cleanSlug,
            });
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
          message: `Consultando Selecty: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
