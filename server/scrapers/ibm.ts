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
import { resilientFetch } from "../utils/fetch.js";
import { BaseScraper } from "./base.js";

export interface IbmRawHitSource {
  _id?: string;
  url?: string;
  title?: string;
  description?: string;
  language?: string;
  field_keyword_05?: string; // Country (ex: "Brazil")
  field_keyword_08?: string; // Category (ex: "Software Engineering")
  field_keyword_17?: string; // Work model (ex: "Hybrid", "Remote")
  field_keyword_18?: string; // Level (ex: "Professional", "Entry Level", "Internship")
  field_keyword_19?: string; // City/State (ex: "SÃO PAULO, BR", "BRASILIA, BR")
}

export interface IbmRawHit {
  _id?: string;
  _source?: IbmRawHitSource;
}

export function normalizeIbmJob(
  hit: IbmRawHit,
): Omit<Job, "id" | "scrapedAt"> | null {
  const src = hit._source;
  if (!src || !src.title || !src.url) return null;

  const title = src.title.trim();
  const category = (src.field_keyword_08 || "").trim();
  const rawModel = (src.field_keyword_17 || "").toLowerCase().trim();
  const rawLevel = (src.field_keyword_18 || "").trim();
  const rawCity = (src.field_keyword_19 || "").trim();
  const country = (src.field_keyword_05 || "Brazil").trim();

  let workModel: WorkModel = "NAO_INFORMADO";
  if (rawModel.includes("remote") || rawModel.includes("remoto")) {
    workModel = "REMOTO";
  } else if (rawModel.includes("hybrid") || rawModel.includes("hibrido") || rawModel.includes("híbrido")) {
    workModel = "HIBRIDO";
  } else if (rawModel.includes("on-site") || rawModel.includes("onsite") || rawModel.includes("presencial")) {
    workModel = "PRESENCIAL";
  } else {
    workModel = detectWorkModel(`${title} ${src.description || ""}`);
  }

  let location = "Brasil";
  if (
    rawCity &&
    !/^no city/i.test(rawCity) &&
    !/^multiple cities/i.test(rawCity)
  ) {
    location = rawCity.replace(/,\s*BR$/i, ", SP").includes(",")
      ? rawCity
      : `${rawCity}, Brasil`;
  } else if (workModel === "REMOTO") {
    location = "Remoto, Brasil";
  } else if (country) {
    location = country === "Brazil" ? "São Paulo, SP" : country;
  }

  const contractType: ContractType =
    /intern|est[aá]gio/i.test(`${title} ${rawLevel}`)
      ? "ESTAGIO"
      : detectContractType(title, "CLT");

  const seniorityLevel: SeniorityLevel = detectSeniority(
    `${title} ${rawLevel}`,
  );

  const cleanDesc = (src.description || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);

  const stack = extractStack(`${title} ${category} ${cleanDesc}`);

  return {
    title,
    company: "IBM",
    location,
    workModel,
    contractType,
    seniorityLevel,
    url: src.url.trim(),
    source: "IBM",
    stack,
    description: cleanDesc || `Área: ${category || "Tecnologia"} | Empresa: IBM`,
  };
}

export class IbmScraper implements BaseScraper {
  public readonly id = "IBM";
  public readonly name = "IBM Careers (Brasil)";
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
    const keywords = (options.keywords || [])
      .map((k) => k.toLowerCase().trim())
      .filter(Boolean);

    const foundJobs: Job[] = [];

    try {
      if (onProgress) {
        onProgress({
          message: "Consultando IBM Careers Brasil...",
          currentCompany: "IBM",
          percent: 20,
        });
      }

      const payload = {
        appId: "careers",
        scopes: ["careers2"],
        query: { bool: { must: [] } },
        post_filter: { term: { field_keyword_05: "Brazil" } },
        _source: [
          "_id",
          "title",
          "url",
          "description",
          "language",
          "entitled",
          "field_keyword_08",
          "field_keyword_05",
          "field_keyword_17",
          "field_keyword_18",
          "field_keyword_19",
        ],
        size: 100,
        lang: "zz",
        localeSelector: { lc: "pt", cc: "br" },
      };

      const response = await resilientFetch(
        "https://www-api.ibm.com/search/api/v2",
        {
          method: "POST",
          timeoutMs: 12000,
          maxRetries: 1,
          source: "IBM",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
          body: JSON.stringify(payload),
        },
      );

      if (response.ok) {
        const data = await response.json();
        const hits: IbmRawHit[] = data?.hits?.hits || [];

        for (const hit of hits) {
          const normalized = normalizeIbmJob(hit);
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

      if (onProgress) {
        onProgress({
          message: `IBM Careers concluído (${foundJobs.length} vagas)`,
          currentCompany: "IBM",
          percent: 100,
        });
      }
    } catch {
      // Ignora falhas isoladas
    }

    return foundJobs;
  }
}
