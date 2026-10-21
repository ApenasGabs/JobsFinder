import { Job, ScrapeOptions } from '../types.js';

export interface BaseScraper {
  readonly id: string;
  readonly name: string;
  readonly type: 'CLT' | 'FREELANCE' | 'ALL';
  readonly isFastMode: boolean;

  scrape(
    options: ScrapeOptions,
    onJobFound: (job: Job, isNew?: boolean) => void,
    onProgress?: (progress: { message: string; currentCompany?: string; percent?: number }) => void
  ): Promise<Job[]>;
}

export class ScraperRegistry {
  private static scrapers: Map<string, BaseScraper> = new Map();

  public static register(scraper: BaseScraper): void {
    this.scrapers.set(scraper.id.toUpperCase(), scraper);
  }

  public static get(id: string): BaseScraper | undefined {
    return this.scrapers.get(id.toUpperCase());
  }

  public static getAll(): BaseScraper[] {
    return Array.from(this.scrapers.values());
  }

  public static isRegistered(id: string): boolean {
    return this.scrapers.has(id.toUpperCase());
  }
}

