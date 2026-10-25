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

export interface TotvsRawJob {
  id?: string;
  code?: string | number;
  title: string;
  departmentName?: string;
  positionName?: string;
  cityName?: string;
  stateSmallName?: string;
  pageUrl?: string;
  url?: string;
  hideLocation?: boolean | string;
  remoteString?: string;
  companyName?: string;
  isDisabled?: boolean;
}

const KNOWN_TOTVS_COMPANY_SLUGS: Record<string, string> = {
  brudam: "brudam",
  "e-inscrição tecnologia e inovação": "einscricao",
  "estuda.com": "estuda",
  "ff solutions a symetri company": "ffsolutions",
  hsystem: "hsystem",
  "morada.ai": "moradaai",
  starbem: "starbem",
  "universo e-commerce": "universoecommerce",
};

export function decodeTotvsHtmlEntities(text: string): string {
  if (!text) return "";
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function extractAttr(attrsBlock: string, attrName: string): string {
  const regex = new RegExp(`${attrName}\\s*=\\s*"([^"]*)"`, "i");
  const match = attrsBlock.match(regex);
  return match ? decodeTotvsHtmlEntities(match[1]).trim() : "";
}

export function parseTotvsHtml(html: string): TotvsRawJob[] {
  if (!html) return [];
  const jobs: TotvsRawJob[] = [];
  const blocks = html
    .split(/class="[^"]*index__job-opportunities__grid__item[^"]*"/i)
    .slice(1);

  for (const block of blocks) {
    const tagEndIdx = block.indexOf(">");
    if (tagEndIdx === -1) continue;

    const attrs = block.slice(0, tagEndIdx);
    const body = block.slice(tagEndIdx + 1, tagEndIdx + 1500);

    const id = extractAttr(attrs, "data-id");
    const code = extractAttr(attrs, "data-code");
    const title = extractAttr(attrs, "data-title");
    if (!title) continue;

    const departmentName = extractAttr(attrs, "data-department-name");
    const positionName = extractAttr(attrs, "data-position-name");
    const cityName = extractAttr(attrs, "data-city-name");
    const stateSmallName = extractAttr(attrs, "data-state-small-name");
    const pageUrl = extractAttr(attrs, "data-page-url");
    const hideLocation = extractAttr(attrs, "data-hide-location");
    const remoteString = extractAttr(attrs, "data-remote-string");

    const hrefMatch = body.match(/<a[^>]+href="([^"]+)"/i);
    const url = hrefMatch ? decodeTotvsHtmlEntities(hrefMatch[1]).trim() : undefined;

    jobs.push({
      id: id || code,
      code: code || id,
      title,
      departmentName,
      positionName,
      cityName,
      stateSmallName,
      pageUrl,
      url,
      hideLocation,
      remoteString,
    });
  }

  return jobs;
}

