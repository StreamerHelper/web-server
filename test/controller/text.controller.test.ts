jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { TextController } from '../../src/controller/text.controller';

describe('TextController danmaku consumption', () => {
  const createController = () => {
    const controller = new TextController() as any;
    controller.ctx = {
      logger: {
        warn: jest.fn(),
      },
      status: 200,
    };
    controller.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    controller.jobService = {
      findByJobId: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue({
        id: 'job-db-id',
        jobId: 'job-public-id',
        streamerName: '主播A',
        roomName: '直播间A',
        roomId: '1000',
        startTime: new Date('2026-04-18T12:00:00Z'),
        createdAt: new Date('2026-04-18T12:00:00Z'),
        metadata: {
          danmakuIndex: {
            segments: [
              {
                segmentId: 'segment_1',
                s3Key: 'danmaku/job-db-id/segment_1.jsonl',
                startTime: 0,
                endTime: 10000,
              },
            ],
          },
        },
      }),
    };
    controller.storageService = {
      download: jest
        .fn()
        .mockResolvedValue(
          Buffer.from(
            [
              JSON.stringify({
                id: 'msg-1',
                timestamp: 1000,
                type: 'chat',
                userId: 'u-1',
                username: '用户1',
                content: '第一条弹幕',
              }),
              JSON.stringify({
                id: 'msg-2',
                timestamp: 2000,
                type: 'chat',
                userId: 'u-2',
                username: '用户2',
                content: '第二条弹幕',
              }),
            ].join('\n') + '\n'
          )
        ),
      upload: jest.fn().mockResolvedValue(undefined),
      getSignedUrl: jest
        .fn()
        .mockResolvedValue('https://signed.example/export.jsonl'),
    };
    controller.danmakuAssService = {
      messagesToAss: jest.fn().mockReturnValue('[Script Info]\n'),
    };
    controller.danmakuXmlService = {
      messagesToXml: jest.fn().mockReturnValue('<i></i>\n'),
    };
    return controller;
  };

  it('queries danmaku by database id fallback', async () => {
    const controller = createController();

    const result = await controller.queryDanmaku({
      jobId: 'job-db-id',
      startTime: 0,
      endTime: 5000,
      limit: 50,
      offset: 0,
    });

    expect(controller.jobService.findByJobId).toHaveBeenCalledWith('job-db-id');
    expect(controller.jobService.findById).toHaveBeenCalledWith('job-db-id');
    expect(result.total).toBe(2);
    expect(result.messages[0].content).toBe('第一条弹幕');
  });

  it('exports danmaku as jsonl', async () => {
    const controller = createController();

    const result = await controller.export({
      jobId: 'job-db-id',
      type: 'danmaku',
      format: 'jsonl',
    });

    expect(controller.storageService.upload).toHaveBeenCalledWith(
      'danmaku/job-db-id/export.jsonl',
      expect.any(Buffer),
      'application/x-ndjson'
    );
    expect(result.downloadUrl).toBe(
      '/api/text/export/download?jobId=job-public-id&type=danmaku&format=jsonl'
    );
  });
});
