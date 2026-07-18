import { SubmissionTemplateService } from '../../src/service/submission-template.service';

describe('SubmissionTemplateService', () => {
  const originalTimeZone = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = 'Asia/Shanghai';
  });

  afterAll(() => {
    process.env.TZ = originalTimeZone;
  });

  const createService = () => {
    const service = new SubmissionTemplateService() as any;
    service.submissionConfig = {
      defaultTid: 171,
      defaultTitleTemplate: '{主播名}的直播录像 {日期}',
    };
    service.logger = {
      warn: jest.fn(),
    };
    return service as any;
  };

  it('renders Chinese placeholders', () => {
    const service = createService();

    const title = service.resolveTitle('{主播名} {房间名} {日期} {时间}', {
      streamerName: '主播A',
      roomName: '录制时房间名',
      startedAt: '2026-04-18T12:34:00+08:00',
    });

    expect(title).toBe('主播A 录制时房间名 2026-04-18 12:34');
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
