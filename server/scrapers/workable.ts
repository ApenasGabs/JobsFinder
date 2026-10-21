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

interface WorkableRawJob {
  id: number | string;
  shortcode: string;
  title: string;
  remote?: boolean;
  location?: {
    country?: string;
    city?: string;
    region?: string;
  };
  type?: string;
  department?: string[];
}

export class WorkableScraper implements BaseScraper {
  public readonly id = "WORKABLE";
  public readonly name = "Workable (22 Global)";
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
    const companies = (config.workableCompanies || []).filter(
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
        const apiUrl = `https://apply.workable.com/api/v2/accounts/${company.slug}/jobs`;
        const response = await resilientFetch(apiUrl, {
          method: "POST",
          timeoutMs: 10000,
          maxRetries: 1,
          source: 'WORKABLE',
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
          body: JSON.stringify({}),
        });

        if (response.ok) {
          const data = await response.json();
          const jobsList: WorkableRawJob[] = data.results || [];

          for (const item of jobsList) {
            const title = item.title || "Vaga sem título";
            const depts = (item.department || []).join(" ");
            const textToMatch = `${title} ${depts}`.toLowerCase();

            if (keywords.length > 0) {
              const matches = keywords.some((k) => textToMatch.includes(k));
              if (!matches) continue;
            }

            let model: WorkModel = "NAO_INFORMADO";
            if (item.remote === true) {
              model = "REMOTO";
            } else {
              model = detectWorkModel(title);
            }

            const locationParts = [
              item.location?.city,
              item.location?.region,
              item.location?.country,
            ].filter(Boolean);
            const location =
              locationParts.join(", ") ||
              (model === "REMOTO" ? "Remoto" : "Global");

            const contractType = detectContractType(item.type || title, "CLT");
            const seniorityLevel = detectSeniority(title);
            const jobUrl = `https://apply.workable.com/${company.slug}/j/${item.shortcode}`;
            const stack = extractStack(`${title} ${depts}`);

            const jobData = {
              title,
              company: company.name,
              location,
              workModel: model,
              contractType,
              seniorityLevel,
              url: jobUrl,
              source: "WORKABLE",
              stack,
              description: `Departamento: ${depts || "Geral"} | Tipo: ${item.type || "Full-time"}`,
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
          message: `Consultando Workable: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
