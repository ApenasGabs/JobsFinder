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

export interface EightfoldRawJob {
  id: number | string;
  name?: string;
  posting_name?: string;
  location?: string;
  locations?: string[];
  standardizedLocations?: string[];
  department?: string | null;
  business_unit?: string | null;
  job_description?: string;
  work_location_option?: string | null;
  workLocationOption?: string | null;
  location_flexibility?: string | null;
  locationFlexibility?: string | null;
  canonicalPositionUrl?: string;
  positionUrl?: string;
  ats_job_id?: string;
  atsJobId?: string;
  display_job_id?: string;
  displayJobId?: string;
  isPrivate?: boolean;
}

export interface EightfoldParsedUrl {
  host: string;
  domain: string;
  baseUrl: string;
  applyApiUrl: string;
  pcsxApiUrl: string;
}

const KNOWN_EIGHTFOLD_TARGETS: Record<string, { host: string; domain: string }> =
  {
    mercadolibre: {
      host: "mercadolibre.eightfold.ai",
      domain: "mercadolibre.com",
    },
    netflix: {
      host: "explore.jobs.netflix.net",
      domain: "netflix.com",
    },
    "coca-colafemsa": {
      host: "coca-colafemsa.eightfold.ai",
      domain: "coca-colafemsa.com",
    },
    fortive: {
      host: "fortive.eightfold.ai",
      domain: "fortive.com",
    },
    ralliant: {
      host: "ralliant.eightfold.ai",
      domain: "ralliant.com",
    },
  };

export function parseEightfoldUrl(
  urlOrSlug: string,
): EightfoldParsedUrl | null {
  if (!urlOrSlug || typeof urlOrSlug !== "string") return null;
  const raw = urlOrSlug.trim();
  if (!raw) return null;

  const known = KNOWN_EIGHTFOLD_TARGETS[raw.toLowerCase()];
  if (known) {
    const baseUrl = `https://${known.host}`;
    return {
      host: known.host,
      domain: known.domain,
      baseUrl,
      applyApiUrl: `${baseUrl}/api/apply/v2/jobs?domain=${encodeURIComponent(known.domain)}&start=0&num=20`,
      pcsxApiUrl: `${baseUrl}/api/pcsx/search?domain=${encodeURIComponent(known.domain)}&query=&location=&start=0`,
    };
  }

  if (!raw.includes(".") && !raw.includes("/")) {
    const slug = raw.toLowerCase();
    const host = `${slug}.eightfold.ai`;
    const domain = `${slug}.com`;
    const baseUrl = `https://${host}`;
    return {
      host,
      domain,
      baseUrl,
      applyApiUrl: `${baseUrl}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&start=0&num=20`,
      pcsxApiUrl: `${baseUrl}/api/pcsx/search?domain=${encodeURIComponent(domain)}&query=&location=&start=0`,
    };
  }

  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withProto);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) return null;

  let domain = parsed.searchParams.get("domain")?.trim().toLowerCase() || "";
  if (!domain) {
    const efMatch = host.match(/^([^.]+)\.eightfold\.ai$/i);
    if (efMatch) {
      domain = `${efMatch[1].toLowerCase()}.com`;
    } else if (host.includes("netflix")) {
      domain = "netflix.com";
    } else {
      const parts = host.split(".");
      domain = parts.length >= 2 ? parts.slice(-2).join(".") : host;
    }
  }

  const baseUrl = `https://${host}`;
  return {
    host,
    domain,
    baseUrl,
    applyApiUrl: `${baseUrl}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&start=0&num=20`,
    pcsxApiUrl: `${baseUrl}/api/pcsx/search?domain=${encodeURIComponent(domain)}&query=&location=&start=0`,
  };
}

