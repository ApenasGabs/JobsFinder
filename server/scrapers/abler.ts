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

export interface AblerRawAttributes {
  company_id?: number;
  title?: string;
  title_formatted?: string;
  slug?: string;
  created_at?: string;
  published_at?: string;
  released?: boolean;
  description?: string | null;
  role_description?: string | null;
  role_description_without_tags?: string | null;
  mandatory_requirements?: string | null;
  mandatory_requirements_without_tags?: string | null;
  desirable_requirements?: string | null;
  desirable_requirements_without_tags?: string | null;
  city?: string | null;
  state?: string | null;
  location_city_name?: string | null;
  location_state_name?: string | null;
  work_type?: string[] | string | null;
  work_type_formatted?: string[] | string | null;
  contracting_regime?: string | null;
  contracting_regime_value?: string | null;
  seniority_level?: string | null;
  seniority_level_formatted?: string | null;
  salary?: number | string | null;
  salary_value?: number | null;
  full_url?: string | null;
  short_url?: string | null;
}

export interface AblerRawJob {
  id: string | number;
  type?: string;
  attributes?: AblerRawAttributes;
  // Campos diretos (fallback para mocks simplificados)
  title?: string;
  slug?: string;
  released?: boolean;
  description?: string | null;
  role_description?: string | null;
  mandatory_requirements?: string | null;
  city?: string | null;
  state?: string | null;
  work_type?: string[] | string | null;
  work_type_formatted?: string[] | string | null;
  contracting_regime?: string | null;
  seniority_level_formatted?: string | null;
  salary?: number | string | null;
  full_url?: string | null;
}

const BR_STATE_TO_UF: Record<string, string> = {
  acre: "AC",
  alagoas: "AL",
  amapa: "AP",
  amazonas: "AM",
  bahia: "BA",
  ceara: "CE",
  "distrito federal": "DF",
  "espirito santo": "ES",
  goias: "GO",
  maranhao: "MA",
  "mato grosso": "MT",
  "mato grosso do sul": "MS",
  "minas gerais": "MG",
  para: "PA",
  paraiba: "PB",
  parana: "PR",
  pernambuco: "PE",
  piaui: "PI",
  "rio de janeiro": "RJ",
  "rio grande do norte": "RN",
  "rio grande do sul": "RS",
  rondonia: "RO",
  roraima: "RR",
  "santa catarina": "SC",
  "sao paulo": "SP",
  sergipe: "SE",
  tocantins: "TO",
};

function normalizeStateCode(stateRaw: string): string {
  const clean = stateRaw.trim();
  if (!clean) return "";
  if (clean.length === 2) return clean.toUpperCase();
  const key = clean
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return BR_STATE_TO_UF[key] || clean;
}

