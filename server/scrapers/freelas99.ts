import * as cheerio from 'cheerio';
import { BaseScraper } from './base.js';
import { Job, ScrapeOptions } from '../types.js';
import { extractStack } from '../utils/normalizer.js';
import { StorageService } from '../services/storage.js';
import { LoggerService } from '../services/logger.js';

export class Freelas99Scraper implements BaseScraper {
  public readonly id = 'FREELAS_99';
  public readonly name = '99Freelas';
  public readonly type = 'FREELANCE' as const;
  public readonly isFastMode = true;

  public async scrape(
    options: ScrapeOptions,
    onJobFound: (job: Job) => void,
    onProgress?: (progress: { message: string; percent?: number }) => void
  ): Promise<Job[]> {
    const keywords = (options.keywords || []).filter(Boolean);
    const searchTerms = keywords.length > 0 ? keywords : ['programacao'];
    const foundJobs: Job[] = [];

    for (const term of searchTerms) {
      if (onProgress) {
        onProgress({ message: `Buscando projetos no 99Freelas: "${term}"...`, percent: 50 });
      }

      try {
        const url = `https://www.99freelas.com.br/projetos?q=${encodeURIComponent(term)}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);

        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9'
          },
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (response.status === 403 || response.status === 429) {
          LoggerService.warn(
            'CRAWLER',
            'SCRAPER_CIRCUIT_BREAK',
            `99Freelas bloqueou requisições (HTTP ${response.status}). Abortando ciclo restante.`,
            { status: response.status, term }
          );
          break;
        }

        if (!response.ok) continue;

        const html = await response.text();

        if (html.includes('cf-browser-verification') || html.includes('Just a moment...')) {
          LoggerService.warn(
            'CRAWLER',
            'SCRAPER_CIRCUIT_BREAK',
            '99Freelas retornou desafio Cloudflare. Abortando ciclo restante.',
            { term }
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

          const { job } = StorageService.upsertJob(jobData);
          foundJobs.push(job);
          onJobFound(job);
        });
      } catch (err: any) {
        const isAbort = err?.name === 'AbortError' || err?.message?.includes('aborted');
        if (isAbort) {
          LoggerService.warn(
            'CRAWLER',
            'SCRAPER_CIRCUIT_BREAK',
            `99Freelas atingiu timeout (3.5s) na busca de "${term}". Abortando ciclo restante.`,
            { error: err?.message || String(err), term }
          );
        } else {
          LoggerService.warn(
            'CRAWLER',
            'SCRAPER_CIRCUIT_BREAK',
            `99Freelas falhou na conexão para "${term}". Abortando ciclo restante.`,
            { error: err?.message || String(err), term }
          );
        }
        break;
      }
    }

    if (onProgress) {
      onProgress({ message: `99Freelas finalizado: ${foundJobs.length} projetos`, percent: 100 });
    }

    return foundJobs;
  }
}

