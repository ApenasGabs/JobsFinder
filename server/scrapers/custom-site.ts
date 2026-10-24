import * as cheerio from "cheerio";
import { ConfigService } from "../services/config.js";
import { StorageService } from "../services/storage.js";
import { Job, ScrapeOptions, WorkModel } from "../types.js";
import {
  detectContractType,
  detectSeniority,
  detectWorkModel,
  extractStack,
} from "../utils/normalizer.js";
import { runWithConcurrency } from "../utils/pool.js";
import { resilientFetch } from "../utils/fetch.js";
import { BaseScraper } from "./base.js";

export class CustomSiteScraper implements BaseScraper {
  public readonly id = "CUSTOM_SITE";
  public readonly name = "Portais Próprios / Carreiras";
  public readonly type = "ALL" as const;
  public readonly isFastMode = false;

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
    const companies = ((config as any).customSiteCompanies || []).filter(
      (c: any) => c.enabled !== false,
    );
    const keywords = (options.keywords || [])
      .map((k) => k.toLowerCase().trim())
      .filter(Boolean);

    const foundJobs: Job[] = [];
    let completedCount = 0;
    const concurrency = options.concurrency || 6;

    await runWithConcurrency(companies, concurrency, async (company) => {
      try {
        const portalUrl = company.link;
        if (!portalUrl) return;

        const response = await resilientFetch(portalUrl, {
          timeoutMs: 12000,
          maxRetries: 1,
          source: "CUSTOM_SITE",
          headers: {
            Accept: "text/html,application/xhtml+xml,application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });

        if (!response.ok) return;

        const html = await response.text();
        const $ = cheerio.load(html);

        let parsedAny = false;

        // 1. Procurar por Schema.org JSON-LD (Padrão Google for Jobs)
        $('script[type="application/ld+json"]').each((_, el) => {
          try {
            const rawJson = $(el).html();
            if (!rawJson) return;
            const parsed = JSON.parse(rawJson);
            const items = Array.isArray(parsed) ? parsed : (parsed["@graph"] || [parsed]);

            for (const item of items) {
              if (item["@type"] === "JobPosting") {
                const title = (item.title || "").trim();
                if (!title) continue;

                const desc = item.description || "";
                const fullText = `${title} ${desc}`.toLowerCase();

                if (keywords.length > 0) {
                  const match = keywords.some((kw) => fullText.includes(kw));
                  if (!match) continue;
                }

                const jobUrl = item.url || portalUrl;
                const location = item.jobLocation?.address?.addressLocality || "Brasil";

                const job: Job = {
                  id: `custom_${company.slug}_${Math.abs(this.hashCode(title + jobUrl))}`,
                  title,
                  company: company.name,
                  location,
                  workModel: detectWorkModel(`${title} ${desc}`),
                  contractType: detectContractType(item.employmentType || desc),
                  seniorityLevel: detectSeniority(title),
                  url: jobUrl,
                  source: "CUSTOM_SITE",
                  stack: extractStack(fullText),
                  scrapedAt: new Date().toISOString(),
                  description: desc,
                };

                const isNew = StorageService.saveJob(job);
                onJobFound(job, isNew);
                foundJobs.push(job);
                parsedAny = true;
              }
            }
          } catch {}
        });

        // 2. Se não achou JSON-LD, varre links <a> de vagas
        if (!parsedAny) {
          const seenUrls = new Set<string>();
          $("a[href]").each((_, el) => {
            const href = $(el).attr("href");
            if (!href) return;

            const isJobLink =
              /\/vaga[s]?\//i.test(href) ||
              /\/job[s]?\//i.test(href) ||
              /\/oportunidade[s]?\//i.test(href) ||
              /\/position[s]?\//i.test(href) ||
              /\/carreira[s]?\//i.test(href);

            if (!isJobLink) return;

            let fullUrl = href;
            try {
              fullUrl = new URL(href, portalUrl).toString();
            } catch {
              return;
            }

            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);

            const title = $(el).text().replace(/\s+/g, " ").trim();
            if (!title || title.length < 4 || /^(ver|veja|candidatar|saiba|mais|apply|view)$/i.test(title)) {
              return;
            }

            if (keywords.length > 0) {
              const match = keywords.some((kw) => title.toLowerCase().includes(kw));
              if (!match) return;
            }

            const job: Job = {
              id: `custom_${company.slug}_${Math.abs(this.hashCode(title + fullUrl))}`,
              title,
              company: company.name,
              location: "Brasil",
              workModel: detectWorkModel(title),
              contractType: detectContractType(title),
              seniorityLevel: detectSeniority(title),
              url: fullUrl,
              source: "CUSTOM_SITE",
              stack: extractStack(title),
              scrapedAt: new Date().toISOString(),
            };

            const isNew = StorageService.saveJob(job);
            onJobFound(job, isNew);
            foundJobs.push(job);
          });
        }
      } catch (err: any) {
        console.warn(`[CustomSiteScraper] Erro ao buscar vagas para ${company.name}:`, err.message);
      } finally {
        completedCount++;
        onProgress?.({
          message: `Processando Site Próprio: ${company.name}`,
          currentCompany: company.name,
          percent: Math.round((completedCount / companies.length) * 100),
        });
      }
    });

    return foundJobs;
  }

  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return hash;
  }
}
