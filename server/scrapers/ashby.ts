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

interface AshbyRawJob {
  id: string;
  title: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  isRemote?: boolean;
  workplaceType?: string;
  publishedAt?: string;
  address?: {
    postalAddress?: {
      addressCountry?: string;
      addressLocality?: string;
      addressRegion?: string;
    };
  };
}

export class AshbyScraper implements BaseScraper {
  public readonly id = "ASHBY";
  public readonly name = "Ashby (41 Global Tech)";
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
    const companies = (config.ashbyCompanies || []).filter(
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
        const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${company.slug}`;
        const response = await resilientFetch(apiUrl, {
          timeoutMs: 10000,
          maxRetries: 1,
          source: 'ASHBY',
          headers: {
            Accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
        });

        if (response.ok) {
          const data = await response.json();
          const jobsList: AshbyRawJob[] = data.jobs || [];

          for (const item of jobsList) {
            const title = item.title || "Vaga sem título";
            const textToMatch =
              `${title} ${item.department || ""} ${item.team || ""}`.toLowerCase();

            if (keywords.length > 0) {
              const matches = keywords.some((k) => textToMatch.includes(k));
              if (!matches) continue;
            }

            let model: WorkModel = "NAO_INFORMADO";
            if (
              item.isRemote === true ||
              item.workplaceType?.toLowerCase() === "remote"
            ) {
              model = "REMOTO";
            } else if (item.workplaceType?.toLowerCase() === "hybrid") {
              model = "HIBRIDO";
            } else if (
              item.workplaceType?.toLowerCase() === "onsite" ||
              item.workplaceType?.toLowerCase() === "on-site"
            ) {
              model = "PRESENCIAL";
            } else {
              model = detectWorkModel(title + " " + (item.location || ""));
            }

            const postal = item.address?.postalAddress;
            const locationParts = [
              item.location || postal?.addressLocality,
              postal?.addressRegion,
              postal?.addressCountry,
            ].filter(Boolean);
            const location =
              locationParts.join(", ") ||
              (model === "REMOTO" ? "Remoto" : "Global");

            const contractType = detectContractType(
              item.employmentType || title,
              "CLT",
            );
            const seniorityLevel = detectSeniority(title);
            const jobUrl = `https://jobs.ashbyhq.com/${company.slug}/${item.id}`;
            const stack = extractStack(`${title} ${item.department || ""}`);

            const jobData = {
              title,
              company: company.name,
              location,
              workModel: model,
              contractType,
              seniorityLevel,
              url: jobUrl,
              source: "ASHBY",
              stack,
              description: `Departamento: ${item.department || "Engenharia"} | Tipo: ${item.employmentType || "FullTime"}`,
            };

            const { job, isNew } = StorageService.upsertJob(jobData);
            foundJobs.push(job);
            onJobFound(job, isNew);
          }
        }
      } catch {
        // Ignora erros individuais da empresa para continuar
      }

      completedCount++;
      if (onProgress) {
        const percent = Math.round((completedCount / companies.length) * 100);
        onProgress({
          message: `Consultando Ashby: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
