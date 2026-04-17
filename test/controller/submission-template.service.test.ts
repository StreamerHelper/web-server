import { SubmissionTemplateService } from '../../src/service/submission-template.service';

describe('SubmissionTemplateService', () => {
  const createService = () => {
    const service = new SubmissionTemplateService() as any;
    service.submissionConfig = {
      defaultTid: 171,
      defaultTitleTemplate: '{streamerName}的直播录像 {date}',
    };
    service.logger = {
      warn: jest.fn(),
    };
    return service as any;
  };

  it('renders canonical placeholders and legacy aliases', () => {
    const service = createService();

    const title = service.resolveTitle('{{name}} {date} {time}', {
      streamerName: '主播A',
      startedAt: '2026-04-18T12:34:00+08:00',
    });

    expect(title).toContain('主播A');
    expect(title).toMatch(/^主播A \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(title).not.toContain('{');
  });

  it('falls back to configured defaults when template and tid are missing', () => {
    const service = createService();

    const title = service.resolveTitle(undefined, {
      streamerName: '主播A',
      startedAt: '2026-04-18T12:34:00+08:00',
    });

    expect(title).toContain('主播A的直播录像');
    expect(title).toContain('2026-04-18');
    expect(service.resolveTid(undefined)).toBe(171);
  });
});
