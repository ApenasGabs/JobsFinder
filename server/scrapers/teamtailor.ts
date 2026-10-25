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

export interface TeamtailorLocation {
  name?: string;
  city?: string;
  country?: string;
  address?: string;
}

export interface TeamtailorRawJob {
  id?: string;
  guid?: string;
  title: string;
  description?: string;
  pubDate?: string;
  link?: string;
  url?: string;
  remoteStatus?: string; // "none" | "hybrid" | "fully" | "temporary"
  department?: string;
  role?: string;
  city?: string;
  country?: string;
  locations?: TeamtailorLocation[];
  isDisabled?: boolean;
}

function decodeXmlEntities(text: string): string {
  if (!text) return "";
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function extractXmlTag(block: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = block.match(regex);
  return match ? decodeXmlEntities(match[1]).trim() : "";
}

export function parseTeamtailorRss(xml: string): TeamtailorRawJob[] {
  if (!xml) return [];
  const jobs: TeamtailorRawJob[] = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi);

  for (const match of itemMatches) {
    const itemXml = match[1];
    const title = extractXmlTag(itemXml, "title");
    if (!title) continue;

    const description = extractXmlTag(itemXml, "description");
    const pubDate = extractXmlTag(itemXml, "pubDate");
    const link = extractXmlTag(itemXml, "link");
    const remoteStatus = extractXmlTag(itemXml, "remoteStatus");
    const guid = extractXmlTag(itemXml, "guid");
    const department = extractXmlTag(itemXml, "tt:department");
    const role = extractXmlTag(itemXml, "tt:role");

    const locations: TeamtailorLocation[] = [];
    const locMatches = itemXml.matchAll(
      /<tt:location>([\s\S]*?)<\/tt:location>/gi,
    );
    for (const locMatch of locMatches) {
      const locXml = locMatch[1];
      locations.push({
        name: extractXmlTag(locXml, "tt:name"),
        city: extractXmlTag(locXml, "tt:city"),
        country: extractXmlTag(locXml, "tt:country"),
        address: extractXmlTag(locXml, "tt:address"),
      });
    }

    jobs.push({
      id: guid || link,
      guid,
      title,
      description,
      pubDate,
      link,
      remoteStatus,
      department,
      role,
      locations,
    });
  }

  return jobs;
}

export function normalizeTeamtailorJob(
  item: TeamtailorRawJob,
  company: { name: string; slug: string; link?: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  if (item.isDisabled === true) {
    return null;
  }

  const title = decodeXmlEntities(item.title || "").trim();
  if (!title) {
    return null;
  }

  const companyName = (company.name || "Teamtailor").trim();
  const slug = (company.slug || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");

  const rawDesc = decodeXmlEntities(item.description || "");
  const cleanDescription = rawDesc
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);

  let model: WorkModel = "NAO_INFORMADO";
  const rs = (item.remoteStatus || "").toLowerCase().trim();
  if (rs === "fully" || rs === "remote" || rs === "remoto") {
    model = "REMOTO";
  } else if (
    rs === "hybrid" ||
    rs === "hibrido" ||
    rs === "híbrido" ||
    rs === "temporary"
  ) {
    model = "HIBRIDO";
  } else {
    model = detectWorkModel(`${title} ${cleanDescription}`);
    if (model === "NAO_INFORMADO" && rs === "none") {
      model = "PRESENCIAL";
    }
  }

  const firstLoc = item.locations?.[0];
  const city = (item.city || firstLoc?.city || firstLoc?.name || "").trim();
  const country = (item.country || firstLoc?.country || "").trim();

  let location = "Global";
  if (city && country && city.toLowerCase() !== country.toLowerCase()) {
    location = `${city}, ${country}`;
  } else if (city) {
    location = city;
  } else if (country) {
    location = country;
  } else if (model === "REMOTO") {
    location = "Remoto";
  }

  if (
    model === "REMOTO" &&
    (!city ||
      city.toLowerCase().includes("remoto") ||
      city.toLowerCase().includes("remote"))
  ) {
    location = "Remoto";
  }

  const dept = (item.department || item.role || "").trim();
  const contractType: ContractType = detectContractType(
    `${title} ${cleanDescription}`,
    "CLT",
  );
  const seniorityLevel: SeniorityLevel = detectSeniority(
    `${title} ${item.role || ""}`,
  );
  const stack = extractStack(`${title} ${dept} ${cleanDescription}`);

  const baseHost = slug.includes("teamtailor.com")
    ? slug
    : `${slug}.teamtailor.com`;
  const jobUrl =
    (item.link || item.url || "").trim() ||
    `https://${baseHost}/jobs/${item.guid || item.id || ""}`;

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "TEAMTAILOR",
    stack,
    description:
      cleanDescription ||
      `Área: ${dept || "Tecnologia"} | ATS: Teamtailor | Empresa: ${companyName}`,
  };
}

export class TeamtailorScraper implements BaseScraper {
  public readonly id = "TEAMTAILOR";
  public readonly name = "Teamtailor (Loft & Global Tech)";
  public readonly type = "CLT" as const;
  public readonly isFastMode = true;

  private buildCandidateRssUrls(company: {
    slug: string;
    link?: string;
  }): string[] {
    const urls: string[] = [];
    const link = (company.link || "").trim().replace(/\/+$/, "");
    if (link && link.includes("teamtailor.com")) {
      urls.push(`${link.replace(/\/jobs(\.rss)?$/i, "")}/jobs.rss`);
    }

    const cleanSlug = (company.slug || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "");

    if (cleanSlug) {
      if (cleanSlug.includes("teamtailor.com")) {
        urls.push(`https://${cleanSlug}/jobs.rss`);
      } else {
        urls.push(`https://${cleanSlug}.teamtailor.com/jobs.rss`);
        if (!cleanSlug.endsWith(".na")) {
          urls.push(`https://${cleanSlug}.na.teamtailor.com/jobs.rss`);
        }
      }
    }

    return Array.from(new Set(urls));
  }

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
    }> = ((ConfigService.getConfig() as any).teamtailorCompanies || []);

    const seenSlugs = new Set<string>();
    const companies = rawCompanies.filter((c) => {
      if (c.enabled === false) return false;
      const s = (c.slug || "").trim().toLowerCase();
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
        const candidateUrls = this.buildCandidateRssUrls(company);
        let xmlText = "";

        for (const rssUrl of candidateUrls) {
          const response = await resilientFetch(rssUrl, {
            timeoutMs: 12000,
            maxRetries: 1,
            source: "TEAMTAILOR",
            headers: {
              Accept:
                "application/rss+xml, application/xml, text/xml, text/html, */*",
              "User-Agent":
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            },
          });

          if (response.ok) {
            xmlText = await response.text();
            break;
          }
        }

        if (xmlText) {
          const rawJobs = parseTeamtailorRss(xmlText);
          for (const raw of rawJobs) {
            const normalized = normalizeTeamtailorJob(raw, company);
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
          message: `Consultando Teamtailor: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
