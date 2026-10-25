import * as cheerio from "cheerio";
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

export interface PandapeRawJob {
  id: string | number;
  title: string;
  url?: string;
  location?: string;
  workModelText?: string;
  contractText?: string;
  workingHours?: string;
  salary?: string;
  datePosted?: string;
  description?: string;
  isPcd?: boolean;
}

export function extractPandapeSlug(slugOrUrl: string): string {
  if (!slugOrUrl || typeof slugOrUrl !== "string") return "";
  const raw = slugOrUrl.trim().toLowerCase();
  if (!raw) return "";

  const hostMatch = raw.match(
    /^(?:https?:\/\/)?([a-z0-9-]+)\.pandape\.infojobs\.com\.br/i,
  );
  if (hostMatch) {
    return hostMatch[1].toLowerCase();
  }

  return raw.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
}

export function parsePandapeHtml(
  html: string,
  company?: { name?: string; slug?: string; link?: string },
): PandapeRawJob[] {
  if (!html || typeof html !== "string") return [];

  const slug = extractPandapeSlug(company?.slug || company?.link || "");
  const baseUrl = slug
    ? `https://${slug}.pandape.infojobs.com.br`
    : "https://www.pandape.infojobs.com.br";

  const $ = cheerio.load(html);
  const results: PandapeRawJob[] = [];
  const seenIds = new Set<string>();

  // 1) Layout padrão de cards (<a class="card card-vacancy" href="/Detail/123456">)
  $("a.card-vacancy, a[href*='/Detail/']").each((_, el) => {
    const $el = $(el);
    const href = ($el.attr("href") || "").trim();
    const idMatch = href.match(/\/Detail\/(\d+)/i);
    if (!idMatch) return;

    const id = idMatch[1];
    if (seenIds.has(id)) return;

    // Verifica se é um card completo ou um link simples (.vacancy-item)
    const isCard =
      $el.hasClass("card-vacancy") || $el.find(".card-body, h3").length > 0;

    if (isCard) {
      const h3 = $el.find("h3").first();
      const title = (h3.attr("title") || h3.text() || "").replace(/\s+/g, " ").trim();
      if (!title) return;

      const extractByIcon = (iconClass: string): string => {
        const icon = $el.find(`i.${iconClass}`).first();
        if (!icon.length) return "";
        const iconContainer = icon.closest(".icon-container");
        const container = iconContainer.length
          ? iconContainer.parent()
          : icon.parent();
        return container.text().replace(/\s+/g, " ").trim();
      };

      const location = extractByIcon("icon-location-pin-1");
      const workModelText =
        extractByIcon("icon-building-house") ||
        extractByIcon("icon-user-with-headphones") ||
        extractByIcon("icon-buildings");
      const contractText = extractByIcon("icon-sheet");
      const workingHours = extractByIcon("icon-clock");
      const salary = extractByIcon("icon-wallet");
      const isPcd = $el.find("i.icon-sign-disable").length > 0;
      const datePosted = $el.find(".vacancy-date").first().text().replace(/\s+/g, " ").trim();

      seenIds.add(id);
      results.push({
        id,
        title,
        url: href.startsWith("http") ? href : `${baseUrl}/Detail/${id}`,
        location: location || undefined,
        workModelText: workModelText || undefined,
        contractText: contractText || undefined,
        workingHours: workingHours || undefined,
        salary: salary || undefined,
        datePosted: datePosted || undefined,
        isPcd,
      });
    } else if ($el.hasClass("vacancy-item")) {
      const title = $el.text().replace(/\s+/g, " ").trim();
      if (!title) return;

      const wrapper = $el.closest("div");
      const location = wrapper
        .find(".i_address")
        .parent()
        .text()
        .replace(/\s+/g, " ")
        .trim();
      const contractText = wrapper
        .find(".i_contract")
        .parent()
        .text()
        .replace(/\s+/g, " ")
        .trim();
      const workingHours = wrapper
        .find(".i_workday")
        .parent()
        .text()
        .replace(/\s+/g, " ")
        .trim();
      const salary = wrapper
        .find(".i_salary")
        .parent()
        .text()
        .replace(/\s+/g, " ")
        .trim();
      const workModelText = wrapper
        .find("i.icon-building-house, i.icon-user-with-headphones, i.icon-buildings")
        .closest("span")
        .text()
        .replace(/\s+/g, " ")
        .trim();

      seenIds.add(id);
      results.push({
        id,
        title,
        url: href.startsWith("http") ? href : `${baseUrl}/Detail/${id}`,
        location: location || undefined,
        workModelText: workModelText || undefined,
        contractText: contractText || undefined,
        workingHours: workingHours || undefined,
        salary: salary || undefined,
      });
    }
  });

  return results;
}