export function normalizeEightfoldJob(
  item: EightfoldRawJob,
  company: { name: string; slug: string; link?: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  if (item.isPrivate === true) {
    return null;
  }

  const title = (item.name || item.posting_name || "").trim();
  if (!title) return null;

  const companyName = company.name.trim();
  const parsed =
    parseEightfoldUrl(company.link || "") ||
    parseEightfoldUrl(company.slug || "");
  const baseUrl = parsed ? parsed.baseUrl : "https://mercadolibre.eightfold.ai";

  let jobUrl = `${baseUrl}/careers/job/${item.id}`;
  if (
    item.canonicalPositionUrl &&
    /^https?:\/\//i.test(item.canonicalPositionUrl.trim())
  ) {
    jobUrl = item.canonicalPositionUrl.trim();
  } else if (item.positionUrl) {
    const posUrl = item.positionUrl.trim();
    jobUrl = /^https?:\/\//i.test(posUrl)
      ? posUrl
      : `${baseUrl}${posUrl.startsWith("/") ? "" : "/"}${posUrl}`;
  }

  const rawLocation = (item.location || item.locations?.[0] || "").trim();
  const wlo = (
    item.work_location_option ||
    item.workLocationOption ||
    item.location_flexibility ||
    item.locationFlexibility ||
    ""
  ).toLowerCase();

  let model: WorkModel = detectWorkModel(`${title} ${rawLocation}`);
  if (model === "NAO_INFORMADO") {
    if (wlo.includes("remote") || wlo.includes("remoto")) {
      model = "REMOTO";
    } else if (
      wlo.includes("hybrid") ||
      wlo.includes("hibrido") ||
      wlo.includes("híbrido")
    ) {
      model = "HIBRIDO";
    } else if (
      wlo.includes("onsite") ||
      wlo.includes("on-site") ||
      wlo.includes("presencial")
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

  const dept = (item.department || item.business_unit || "").trim();
  const cleanDescription = (item.job_description || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);

  const contractType: ContractType = detectContractType(
    `${title} ${dept}`,
    "CLT",
  );
  const seniorityLevel: SeniorityLevel = detectSeniority(title);
  const stack = extractStack(`${title} ${dept} ${cleanDescription}`);

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "EIGHTFOLD",
    stack,
    description:
      cleanDescription ||
      `Área: ${dept || "Tecnologia"} | Local: ${location} | ATS: Eightfold | Empresa: ${companyName}`,
  };
}

export class EightfoldScraper implements BaseScraper {
  public readonly id = "EIGHTFOLD";
  public readonly name = "Eightfold.ai (Meli, Netflix & Global)";
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
    }> = (config as any).eightfoldCompanies || [];

    const seenHosts = new Set<string>();
    const companies = rawCompanies.filter((c) => {
      if (c.enabled === false) return false;
      const parsed =
        parseEightfoldUrl(c.link || "") || parseEightfoldUrl(c.slug || "");
      if (!parsed) return false;
      const key = `${parsed.host}|${parsed.domain}`.toLowerCase();
      if (seenHosts.has(key)) return false;
      seenHosts.add(key);
      return true;
    });

    const keywords = (options.keywords || [])
      .map((k) => k.toLowerCase().trim())
      .filter(Boolean);

    const foundJobs: Job[] = [];
    let completedCount = 0;
    const concurrency = options.concurrency || 4;

    await runWithConcurrency(companies, concurrency, async (company) => {
      try {
        const parsed =
          parseEightfoldUrl(company.link || "") ||
          parseEightfoldUrl(company.slug || "");
        if (parsed) {
          const headers = {
            Accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          };

          let positions: EightfoldRawJob[] = [];

          // 1) Tenta endpoint PCSX (/api/pcsx/search) usado por Mercado Livre, Fortive, Ralliant
          const pcsxRes = await resilientFetch(parsed.pcsxApiUrl, {
            timeoutMs: 12000,
            maxRetries: 0,
            source: "EIGHTFOLD",
            headers,
          });

          if (pcsxRes.ok) {
            const pcsxData = await pcsxRes.json();
            if (Array.isArray(pcsxData?.data?.positions)) {
              positions = pcsxData.data.positions;
            }
          }

          // 2) Fallback para endpoint Apply v2 (/api/apply/v2/jobs) usado por Netflix, Coca-Cola FEMSA
          if (positions.length === 0) {
            const applyRes = await resilientFetch(parsed.applyApiUrl, {
              timeoutMs: 12000,
              maxRetries: 1,
              source: "EIGHTFOLD",
              headers,
            });
            if (applyRes.ok) {
              const applyData = await applyRes.json();
              if (Array.isArray(applyData?.positions)) {
                positions = applyData.positions;
              }
            }
          }

          for (const item of positions) {
            const normalized = normalizeEightfoldJob(item, company);
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
          message: `Consultando Eightfold: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
