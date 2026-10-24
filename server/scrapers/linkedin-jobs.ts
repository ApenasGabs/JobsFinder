import * as cheerio from "cheerio";
import { ConfigService } from "../services/config.js";
import { StorageService } from "../services/storage.js";
import { Job, ScrapeOptions } from "../types.js";
import {
  detectContractType,
  detectSeniority,
  detectWorkModel,
  extractStack,
} from "../utils/normalizer.js";
import { runWithConcurrency } from "../utils/pool.js";
import { resilientFetch } from "../utils/fetch.js";
import { BaseScraper } from "./base.js";

export class LinkedInJobsScraper implements BaseScraper {
  public readonly id = "LINKEDIN";
  public readonly name = "LinkedIn Jobs (Busca Pública)";
  public readonly type = "ALL" as const;
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
    const companies = ((config as any).linkedinCompanies || []).filter(
      (c: any) => c.enabled !== false,
    );
    const keywords = (options.keywords || [])
      .map((k) => k.toLowerCase().trim())
      .filter(Boolean);

    const foundJobs: Job[] = [];
    let completedCount = 0;
    const concurrency = options.concurrency || 8;

    await runWithConcurrency(companies, concurrency, async (company) => {
      try {
        const queryTerm = keywords[0]
          ? `${company.name} ${keywords[0]}`
          : company.name;

        const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(queryTerm)}&location=Brasil`;

        const response = await resilientFetch(url, {
          timeoutMs: 12000,
          maxRetries: 1,
          source: "LINKEDIN",
          headers: {
            Accept: "text/html",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });

        if (!response.ok) return;

        const html = await response.text();
        const $ = cheerio.load(html);

        $(".base-card, .job-search-card").each((_, el) => {
          const title = $(el).find(".base-search-card__title").text().replace(/\s+/g, " ").trim();
          if (!title) return;

          const linkEl = $(el).find("a.base-card__full-link");
          const jobUrl = (linkEl.attr("href") || "").split("?")[0];
          if (!jobUrl) return;

          const location = $(el).find(".job-search-card__location").text().replace(/\s+/g, " ").trim() || "Brasil";

          const fullText = `${title} ${location}`.toLowerCase();
          if (keywords.length > 0) {
            const match = keywords.some((kw) => fullText.includes(kw));
            if (!match) return;
          }

          // Extrai o ID numérico do LinkedIn se houver
          const m = jobUrl.match(/\/(\d+)(?:\/|$)/);
          const jobId = m ? m[1] : Math.abs(this.hashCode(jobUrl)).toString();

          const job: Job = {
            id: `linkedin_${jobId}`,
            title,
            company: company.name,
            location,
            workModel: detectWorkModel(`${title} ${location}`),
            contractType: detectContractType(title),
            seniorityLevel: detectSeniority(title),
            url: jobUrl,
            source: "LINKEDIN",
            stack: extractStack(title),
            scrapedAt: new Date().toISOString(),
          };

          const isNew = StorageService.saveJob(job);
          onJobFound(job, isNew);
          foundJobs.push(job);
        });
      } catch (err: any) {
        console.warn(`[LinkedInJobsScraper] Erro ao buscar vagas para ${company.name}:`, err.message);
      } finally {
        completedCount++;
        onProgress?.({
          message: `Processando LinkedIn: ${company.name}`,
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
