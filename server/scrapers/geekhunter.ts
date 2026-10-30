import * as cheerio from 'cheerio';
import { BaseScraper } from './base.js';
import { Job, ScrapeOptions } from '../types.js';
import { detectSeniority, detectWorkModel, extractStack } from '../utils/normalizer.js';
import { resilientFetch } from '../utils/fetch.js';
import { StorageService } from '../services/storage.js';
import { LoggerService } from '../services/logger.js';
import { ScraperHealthService } from '../services/scraper-health.js';

export class GeekHunterScraper implements BaseScraper {
  public readonly id = 'GEEKHUNTER';
  public readonly name = 'GeekHunter';
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
    let consecutiveTermErrors = 0;

    for (const term of searchTerms) {
      if (onProgress) {
        onProgress({ message: `Consultando GeekHunter: "${term || 'todas'}"...`, percent: 45 });
      }

      try {
        const queryParam = term ? `?q=${encodeURIComponent(term)}` : '';
        const url = `https://www.geekhunter.com.br/vagas${queryParam}`;

        const response = await resilientFetch(url, {
          timeoutMs: 10000,
          maxRetries: 1,
          source: 'GEEKHUNTER',
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9'
          }
        });

        if (response.status === 403 || response.status === 429) {
          ScraperHealthService.recordCircuitBreak(
            'GEEKHUNTER',
            `GeekHunter bloqueou requisições (HTTP ${response.status})`,
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
            'GEEKHUNTER',
            'GeekHunter retornou desafio Cloudflare',
            600000
          );
          break;
        }

        const $ = cheerio.load(html);
        const seenUrls = new Set<string>();

        $('a[href*="/jobs/"]').each((_, elem) => {
          const rawHref = $(elem).attr('href') || '';
          if (!rawHref || seenUrls.has(rawHref)) return;
          seenUrls.add(rawHref);

          const jobUrl = rawHref.startsWith('http')
            ? rawHref
            : `https://www.geekhunter.com${rawHref}`;

          const title =
            $(elem).text().trim() ||
            $(elem).find('h3, h2, .job-title').first().text().trim();
          if (!title || title.length < 3 || title.length > 140) return;

          // Extrai o nome da empresa da URL (/pt/<company-slug>/jobs/...) ou do card
          const companyMatch = jobUrl.match(/\/pt\/([^/]+)\/jobs\//i);
          let company = 'Empresa parceira GeekHunter';
          if (companyMatch) {
            company = companyMatch[1]
              .replace(/-\d+$/, '')
              .replace(/-/g, ' ')
              .replace(/\b\w/g, (c) => c.toUpperCase());
          }

          const card = $(elem).closest('div[class*="css-"]').parent();
          const details = card.text().replace(/\s+/g, ' ').trim() || title;

          const model = detectWorkModel(`${title} ${details}`);
          const seniority = detectSeniority(`${title} ${details}`);
          const stack = extractStack(`${title} ${details}`);

          const jobData = {
            title,
            company,
            location: model === 'REMOTO' ? 'Remoto Brasil' : 'Brasil',
            workModel: model,
            contractType: 'CLT' as const,
            seniorityLevel: seniority,
            url: jobUrl,
            source: 'GEEKHUNTER',
            stack,
            description: details.slice(0, 300) || `Vaga de tecnologia via GeekHunter: ${title}`,
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

        ScraperHealthService.recordTermError('GEEKHUNTER', term, reason);

        LoggerService.warn(
          'CRAWLER',
          'SCRAPER_TERM_ERROR',
          `GeekHunter falhou na busca de "${term}" (${reason}). Continuando demais termos.`,
          { error: reason, term, consecutiveTermErrors }
        );

        if (consecutiveTermErrors >= 3) {
          ScraperHealthService.recordCircuitBreak(
            'GEEKHUNTER',
            `3 termos consecutivos falharam (último: ${term} - ${reason})`,
            600000
          );
          break;
        }

        continue;
      }
    }

    if (onProgress) {
      onProgress({ message: `GeekHunter finalizado: ${foundJobs.length} vagas`, percent: 100 });
    }

    return foundJobs;
  }
}

