import { ConfigService } from "../services/config.js";
import { StorageService } from "../services/storage.js";
import { Job, ScrapeOptions, WorkModel } from "../types.js";
import { resilientFetch } from "../utils/fetch.js";
import {
  detectContractType,
  detectSeniority,
  detectWorkModel,
  extractStack,
} from "../utils/normalizer.js";
import { runWithConcurrency } from "../utils/pool.js";
import { BaseScraper } from "./base.js";

export interface QuickinRawJob {
  _id: string;
  publicate?: string;
  title?: string;
  description?: string;
  requirements?: string;
  city?: string;
  region?: string;
  country?: string;
  position_category?: string;
  workplace_type?: string;
  code?: string;
  career_url?: string;
  benefits?: string;
  currency?: string;
  remuneration?: number;
  remuneration_period?: string;
  contract_id?: {
    _id?: string;
    name?: string;
  };
  created_at?: string;
}

export interface QuickinApiResponse {
  docs?: QuickinRawJob[];
  total?: number;
  limit?: number;
  page?: number;
  pages?: number;
}

export function normalizeQuickinJob(
  item: QuickinRawJob,
  company: { name: string; slug: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  if (item.publicate && item.publicate.toLowerCase() !== "published") {
    return null;
  }

  const title = (item.title || "Vaga sem título").trim();
  const slug = company.slug.trim().toLowerCase();
  const companyName = company.name.trim();

  let model: WorkModel = "NAO_INFORMADO";
  const wp = (item.workplace_type || "").toLowerCase();
  if (wp === "remote" || wp === "remoto") {
    model = "REMOTO";
  } else if (wp === "hybrid" || wp === "hibrido" || wp === "híbrido") {
    model = "HIBRIDO";
  } else if (wp === "on-site" || wp === "onsite" || wp === "presencial") {
    model = "PRESENCIAL";
  } else {
    model = detectWorkModel(title);
  }

  const city = (item.city || "").trim();
  const region = (item.region || "").trim();
  let location = "Brasil";
  if (city && city.toLowerCase() !== "global" && region) {
    location = `${city}, ${region}`;
  } else if (city && city.toLowerCase() !== "global") {
    location = city;
  } else if (model === "REMOTO") {
    location = "Remoto";
  } else if (region) {
    location = region;
  }

  const contractName = item.contract_id?.name || "";
  const contractType = detectContractType(`${title} ${contractName}`, "CLT");
  const seniorityLevel = detectSeniority(title);
  const plainDesc = `${item.description || ""} ${item.requirements || ""}`.replace(
    /<[^>]+>/g,
    " ",
  );
  const stack = extractStack(`${title} ${plainDesc}`);

  const jobUrl =
    item.career_url?.trim() ||
    `https://jobs.quickin.io/${slug}/jobs/${item._id}`;

  let salary: string | undefined;
  if (typeof item.remuneration === "number" && item.remuneration > 0) {
    const curr = item.currency === "USD" ? "US$" : "R$";
    salary = `${curr} ${item.remuneration.toLocaleString("pt-BR")}`;
  }

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    salary,
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "QUICKIN",
    stack,
    description: `Modelo: ${item.workplace_type || model} | Local: ${location}`,
  };
}

export class QuickinScraper implements BaseScraper {
  public readonly id = "QUICKIN";
  public readonly name = "Quickin (36 Empresas)";
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
    const companies = (config.quickinCompanies || []).filter((c) => {
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
        if (cleanSlug) {
          const apiUrl = `https://api.quickin.io/public/careersites/${encodeURIComponent(cleanSlug)}/jobs?limit=30&page=1`;
          const response = await resilientFetch(apiUrl, {
            timeoutMs: 10000,
            maxRetries: 1,
            source: "QUICKIN",
            headers: {
              Accept: "application/json",
              Origin: "https://jobs.quickin.io",
              Referer: `https://jobs.quickin.io/${cleanSlug}/jobs`,
              "User-Agent":
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            },
          });

          if (response.ok) {
            const payload: QuickinApiResponse = await response.json();
            const jobsList: QuickinRawJob[] = Array.isArray(payload?.docs)
              ? [...payload.docs]
              : [];

            const totalPages = Math.min(Number(payload?.pages || 1), 3);
            for (let page = 2; page <= totalPages; page++) {
              try {
                const nextUrl = `https://api.quickin.io/public/careersites/${encodeURIComponent(cleanSlug)}/jobs?limit=30&page=${page}`;
                const nextRes = await resilientFetch(nextUrl, {
                  timeoutMs: 8000,
                  maxRetries: 0,
                  source: "QUICKIN",
                  headers: { Accept: "application/json" },
                });
                if (nextRes.ok) {
                  const nextPayload: QuickinApiResponse = await nextRes.json();
                  if (Array.isArray(nextPayload?.docs)) {
                    jobsList.push(...nextPayload.docs);
                  }
                }
              } catch {
                break;
              }
            }

            for (const item of jobsList) {
              const normalized = normalizeQuickinJob(item, company);
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
        // Ignora erros individuais de empresa
      }

      completedCount++;
      if (onProgress && companies.length > 0) {
        const percent = Math.round((completedCount / companies.length) * 100);
        onProgress({
          message: `Consultando Quickin: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
