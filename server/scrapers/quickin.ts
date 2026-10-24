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

export class QuickinScraper implements BaseScraper {
  public readonly id = "QUICKIN";
  public readonly name = "Quickin (Tech & Startups)";
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
    const companies = ((config as any).quickinCompanies || []).filter(
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
        const portalUrl = company.link || `https://jobs.quickin.io/${company.slug}`;
        const response = await resilientFetch(portalUrl, {
          timeoutMs: 12000,
          maxRetries: 1,
          source: "QUICKIN",
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });

        if (!response.ok) return;

        const html = await response.text();
        const $ = cheerio.load(html);

        // Quickin job links typically follow: href="*/jobs/*"
        const seenLinks = new Set<string>();

        $("a[href*='/jobs/']").each((_, el) => {
          const href = $(el).attr("href");
          if (!href) return;

          const jobUrl = href.startsWith("http")
            ? href
            : `https://jobs.quickin.io${href.startsWith("/") ? "" : "/"}${href}`;

          if (seenLinks.has(jobUrl)) return;
          seenLinks.add(jobUrl);

          const title = $(el).text().replace(/\s+/g, " ").trim();
          if (!title || title.length < 3 || title.toLowerCase() === "ver vaga") return;

          const fullText = `${title}`.toLowerCase();
          if (keywords.length > 0) {
            const matches = keywords.some((kw) => fullText.includes(kw));
            if (!matches) return;
          }

          const parts = jobUrl.split("/");
          const jobId = parts[parts.length - 1] || parts[parts.length - 2];

          const job: Job = {
            id: `quickin_${company.slug}_${jobId}`,
            title,
            company: company.name,
            location: "Brasil",
            workModel: detectWorkModel(title),
            contractType: detectContractType(title),
            seniorityLevel: detectSeniority(title),
            url: jobUrl,
            source: "QUICKIN",
            stack: extractStack(title),
            scrapedAt: new Date().toISOString(),
          };

          const isNew = StorageService.saveJob(job);
          onJobFound(job, isNew);
          foundJobs.push(job);
        });
      } catch (err: any) {
        console.warn(`[QuickinScraper] Erro ao buscar vagas para ${company.name}:`, err.message);
      } finally {
        completedCount++;
        onProgress?.({
          message: `Processando Quickin: ${company.name}`,
          currentCompany: company.name,
          percent: Math.round((completedCount / companies.length) * 100),
        });
      }
    });

    return foundJobs;
  }
}
