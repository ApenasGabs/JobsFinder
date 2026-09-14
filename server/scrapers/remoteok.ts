import { BaseScraper } from './base.js';
import { Job, ScrapeOptions } from '../types.js';
import { detectSeniority, extractStack } from '../utils/normalizer.js';
import { StorageService } from '../services/storage.js';
import { LoggerService } from '../services/logger.js';

interface RemoteOkItem {
  id?: string | number;
  slug?: string;
  position?: string;
  company?: string;
  url?: string;
  apply_url?: string;
  location?: string;
  tags?: string[];
  description?: string;
  date?: string;
}

export class RemoteOKScraper implements BaseScraper {
  public readonly id = 'REMOTEOK';
  public readonly name = 'RemoteOK (Global)';
  public readonly type = 'FREELANCE' as const;
  public readonly isFastMode = true;

  public async scrape(
    options: ScrapeOptions,
    onJobFound: (job: Job) => void,
    onProgress?: (progress: { message: string; percent?: number }) => void
  ): Promise<Job[]> {
    const keywords = (options.keywords || []).map((k) => k.toLowerCase().trim()).filter(Boolean);
    const foundJobs: Job[] = [];

    if (onProgress) {
      onProgress({ message: 'Consultando API pública do RemoteOK...', percent: 20 });
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      const response = await fetch('https://remoteok.com/api', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        LoggerService.warn(
          'CRAWLER',
          'SCRAPER_DEGRADED',
          `RemoteOK retornou HTTP ${response.status}. Pulando.`,
          { status: response.status }
        );
        return [];
      }

      const items: RemoteOkItem[] = await response.json();
      // O primeiro item do RemoteOK costuma ser um objeto legal/metadados
      const jobList = Array.isArray(items) ? items.filter((i) => i.position && i.company) : [];

      let processed = 0;
      for (const item of jobList) {
        const title = item.position || 'Sem título';
        const company = item.company || 'RemoteOK Company';
        const tags = Array.isArray(item.tags) ? item.tags : [];
        const fullText = `${title} ${tags.join(' ')} ${item.description || ''}`.toLowerCase();

        // Se o usuário especificou palavras-chave, filtra
        if (keywords.length > 0) {
          const match = keywords.some((k) => fullText.includes(k));
          if (!match) continue;
        }

        const stack = Array.from(new Set([...tags, ...extractStack(title)]));
        const url = item.apply_url || item.url || `https://remoteok.com/remote-jobs/${item.id || item.slug}`;

        const jobData = {
          title,
          company,
          location: item.location || 'Remoto Global',
          workModel: 'REMOTO' as const,
          contractType: 'FREELANCER' as const,
          seniorityLevel: detectSeniority(title),
          url,
          source: 'REMOTEOK',
          stack,
          description: (item.description || '').slice(0, 300)
        };

        const { job } = StorageService.upsertJob(jobData);
        foundJobs.push(job);
        onJobFound(job);

        processed++;
        if (processed >= 50) break; // Limite razoável para não saturar
      }

      if (onProgress) {
        onProgress({ message: `RemoteOK finalizado: ${foundJobs.length} vagas encontradas`, percent: 100 });
      }
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError' || err?.message?.includes('aborted');
      if (isAbort) {
        LoggerService.warn(
          'CRAWLER',
          'SCRAPER_CIRCUIT_BREAK',
          'RemoteOK API atingiu timeout de 4.0s. Pulando.',
          { error: err?.message || String(err) }
        );
      } else {
        LoggerService.warn(
          'CRAWLER',
          'SCRAPER_CIRCUIT_BREAK',
          `RemoteOK falhou na requisição: ${err?.message || String(err)}`,
          { error: err?.message || String(err) }
        );
      }
    }

    return foundJobs;
  }
}

