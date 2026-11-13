import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { type ReadinessReport, ReadinessService } from '../health/readiness.service';

/** Open by design: statement §9 requires health checks without authentication. */
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Liveness never touches a dependency: an outage must not get healthy processes killed. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    if (report.status !== 'ok') {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
