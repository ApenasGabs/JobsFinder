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

export interface WorkdayRawJob {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  timeType?: string;
  remoteType?: string;
  bulletFields?: string[];
}

export interface WorkdayParsedUrl {
  host: string;
  tenant: string;
  site: string;
  locale?: string;
  baseUrl: string;
  apiUrl: string;
}

const KNOWN_WORKDAY_SLUGS: Record<string, string> = {
  accenture: "https://accenture.wd103.myworkdayjobs.com/pt-BR/AccentureCareers",
  santander: "https://santander.wd3.myworkdayjobs.com/pt-BR/SantanderCareers",
  maersk: "https://maersk.wd3.myworkdayjobs.com/pt-BR/Maersk_Careers",
  crowdstrike: "https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers/job",
  brinks: "https://brinks.wd5.myworkdayjobs.com/pt-BR/Carreiras_Brinks",
  natura: "https://natura.wd501.myworkdayjobs.com/pt-BR/NaturaCarreiras",
  philips: "https://philips.wd3.myworkdayjobs.com/pt-BR/jobs-and-careers",
  salesforce: "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job",
  redhat: "https://redhat.wd5.myworkdayjobs.com/jobs/job",
  rappi: "https://rappi.wd12.myworkdayjobs.com/es/Rappi_jobs",
};

export function parseWorkdayUrl(urlOrSlug: string): WorkdayParsedUrl | null {
  if (!urlOrSlug || typeof urlOrSlug !== "string") return null;
  const raw = urlOrSlug.trim();
  if (!raw) return null;

  const mapped = KNOWN_WORKDAY_SLUGS[raw.toLowerCase()] || raw;
  const withProto = /^https?:\/\//i.test(mapped) ? mapped : `https://${mapped}`;

  let parsed: URL;
  try {
    parsed = new URL(withProto);
  } catch {
    return null;
  }

  const hostMatch = parsed.hostname.match(
    /^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/i,
  );
  if (!hostMatch) return null;

  const host = parsed.hostname.toLowerCase();
  let tenant = hostMatch[1].toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  let site = "";
  let locale: string | undefined;

  if (
    segments[0].toLowerCase() === "wday" &&
    segments[1]?.toLowerCase() === "cxs" &&
    segments.length >= 4
  ) {
    tenant = segments[2];
    site = segments[3];
  } else if (
    /^[a-z]{2}(?:-[a-z]{2,4})?$/i.test(segments[0]) &&
    segments.length >= 2
  ) {
    locale = segments[0];
    site = segments[1];
  } else {
    site = segments[0];
  }

  if (!site) return null;

  const baseUrl = locale
    ? `https://${host}/${locale}/${site}`
    : `https://${host}/${site}`;
  const apiUrl = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;

  return {
    host,
    tenant,
    site,
    locale,
    baseUrl,
    apiUrl,
  };
}

export function normalizeWorkdayJob(
  item: WorkdayRawJob,
  company: { name: string; slug: string; link?: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  const title = (item.title || "").trim();
  if (!title) return null;

  const companyName = company.name.trim();
  const parsed =
    parseWorkdayUrl(company.link || "") || parseWorkdayUrl(company.slug || "");

  const baseUrl = parsed
    ? parsed.baseUrl
    : (company.link || `https://${company.slug}`).replace(/\/+$/, "");

  const extPath = (item.externalPath || "").trim();
  const jobUrl = extPath
    ? `${baseUrl}${extPath.startsWith("/") ? "" : "/"}${extPath}`
    : baseUrl;

  const bulletText = (item.bulletFields || []).join(" | ");
  const rawLocation = (
    item.locationsText ||
    item.bulletFields?.[1] ||
    ""
  ).trim();
  const remoteHint = `${item.remoteType || ""} ${ title } ${rawLocation} ${bulletText}`;

  let model: WorkModel = detectWorkModel(remoteHint);
  if (model === "NAO_INFORMADO") {
    const rt = (item.remoteType || "").toLowerCase();
    if (rt.includes("remote") || rt.includes("remoto")) {
      model = "REMOTO";
    } else if (
      rt.includes("hybrid") ||
      rt.includes("hibrido") ||
      rt.includes("híbrido")
    ) {
      model = "HIBRIDO";
    } else if (
      rt.includes("on-site") ||
      rt.includes("onsite") ||
      rt.includes("presencial")
    ) {
      model = "PRESENCIAL";
    }
  }

  let location = rawLocation || (model === "REMOTO" ? "Remoto" : "Brasil");
  if (
    model === "REMOTO" &&
    (!rawLocation ||
      rawLocation.toLowerCase().includes("remote") ||
      rawLocation.toLowerCase().includes("remoto"))
  ) {
    location = "Remoto";
  }

  const contractType: ContractType = detectContractType(
    `${title} ${item.timeType || ""} ${bulletText}`,
    "CLT",
  );
  const seniorityLevel: SeniorityLevel = detectSeniority(title);
  const stack = extractStack(`${title} ${bulletText}`);

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "WORKDAY",
    stack,
    description: `Local: ${location} | Publicado: ${item.postedOn || "Recente"} | ATS: Workday | Empresa: ${companyName}`,
  };
}

export class WorkdayScraper implements BaseScraper {
  public readonly id = "WORKDAY";
  public readonly name = "Workday (Enterprise & Global)";
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
    const rawCompanies: Array<{
      name: string;
      slug: string;
      link?: string;
      enabled?: boolean;
    }> = (config as any).workdayCompanies || [];

    const seenEndpoints = new Set<string>();
    const companies = rawCompanies.filter((c) => {
      if (c.enabled === false) return false;
      const parsed =
        parseWorkdayUrl(c.link || "") || parseWorkdayUrl(c.slug || "");
      if (!parsed) return false;
      const key = parsed.apiUrl.toLowerCase();
      if (seenEndpoints.has(key)) return false;
      seenEndpoints.add(key);
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
        const parsed =
          parseWorkdayUrl(company.link || "") ||
          parseWorkdayUrl(company.slug || "");
        if (parsed) {
          const response = await resilientFetch(parsed.apiUrl, {
            method: "POST",
            timeoutMs: 12000,
            maxRetries: 1,
            source: "WORKDAY",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "User-Agent":
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            },
            body: JSON.stringify({
              appliedFacets: {},
              limit: 20,
              offset: 0,
              searchText: "",
            }),
          });

          if (response.ok) {
            const data = await response.json();
            const postings: WorkdayRawJob[] = Array.isArray(data?.jobPostings)
              ? data.jobPostings
              : [];

            for (const item of postings) {
              const normalized = normalizeWorkdayJob(item, company);
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
          message: `Consultando Workday: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
