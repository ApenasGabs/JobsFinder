import * as cheerio from 'cheerio';
import { BaseScraper } from './base.js';
import { Job, ScrapeOptions } from '../types.js';
import { detectSeniority, detectWorkModel, extractStack } from '../utils/normalizer.js';
import { resilientFetch } from '../utils/fetch.js';
import { StorageService } from '../services/storage.js';
import { LoggerService } from '../services/logger.js';
import { ScraperHealthService } from '../services/scraper-health.js';

export class ProgramathorScraper implements BaseScraper {
  public readonly id = 'PROGRAMATHOR';
  public readonly name = 'Programathor';
  public readonly type = 'CLT' as const;
  public readonly isFastMode = true;

  public async scrape(
    options: ScrapeOptions,
    onJobFound: (job: Job, isNew?: boolean) => void,
    onProgress?: (progress: { message: string; percent?: number }) => void
  ): Promise<Job[]> {
    const keywords = (options.keywords || []).filter(Boolean);
    const searchTerms = keywords.length > 0 ? keywords : [''];
    const foundJobs: Job[] = [];

    let count = 0;
    let consecutiveTermErrors = 0;

    for (const term of searchTerms) {
      if (onProgress) {
        onProgress({ message: `Consultando Programathor: "${term || 'todas'}"...`, percent: 40 });
      }

      try {
        const queryParam = term ? `?q=${encodeURIComponent(term)}` : '';
        const url = `https://programathor.com.br/jobs${queryParam}`;

        const response = await resilientFetch(url, {
          timeoutMs: 10000,
          maxRetries: 1,
          source: 'PROGRAMATHOR',
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
          }
        });

        if (response.status === 403 || response.status === 429) {
          ScraperHealthService.recordCircuitBreak(
            'PROGRAMATHOR',
            `Programathor bloqueou requisições (HTTP ${response.status})`,
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
            'PROGRAMATHOR',
            'Programathor retornou desafio Cloudflare',
            600000
          );
          break;
        }

        const $ = cheerio.load(html);

        // Seleciona os cartões de vagas do Programathor
        $('.cell-list').each((_, elem) => {
          const title = $(elem).find('h3').first().text().trim();
          if (!title) return;

          const relativeUrl = $(elem).closest('a').attr('href') || $(elem).find('a').attr('href');
          const jobUrl = relativeUrl ? (relativeUrl.startsWith('http') ? relativeUrl : `https://programathor.com.br${relativeUrl}`) : '';

          const company = $(elem).find('.cell-list-content-partner').text().trim() || 'Empresa Confidencial';
          const metadata = $(elem).find('.cell-list-content-metadata').text().trim();
          const badges = $(elem).find('.cell-list-content-badge').map((_, b) => $(b).text().trim()).get();

          const model = detectWorkModel(`${title} ${metadata} ${badges.join(' ')}`);
          const seniority = detectSeniority(`${title} ${metadata}`);
          const stack = Array.from(new Set([...badges, ...extractStack(`${title} ${metadata}`)]));

          const jobData = {
            title,
            company,
            location: metadata.includes('Remoto') ? 'Remoto Brasil' : metadata || 'Brasil',
            workModel: model,
            contractType: 'CLT' as const,
            seniorityLevel: seniority,
            url: jobUrl,
            source: 'PROGRAMATHOR',
            stack,
            description: `${metadata} | Tags: ${badges.join(', ')}`
          };

          const { job, isNew } = StorageService.upsertJob(jobData);
          foundJobs.push(job);
          onJobFound(job, isNew);
          count++;
        });

        consecutiveTermErrors = 0;
      } catch (err: any) {
        consecutiveTermErrors++;
        const isAbort = err?.name === 'AbortError' || err?.message?.includes('aborted');
        const reason = isAbort ? 'Timeout (10s)' : err?.message || String(err);

        ScraperHealthService.recordTermError('PROGRAMATHOR', term, reason);

        LoggerService.warn(
          'CRAWLER',
          'SCRAPER_TERM_ERROR',
          `Programathor falhou na busca do termo "${term}" (${reason}). Continuando demais termos.`,
          { error: reason, term, consecutiveTermErrors }
        );

        if (consecutiveTermErrors >= 3) {
          ScraperHealthService.recordCircuitBreak(
            'PROGRAMATHOR',
            `3 termos consecutivos falharam (último: ${term} - ${reason})`,
            600000
          );
          break;
        }

        continue;
      }
    }

    if (onProgress) {
      onProgress({ message: `Programathor finalizado: ${foundJobs.length} vagas`, percent: 100 });
    }

    return foundJobs;
  }
}

