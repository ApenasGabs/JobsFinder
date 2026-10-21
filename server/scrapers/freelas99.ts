import * as cheerio from 'cheerio';
import { BaseScraper } from './base.js';
import { Job, ScrapeOptions } from '../types.js';
import { extractStack } from '../utils/normalizer.js';
import { resilientFetch } from '../utils/fetch.js';
import { StorageService } from '../services/storage.js';
import { LoggerService } from '../services/logger.js';
import { ScraperHealthService } from '../services/scraper-health.js';

export class Freelas99Scraper implements BaseScraper {
  public readonly id = 'FREELAS_99';
  public readonly name = '99Freelas';
  public readonly type = 'FREELANCE' as const;
  public readonly isFastMode = true;

  public async scrape(
    options: ScrapeOptions,
    onJobFound: (job: Job, isNew?: boolean) => void,
    onProgress?: (progress: { message: string; percent?: number }) => void
  ): Promise<Job[]> {
    const keywords = (options.keywords || []).filter(Boolean);
    const searchTerms = keywords.length > 0 ? keywords : ['programacao'];
    const foundJobs: Job[] = [];
    let consecutiveTermErrors = 0;

    for (const term of searchTerms) {
      if (onProgress) {
        onProgress({ message: `Buscando projetos no 99Freelas: "${term}"...`, percent: 50 });
      }

      try {
        const url = `https://www.99freelas.com.br/projetos?q=${encodeURIComponent(term)}`;

        const response = await resilientFetch(url, {
          timeoutMs: 10000,
          maxRetries: 1,
          source: 'FREELAS_99',
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9'
          }
        });

        if (response.status === 403 || response.status === 429) {
          ScraperHealthService.recordCircuitBreak(
            'FREELAS_99',
            `99Freelas bloqueou requisições (HTTP ${response.status})`,
            600000
          );
          break;
        }

        if (!response.ok) {
          consecutiveTermErrors++;
          continue;
        }

        const html = await response.text();

        if (html.includes('cf-browser-verification') || html.includes('Just a moment...')) {
          ScraperHealthService.recordCircuitBreak(
            'FREELAS_99',
            '99Freelas retornou desafio Cloudflare',
            600000
          );
          break;
        }

        const $ = cheerio.load(html);

        $('.result-item').each((_, elem) => {
          const titleLink = $(elem).find('.title a');
          const title = titleLink.text().trim();
          if (!title) return;

          const relativeUrl = titleLink.attr('href') || '';
          const projectUrl = relativeUrl.startsWith('http') ? relativeUrl : `https://www.99freelas.com.br${relativeUrl}`;

          const description = $(elem).find('.item-text').text().trim();
          const info = $(elem).find('.item-details').text().trim();
          const skills = $(elem).find('.skills span').map((_, s) => $(s).text().trim()).get();

          const stack = Array.from(new Set([...skills, ...extractStack(`${title} ${description}`)]));

          const jobData = {
            title: `[Projeto Freelance] ${title}`,
            company: 'Cliente 99Freelas',
            location: 'Remoto Brasil',
            workModel: 'REMOTO' as const,
            contractType: 'FREELANCER' as const,
            seniorityLevel: 'NAO_INFORMADO' as const,
            url: projectUrl,
            source: 'FREELAS_99',
            stack,
            description: `${description.slice(0, 300)}... | ${info}`
          };

          const { job, isNew } = StorageService.upsertJob(jobData);
          foundJobs.push(job);
          onJobFound(job, isNew);
        });

        consecutiveTermErrors = 0;
      } catch (err: any) {
        consecutiveTermErrors++;
        const isAbort = err?.name === 'AbortError' || err?.message?.includes('aborted');
        const reason = isAbort ? 'Timeout (10s)' : err?.message || String(err);

        ScraperHealthService.recordTermError('FREELAS_99', term, reason);

        LoggerService.warn(
          'CRAWLER',
          'SCRAPER_TERM_ERROR',
          `99Freelas falhou na busca de "${term}" (${reason}). Continuando demais termos.`,
          { error: reason, term, consecutiveTermErrors }
        );

        if (consecutiveTermErrors >= 3) {
          ScraperHealthService.recordCircuitBreak(
            'FREELAS_99',
            `3 termos consecutivos falharam (último: ${term} - ${reason})`,
            600000
          );
          break;
        }

        continue;
      }
    }

    if (onProgress) {
      onProgress({ message: `99Freelas finalizado: ${foundJobs.length} projetos`, percent: 100 });
    }

    return foundJobs;
  }
}

