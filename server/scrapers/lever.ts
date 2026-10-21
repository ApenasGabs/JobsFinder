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

interface LeverRawJob {
  id: string;
  text: string;
  createdAt?: number;
  categories?: {
    commitment?: string;
    location?: string;
    team?: string;
    department?: string;
  };
  hostedUrl?: string;
  applyUrl?: string;
  workplaceType?: string;
}

export class LeverScraper implements BaseScraper {
  public readonly id = "LEVER";
  public readonly name = "Lever (25 Tech & Startups)";
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
    const companies = (config.leverCompanies || []).filter(
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
        const apiUrl = `https://api.lever.co/v0/postings/${company.slug}?mode=json`;
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
          const jobsList: LeverRawJob[] = await response.json();

          if (Array.isArray(jobsList)) {
            for (const item of jobsList) {
              const title = item.text || "Vaga sem título";
              const team =
                item.categories?.team || item.categories?.department || "";
              const textToMatch = `${title} ${team}`.toLowerCase();

              if (keywords.length > 0) {
                const matches = keywords.some((k) => textToMatch.includes(k));
                if (!matches) continue;
              }

              let model: WorkModel = "NAO_INFORMADO";
              const wp = item.workplaceType?.toLowerCase();
              if (wp === "remote") model = "REMOTO";
              else if (wp === "hybrid") model = "HIBRIDO";
              else if (wp === "onsite" || wp === "on-site")
                model = "PRESENCIAL";
              else
                model = detectWorkModel(
                  title + " " + (item.categories?.location || ""),
                );

              const location =
                item.categories?.location ||
                (model === "REMOTO" ? "Remoto" : "Global");
              const contractType = detectContractType(
                item.categories?.commitment || title,
                "CLT",
              );
              const seniorityLevel = detectSeniority(title);
              const jobUrl =
                item.hostedUrl ||
                `https://jobs.lever.co/${company.slug}/${item.id}`;
              const stack = extractStack(`${title} ${team}`);

              const jobData = {
                title,
                company: company.name,
                location,
                workModel: model,
                contractType,
                seniorityLevel,
                url: jobUrl,
                source: "LEVER",
                stack,
                description: `Time: ${team || "Engenharia"} | Tipo: ${item.categories?.commitment || "Full-time"}`,
              };

              const { job, isNew } = StorageService.upsertJob(jobData);
              foundJobs.push(job);
              onJobFound(job, isNew);
            }
          }
        }
      } catch {
        // Ignora erros individuais da empresa para continuar
      }

      completedCount++;
      if (onProgress) {
        const percent = Math.round((completedCount / companies.length) * 100);
        onProgress({
          message: `Consultando Lever: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