export function normalizePandapeJob(
  item: PandapeRawJob,
  company: { name: string; slug: string; link?: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  if (!item || item.id === undefined || item.id === null) return null;
  const idStr = String(item.id).trim();
  const title = (item.title || "").replace(/\s+/g, " ").trim();
  if (!idStr || !title) return null;

  const slug =
    extractPandapeSlug(company.slug || company.link || "") || "empregos";
  const companyName = (company.name || slug).trim();

  const wmRaw = (item.workModelText || "").toLowerCase().trim();
  let model: WorkModel = "PRESENCIAL";
  if (
    wmRaw.includes("remoto") ||
    wmRaw.includes("home office") ||
    wmRaw.includes("teletrabalho")
  ) {
    model = "REMOTO";
  } else if (wmRaw.includes("hibrido") || wmRaw.includes("híbrido")) {
    model = "HIBRIDO";
  } else if (wmRaw.includes("presencial")) {
    model = "PRESENCIAL";
  } else {
    const detected = detectWorkModel(
      `${title} ${item.location || ""} ${item.workModelText || ""}`,
    );
    model = detected === "NAO_INFORMADO" ? "PRESENCIAL" : detected;
  }

  const rawLocation = (item.location || "")
    .replace(/\s*-\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();

  let location = rawLocation || (model === "REMOTO" ? "Remoto" : "Brasil");
  if (
    model === "REMOTO" &&
    (!rawLocation ||
      rawLocation.toLowerCase().includes("todo brasil") ||
      rawLocation.toLowerCase().includes("remoto"))
  ) {
    location = "Remoto";
  }

  const contractType: ContractType = detectContractType(
    `${title} ${item.contractText || ""}`,
    "CLT",
  );
  const seniorityLevel: SeniorityLevel = detectSeniority(title);

  const cleanDescription = (item.description || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);

  const stack = extractStack(`${title} ${cleanDescription}`);
  const jobUrl =
    item.url?.trim() ||
    `https://${slug}.pandape.infojobs.com.br/Detail/${idStr}`;

  const salary = item.salary?.replace(/\s+/g, " ").trim() || undefined;

  const metaParts = [
    item.contractText ? `Contrato: ${item.contractText}` : "",
    item.workModelText ? `Modelo: ${item.workModelText}` : "",
    item.workingHours ? `Jornada: ${item.workingHours}` : "",
    `ATS: Pandapé | Empresa: ${companyName}`,
  ].filter(Boolean);

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    salary,
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "PANDAPE",
    stack,
    description: cleanDescription || metaParts.join(" | "),
  };
}

export class PandapeScraper implements BaseScraper {
  public readonly id = "PANDAPE";
  public readonly name = "Pandapé Infojobs (Brasil)";
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
    const config = ConfigService.getConfig() as any;
    const rawCompanies: Array<{
      name: string;
      slug: string;
      link?: string;
      enabled?: boolean;
    }> = config.pandapeCompanies || [];

    const seenSlugs = new Set<string>();
    const companies = rawCompanies.filter((c) => {
      if (c.enabled === false) return false;
      const s = extractPandapeSlug(c.slug || c.link || "");
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
        const cleanSlug = extractPandapeSlug(company.slug || company.link || "");
        if (cleanSlug) {
          const baseUrl = `https://${cleanSlug}.pandape.infojobs.com.br`;
          const rawJobs: PandapeRawJob[] = [];
          const seenIds = new Set<string>();

          // 1) Consulta o endpoint interno /ListVacancies (retorna JSON com HTML padronizado de cards)
          const listUrl = `${baseUrl}/ListVacancies`;
          const postRes = await resilientFetch(listUrl, {
            method: "POST",
            timeoutMs: 12000,
            maxRetries: 1,
            source: "PANDAPE",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
              Accept: "application/json, text/javascript, */*; q=0.01",
              "User-Agent":
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            },
            body: "PageNumber=1&PageSize=20",
          });

          if (postRes.ok) {
            const payload = await postRes.json();
            if (typeof payload?.view === "string") {
              for (const item of parsePandapeHtml(payload.view, company)) {
                const key = String(item.id);
                if (!seenIds.has(key)) {
                  seenIds.add(key);
                  rawJobs.push(item);
                }
              }
            }

            if (payload?.isLast === false) {
              try {
                const nextRes = await resilientFetch(listUrl, {
                  method: "POST",
                  timeoutMs: 8000,
                  maxRetries: 0,
                  source: "PANDAPE",
                  headers: {
                    "Content-Type":
                      "application/x-www-form-urlencoded; charset=UTF-8",
                    "X-Requested-With": "XMLHttpRequest",
                    Accept: "application/json",
                  },
                  body: "PageNumber=2&PageSize=20",
                });
                if (nextRes.ok) {
                  const nextPayload = await nextRes.json();
                  if (typeof nextPayload?.view === "string") {
                    for (const item of parsePandapeHtml(
                      nextPayload.view,
                      company,
                    )) {
                      const key = String(item.id);
                      if (!seenIds.has(key)) {
                        seenIds.add(key);
                        rawJobs.push(item);
                      }
                    }
                  }
                }
              } catch {
                // Ignora erro na página secundária
              }
            }
          }

          // 2) Fallback: consulta o HTML direto da página da empresa
          if (rawJobs.length === 0) {
            const htmlRes = await resilientFetch(baseUrl, {
              timeoutMs: 12000,
              maxRetries: 1,
              source: "PANDAPE",
              headers: {
                Accept: "text/html,application/xhtml+xml",
                "User-Agent":
                  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
              },
            });
            if (htmlRes.ok) {
              const html = await htmlRes.text();
              for (const item of parsePandapeHtml(html, company)) {
                const key = String(item.id);
                if (!seenIds.has(key)) {
                  seenIds.add(key);
                  rawJobs.push(item);
                }
              }
            }
          }

          for (const raw of rawJobs) {
            const normalized = normalizePandapeJob(raw, company);
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
          message: `Consultando Pandapé: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
