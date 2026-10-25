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

export interface RecrutaiRawJob {
  id?: string;
  code?: string;
  title: string;
  location?: string;
  workModel?: string;
  contractType?: string;
  address?: string;
  description?: string;
  url?: string;
}

export function extractRecrutaiSlug(slugOrUrl: string): string {
  const raw = (slugOrUrl || "").trim();
  if (!raw) return "";
  return raw
    .replace(/^https?:\/\/([^.]+)\.jobs\.recrut\.ai.*$/i, "$1")
    .replace(/\/+$/, "")
    .trim()
    .toLowerCase();
}

export function parseRecrutaiJobsHtml(html: string): RecrutaiRawJob[] {
  if (!html || typeof html !== "string") return [];

  const jobs: RecrutaiRawJob[] = [];
  const seenCodes = new Set<string>();

  const sections = html.split(
    /<h4>\s*<span class="ms-icon">\s*<i class="zmdi zmdi-pin[^"]*"><\/i>\s*<\/span>/i,
  );

  const chunks = sections.length > 1 ? sections.slice(1) : [html];

  for (const sec of chunks) {
    const locMatch = sec.match(/^\s*([^<]+?)\s*<span class="badge/i);
    const sectionLocation = locMatch ? locMatch[1].trim() : "Brasil";

    // 1. Linhas de tabela (<tr ...><td ...><a href="job/CODE">TITLE</a></td>...)
    const trRegex =
      /<tr[^>]*>\s*<td[^>]*>\s*<a\s+href="job\/([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
    let m: RegExpExecArray | null;
    while ((m = trRegex.exec(sec)) !== null) {
      const code = m[1].trim();
      if (!code || seenCodes.has(code)) continue;
      seenCodes.add(code);

      const title = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const contractType = m[3]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const workModel = m[4]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const address = m[5]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      jobs.push({
        code,
        title,
        contractType,
        workModel,
        address,
        location: sectionLocation,
      });
    }

    // 2. Cards (<div class="card">...<a href="job/CODE"...)
    const cards = sec.split(/<div class="card">/i).slice(1);
    for (const card of cards) {
      const codeMatch = card.match(/href="job\/([^"]+)"/i);
      if (!codeMatch) continue;
      const code = codeMatch[1].trim();
      if (!code || seenCodes.has(code)) continue;
      seenCodes.add(code);

      const h5Match = card.match(/<h5[^>]*>([\s\S]*?)<\/h5>/i);
      let title = "";
      if (h5Match) {
        title = h5Match[1]
          .replace(/<span class="badge[^>]*>[\s\S]*?<\/span>/gi, " ")
          .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      if (!title) {
        const altMatch = card.match(/alt="([^"]+)"/i);
        title = altMatch ? altMatch[1].trim() : "";
      }

      const contractMatch = card.match(/zmdi-file-text"><\/i>\s*([^<]+)/i);
      const workModelMatch = card.match(/zmdi-pin-account"><\/i>\s*([^<]+)/i);
      const addrMatch = card.match(/zmdi-pin"><\/i>\s*([^<]+)/i);

      jobs.push({
        code,
        title,
        contractType: contractMatch ? contractMatch[1].trim() : "",
        workModel: workModelMatch ? workModelMatch[1].trim() : "",
        address: addrMatch ? addrMatch[1].trim() : "",
        location: sectionLocation,
      });
    }
  }

  return jobs;
}

export function normalizeRecrutaiJob(
  item: RecrutaiRawJob,
  company: { name: string; slug: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  const title = (item.title || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) {
    return null;
  }

  const slug = extractRecrutaiSlug(company.slug);
  const companyName = company.name.trim();
  const code = (item.code || item.id || "").trim();

  const rawModel = (item.workModel || "").toLowerCase();
  const rawLoc = (item.location || "").toLowerCase();

  let model: WorkModel = "PRESENCIAL";
  if (
    rawModel.includes("remot") ||
    rawModel.includes("home") ||
    rawLoc.includes("vagas remotas") ||
    rawLoc === "remoto"
  ) {
    model = "REMOTO";
  } else if (rawModel.includes("hibrid") || rawModel.includes("híbrid")) {
    model = "HIBRIDO";
  } else if (rawModel.includes("presencial")) {
    model = "PRESENCIAL";
  } else {
    model = detectWorkModel(
      `${title} ${item.workModel || ""} ${item.location || ""}`,
    );
  }

  let location = (item.location || "")
    .replace(/\s*\/\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();

  if (
    !location ||
    location.toLowerCase().includes("vagas remotas") ||
    (model === "REMOTO" && location.toLowerCase().includes("remoto"))
  ) {
    location = model === "REMOTO" ? "Remoto" : "Brasil";
  } else if (location.toLowerCase().includes("diversas localidades")) {
    location = model === "REMOTO" ? "Remoto" : "Brasil";
  }

  const rawContract = (item.contractType || "").trim();
  const contractType: ContractType =
    rawContract.toLowerCase() === "efetivo"
      ? detectContractType(title, "CLT")
      : detectContractType(`${rawContract} ${title}`, "CLT");

  const seniorityLevel: SeniorityLevel = detectSeniority(title);

  const cleanDescription = (item.description || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);

  const stack = extractStack(`${title} ${cleanDescription}`);
  const jobUrl =
    item.url?.trim() ||
    (code
      ? `https://${slug}.jobs.recrut.ai/job/${code}`
      : `https://${slug}.jobs.recrut.ai`);

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "RECRUTAI",
    stack,
    description:
      cleanDescription ||
      `Contrato: ${rawContract || contractType} | Modelo: ${item.workModel || model} | Local: ${location} | ATS: Recrut.ai | Empresa: ${companyName}`,
  };
}

export class RecrutaiScraper implements BaseScraper {
  public readonly id = "RECRUTAI";
  public readonly name = "Recrut.ai (Petlove & Tech BR)";
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
    }> = (ConfigService.getConfig() as any).recrutaiCompanies || [];

    const seenSlugs = new Set<string>();
    const companies = rawCompanies.filter((c) => {
      if (c.enabled === false) return false;
      const s = extractRecrutaiSlug(c.slug || c.link || "");
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
        const cleanSlug = extractRecrutaiSlug(
          company.slug || company.link || "",
        );
        if (cleanSlug) {
          const apiUrl = `https://${encodeURIComponent(cleanSlug)}.jobs.recrut.ai/company/public-jobs/*/*/*/*/?search=`;
          const response = await resilientFetch(apiUrl, {
            timeoutMs: 12000,
            maxRetries: 1,
            source: "RECRUTAI",
            headers: {
              Accept: "application/json, text/plain, */*",
              Referer: `https://${cleanSlug}.jobs.recrut.ai/`,
              "X-Requested-With": "XMLHttpRequest",
              "User-Agent":
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            },
          });

          if (response.ok) {
            const data = await response.json();
            const rawJobs = Array.isArray(data?.jobs)
              ? (data.jobs as RecrutaiRawJob[])
              : parseRecrutaiJobsHtml(data?.html || "");

            for (const raw of rawJobs) {
              const normalized = normalizeRecrutaiJob(raw, {
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
          message: `Consultando Recrut.ai: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