export function extractAblerSlug(slugOrUrl: string): string {
  const raw = (slugOrUrl || "").trim();
  if (!raw) return "";
  return raw
    .replace(/^https?:\/\/ats\.abler\.com\.br\/jobs\//i, "")
    .replace(/^https?:\/\/([^.]+)\.abler\.com\.br.*$/i, "$1")
    .replace(/\/+$/, "")
    .trim()
    .toLowerCase();
}

export function normalizeAblerJob(
  item: AblerRawJob,
  company: { name: string; slug: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  const attr: AblerRawAttributes = item.attributes || item;

  if (attr.released === false) {
    return null;
  }

  const title = (attr.title || attr.title_formatted || "").trim();
  if (!title) {
    return null;
  }

  const slug = extractAblerSlug(company.slug);
  const companyName = company.name.trim();

  const rawWorkTypes = [
    ...(Array.isArray(attr.work_type)
      ? attr.work_type
      : attr.work_type
        ? [attr.work_type]
        : []),
    ...(Array.isArray(attr.work_type_formatted)
      ? attr.work_type_formatted
      : attr.work_type_formatted
        ? [attr.work_type_formatted]
        : []),
  ]
    .join(" ")
    .toLowerCase();

  let model: WorkModel = "PRESENCIAL";
  if (rawWorkTypes.includes("remot") || rawWorkTypes.includes("home")) {
    model = "REMOTO";
  } else if (
    rawWorkTypes.includes("hibrid") ||
    rawWorkTypes.includes("híbrid")
  ) {
    model = "HIBRIDO";
  } else if (rawWorkTypes.includes("presencial")) {
    model = "PRESENCIAL";
  } else {
    model = detectWorkModel(`${title} ${rawWorkTypes}`);
  }

  const city = (attr.city || attr.location_city_name || "").trim();
  const state = normalizeStateCode(
    attr.state || attr.location_state_name || "",
  );
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

  const rawContract = (
    attr.contracting_regime ||
    attr.contracting_regime_value ||
    ""
  ).trim();
  const contractType: ContractType = rawContract
    ? detectContractType(`${rawContract} ${title}`, "CLT")
    : detectContractType(title, "CLT");

  const rawSeniority = (
    attr.seniority_level_formatted ||
    attr.seniority_level ||
    ""
  ).trim();
  const hasValidSeniority =
    rawSeniority.length > 0 && !rawSeniority.toLowerCase().includes("aplica");
  const seniorityLevel: SeniorityLevel = hasValidSeniority
    ? detectSeniority(`${title} ${rawSeniority}`)
    : detectSeniority(title);

  const combinedDesc = [
    attr.description || "",
    attr.role_description_without_tags || attr.role_description || "",
    attr.mandatory_requirements_without_tags ||
      attr.mandatory_requirements ||
      "",
    attr.desirable_requirements_without_tags ||
      attr.desirable_requirements ||
      "",
  ].join(" ");

  const cleanDescription = combinedDesc
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);

  const stack = extractStack(`${title} ${cleanDescription}`);
  const jobSlug = String(attr.slug || item.id || "").trim();
  const jobUrl =
    attr.full_url?.trim() ||
    (jobSlug
      ? `https://ats.abler.com.br/jobs/${slug}/${jobSlug}`
      : `https://ats.abler.com.br/jobs/${slug}`);

  let salary: string | undefined;
  if (typeof attr.salary === "number" && attr.salary >= 100) {
    salary = `R$ ${attr.salary.toLocaleString("pt-BR")}`;
  }

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    ...(salary ? { salary } : {}),
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "ABLER",
    stack,
    description: cleanDescription || `ATS: Abler | Empresa: ${companyName}`,
  };
}

export class AblerScraper implements BaseScraper {
  public readonly id = "ABLER";
  public readonly name = "Abler ATS (Brasil)";
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
    }> = (ConfigService.getConfig() as any).ablerCompanies || [];

    const seenSlugs = new Set<string>();
    const companies = rawCompanies.filter((c) => {
      if (c.enabled === false) return false;
      const s = extractAblerSlug(c.slug || c.link || "");
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
        const cleanSlug = extractAblerSlug(company.slug || company.link || "");
        if (cleanSlug) {
          const apiUrl = `https://hulk-smash.abler.com.br/api/company/v1/careers_pages/${encodeURIComponent(cleanSlug)}/vacancies?per_page=100&page=1`;
          const response = await resilientFetch(apiUrl, {
            timeoutMs: 12000,
            maxRetries: 1,
            source: "ABLER",
            headers: {
              Accept: "application/json",
              Origin: "https://ats.abler.com.br",
              Referer: `https://ats.abler.com.br/jobs/${cleanSlug}`,
              "User-Agent":
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            },
          });

          if (response.ok) {
            const payload = await response.json();
            const vacancies: AblerRawJob[] = Array.isArray(payload?.data)
              ? [...payload.data]
              : [];

            const totalPages = Math.min(Number(payload?.meta?.last || 1), 3);
            for (let page = 2; page <= totalPages; page++) {
              try {
                const nextUrl = `https://hulk-smash.abler.com.br/api/company/v1/careers_pages/${encodeURIComponent(cleanSlug)}/vacancies?per_page=100&page=${page}`;
                const nextRes = await resilientFetch(nextUrl, {
                  timeoutMs: 8000,
                  maxRetries: 0,
                  source: "ABLER",
                  headers: { Accept: "application/json" },
                });
                if (nextRes.ok) {
                  const nextPayload = await nextRes.json();
                  if (Array.isArray(nextPayload?.data)) {
                    vacancies.push(...nextPayload.data);
                  }
                }
              } catch {
                break;
              }
            }

            for (const raw of vacancies) {
              const normalized = normalizeAblerJob(raw, {
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
        }
      } catch {
        // Ignora falhas isoladas de endpoints de empresas
      }

      completedCount++;
      if (onProgress && companies.length > 0) {
        const percent = Math.round((completedCount / companies.length) * 100);
        onProgress({
          message: `Consultando Abler: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
