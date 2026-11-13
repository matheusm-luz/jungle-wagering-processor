import { Injectable } from '@nestjs/common';

/**
 * In-process counters, one set per instance (S8, Q1). S11 exposes them in `/metrics`; a scraper
 * sums the instances.
 */
@Injectable()
export class Metrics {
  private readonly counters = new Map<string, number>();

  increment(name: string): void {
    this.counters.set(name, this.value(name) + 1);
  }

  value(name: string): number {
    return this.counters.get(name) ?? 0;
  }
}
