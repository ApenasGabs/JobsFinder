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
import { BaseScraper } from "./base.js";

interface GreenhouseRawJob {
  id: number | string;
  title: string;
  absolute_url: string;
  location?: {
    name?: string;
  };
  departments?: Array<{ name: string }>;
  updated_at?: string;
}

export class GreenhouseScraper implements BaseScraper {
  public readonly id = "GREENHOUSE";
  public readonly name = "Greenhouse (Top Tech)";
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
    const companies = (config.greenhouseCompanies || []).filter(
      (c) => c.enabled !== false,
    );
    const keywords = (options.keywords || [])
      .map((k) => k.toLowerCase().trim())
      .filter(Boolean);

    const foundJobs: Job[] = [];
    let completedCount = 0;
    const concurrency = options.concurrency || 10;

    await runWithConcurrency(companies, concurrency, async (company) => {
      try {
        const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs?content=true`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        const response = await fetch(apiUrl, {
          headers: {
            Accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.ok) {
          const data = await response.json();
          const jobsList: GreenhouseRawJob[] = data.jobs || [];

          for (const item of jobsList) {
            const title = item.title || "Vaga sem título";
            const dept = item.departments?.map((d) => d.name).join(", ") || "";
            const textToMatch = `${title} ${dept}`.toLowerCase();

            if (keywords.length > 0) {
              const matches = keywords.some((k) => textToMatch.includes(k));
              if (!matches) continue;
            }

            const locationName = item.location?.name || "";
            let model: WorkModel = detectWorkModel(`${title} ${locationName}`);
            const location =
              locationName || (model === "REMOTO" ? "Remoto" : "Global");

            const contractType = detectContractType(title, "CLT");
            const seniorityLevel = detectSeniority(title);
            const jobUrl =
              item.absolute_url ||
              `https://boards.greenhouse.io/${company.slug}/jobs/${item.id}`;
            const stack = extractStack(`${title} ${dept}`);

            const jobData = {
              title,
              company: company.name,
              location,
              workModel: model,
              contractType,
              seniorityLevel,
              url: jobUrl,
              source: "GREENHOUSE",
              stack,
              description: `Departamento: ${dept || "Geral"} | ATS: Greenhouse`,
            };

            const { job, isNew } = StorageService.upsertJob(jobData);
            foundJobs.push(job);
            onJobFound(job, isNew);
          }
        }
      } catch {
        // Ignora erros individuais
      }

      completedCount++;
      if (onProgress) {
        const percent = Math.round((completedCount / companies.length) * 100);
        onProgress({
          message: `Consultando Greenhouse: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
