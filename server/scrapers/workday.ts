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

export class WorkdayScraper implements BaseScraper {
  public readonly id = "WORKDAY";
  public readonly name = "Workday (Grandes Corporações)";
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
    const companies = ((config as any).workdayCompanies || []).filter(
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
        const link = company.link || "";
        const urlObj = new URL(link.startsWith("http") ? link : `https://${link}`);
        const host = urlObj.hostname; // e.g. thomsonreuters.wd5.myworkdayjobs.com
        const sub = host.split(".")[0];
        const pathParts = urlObj.pathname.split("/").filter(Boolean);
        
        // Ex: /pt-BR/External_Career_Site or /en-US/Careers or /External_Career_Site
        let site = "External_Career_Site";
        for (const p of pathParts) {
          if (p.toLowerCase().includes("career") || p.toLowerCase().includes("external") || p.toLowerCase().includes("site") || p.toLowerCase().includes("jobs")) {
            site = p;
            break;
          }
        }
        if (pathParts.length > 0 && !site) {
          site = pathParts[pathParts.length - 1];
        }

        const tenant = (company as any).tenant || sub;
        const apiUrl = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;

        const response = await resilientFetch(apiUrl, {
          method: "POST",
          timeoutMs: 12000,
          maxRetries: 1,
          source: "WORKDAY",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          body: JSON.stringify({
            appliedFacets: {},
            limit: 20,
            offset: 0,
            searchText: keywords[0] || "",
          }),
        });

        if (!response.ok) return;

        const payload = await response.json();
        const rawJobs: any[] = payload.jobPostings || [];

        for (const item of rawJobs) {
          const title = (item.title || "").trim();
          if (!title) continue;

          const locText = item.locationsText || "";
          const fullText = `${title} ${locText}`.toLowerCase();

          if (keywords.length > 0) {
            const matchesKeyword = keywords.some((kw) => fullText.includes(kw));
            if (!matchesKeyword) continue;
          }

          const externalPath = item.externalPath || "";
          const jobUrl = externalPath.startsWith("http")
            ? externalPath
            : `https://${host}${externalPath}`;

          const idKey = item.bulletFields?.[0] || externalPath || title;

          const job: Job = {
            id: `workday_${company.slug}_${idKey.replace(/[^a-zA-Z0-9_-]/g, "")}`,
            title,
            company: company.name,
            location: locText || "Brasil",
            workModel: detectWorkModel(`${title} ${locText}`),
            contractType: detectContractType(item.timeType || title),
            seniorityLevel: detectSeniority(title),
            url: jobUrl,
            source: "WORKDAY",
            stack: extractStack(title),
            scrapedAt: new Date().toISOString(),
          };

          const isNew = StorageService.saveJob(job);
          onJobFound(job, isNew);
          foundJobs.push(job);
        }
      } catch (err: any) {
        console.warn(`[WorkdayScraper] Erro ao buscar vagas para ${company.name}:`, err.message);
      } finally {
        completedCount++;
        onProgress?.({
          message: `Processando Workday: ${company.name}`,
          currentCompany: company.name,
          percent: Math.round((completedCount / companies.length) * 100),
        });
      }
    });

    return foundJobs;
  }
}