export function normalizeTotvsJob(
  item: TotvsRawJob,
  company: { name: string; slug: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  if (item.isDisabled === true) {
    return null;
  }

  const title = decodeTotvsHtmlEntities(item.title || "").trim();
  if (!title) {
    return null;
  }

  const slug = (company.slug || "vempratotvs")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/atracaodetalentos\.totvs\.app\//i, "")
    .replace(/\/.*$/, "");
  const companyName = (item.companyName || company.name || "TOTVS").trim();

  const city = decodeTotvsHtmlEntities(item.cityName || "").trim();
  const state = decodeTotvsHtmlEntities(item.stateSmallName || "").trim();
  const dept = decodeTotvsHtmlEntities(item.departmentName || "").trim();
  const pos = decodeTotvsHtmlEntities(item.positionName || "").trim();

  const isHideLocation =
    item.hideLocation === true ||
    String(item.hideLocation || "").toLowerCase() === "true";

  let model: WorkModel = detectWorkModel(title);
  if (model === "NAO_INFORMADO") {
    if (isHideLocation) {
      model = "REMOTO";
    } else if (city) {
      model = "PRESENCIAL";
    }
  }

  let location = "Brasil";
  if (!isHideLocation && city && state) {
    location = `${city}, ${state}`;
  } else if (!isHideLocation && city) {
    location = city;
  } else if (isHideLocation || model === "REMOTO") {
    location = "Remoto";
  } else if (state) {
    location = state;
  }

  if (model === "REMOTO" && (!city || city.toLowerCase().includes("remoto"))) {
    location = "Remoto";
  }

  const contractType: ContractType = detectContractType(
    `${title} ${pos} ${dept}`,
    "CLT",
  );
  const seniorityLevel: SeniorityLevel = detectSeniority(`${title} ${pos}`);
  const stack = extractStack(`${title} ${pos} ${dept}`);

  let jobUrl = (item.url || "").trim();
  if (!jobUrl) {
    const rawPageUrl = (item.pageUrl || "").trim();
    if (rawPageUrl.startsWith("http")) {
      jobUrl = rawPageUrl;
    } else if (rawPageUrl) {
      jobUrl = `https://atracaodetalentos.totvs.app${rawPageUrl.startsWith("/") ? "" : "/"}${rawPageUrl}`;
    } else {
      jobUrl = `https://atracaodetalentos.totvs.app/${slug}/job-opportunity/${item.code || item.id || ""}`;
    }
  }

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "TOTVS",
    stack,
    description: `Área: ${dept || pos || "Tecnologia"} | ATS: TOTVS | Empresa: ${companyName}`,
  };
}

export class TotvsScraper implements BaseScraper {
  public readonly id = "TOTVS";
  public readonly name = "TOTVS Atração de Talentos";
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
    }> = ((ConfigService.getConfig() as any).totvsCompanies || []);

    const seenSlugs = new Set<string>();
    const companies: Array<{ name: string; slug: string }> = [];

    const vempratotvsCount = rawCompanies.filter(
      (c) =>
        c.enabled !== false &&
        (c.slug || "").trim().toLowerCase() === "vempratotvs",
    ).length;

    for (const c of rawCompanies) {
      if (c.enabled === false) continue;
      let cleanSlug = (c.slug || "")
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\/atracaodetalentos\.totvs\.app\//i, "")
        .replace(/\/.*$/, "");
      if (!cleanSlug) continue;

      const nameKey = (c.name || "").trim().toLowerCase();
      if (cleanSlug === "vempratotvs" && KNOWN_TOTVS_COMPANY_SLUGS[nameKey]) {
        cleanSlug = KNOWN_TOTVS_COMPANY_SLUGS[nameKey];
      }

      if (seenSlugs.has(cleanSlug)) continue;
      seenSlugs.add(cleanSlug);

      const resolvedName =
        cleanSlug === "vempratotvs" && vempratotvsCount > 1 ? "TOTVS" : c.name;
      companies.push({ name: resolvedName, slug: cleanSlug });
    }

    const keywords = (options.keywords || [])
      .map((k) => k.toLowerCase().trim())
      .filter(Boolean);

    const foundJobs: Job[] = [];
    let completedCount = 0;
    const concurrency = options.concurrency || 6;

    await runWithConcurrency(companies, concurrency, async (company) => {
      try {
        const cleanSlug = company.slug.trim().toLowerCase();
        const portalUrl = `https://atracaodetalentos.totvs.app/${encodeURIComponent(cleanSlug)}`;
        const response = await resilientFetch(portalUrl, {
          timeoutMs: 12000,
          maxRetries: 1,
          source: "TOTVS",
          headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
        });

        if (response.ok && !response.url.includes("status=404")) {
          const html = await response.text();
          const rawJobs = parseTotvsHtml(html);

          for (const raw of rawJobs) {
            const normalized = normalizeTotvsJob(raw, company);
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
          message: `Consultando TOTVS: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
