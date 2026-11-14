import { Controller, Get, Header } from '@nestjs/common';
import { Metrics } from '../metrics/metrics';

/** Open like the health checks (ADR-08): it carries counts and durations, never amounts. */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: Metrics) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
