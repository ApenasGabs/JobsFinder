import { ConfigService } from "../services/config.js";
import { StorageService } from "../services/storage.js";
import { Job, ScrapeOptions, WorkModel } from "../types.js";
import {
  detectContractType,
  detectSeniority,
  detectWorkModel,
  extractStack,
  slugifyInHire,
} from "../utils/normalizer.js";
import { runWithConcurrency } from "../utils/pool.js";
import { resilientFetch } from "../utils/fetch.js";
import { BaseScraper } from "./base.js";

interface InHireRawJob {
  jobId: string;
  displayName: string;
  status: string;
  workplaceType?: string;
  location?: string;
}

export class InHireScraper implements BaseScraper {
  public readonly id = "INHIRE";
  public readonly name = "InHire (63 Startups BR)";
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
    const companies = (config.inhireCompanies || []).filter(
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
        const apiUrl = "https://api.inhire.app/job-posts/public/pages";
        const response = await resilientFetch(apiUrl, {
          timeoutMs: 10000,
          maxRetries: 1,
          source: 'INHIRE',
          headers: {
            Accept: "application/json",
            "X-Tenant": company.slug,
            Origin: `https://${company.slug}.inhire.app`,
            Referer: `https://${company.slug}.inhire.app/`,
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
        });

        if (response.ok) {
          const data = await response.json();
          const jobsList: InHireRawJob[] = data.jobsPage || [];
          const companyName = data.tenantName || company.name;

          for (const item of jobsList) {
            if (item.status && item.status.toLowerCase() !== "published")
              continue;

            const title = item.displayName || "Vaga sem título";
            const textToMatch = `${title} ${item.location || ""}`.toLowerCase();

            if (keywords.length > 0) {
              const matches = keywords.some((k) => textToMatch.includes(k));
              if (!matches) continue;
            }

            let model: WorkModel = "NAO_INFORMADO";
            const wp = item.workplaceType?.toLowerCase();
            if (wp === "remote") model = "REMOTO";
            else if (wp === "hybrid") model = "HIBRIDO";
            else if (wp === "on-site" || wp === "onsite") model = "PRESENCIAL";
            else model = detectWorkModel(title);

            const location =
              item.location || (model === "REMOTO" ? "Remoto" : "Brasil");
            const contractType = detectContractType(title, "CLT");
            const seniorityLevel = detectSeniority(title);
            const slug = slugifyInHire(title);
            const jobUrl = `https://${company.slug}.inhire.app/vagas/${item.jobId}/${slug}`;
            const stack = extractStack(title);

            const jobData = {
              title,
              company: companyName,
              location,
              workModel: model,
              contractType,
              seniorityLevel,
              url: jobUrl,
              source: "INHIRE",
              stack,
              description: `Modelo: ${item.workplaceType || "Não informado"} | Local: ${location}`,
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
          message: `Consultando InHire: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
