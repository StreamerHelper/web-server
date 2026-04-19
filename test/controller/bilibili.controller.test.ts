jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { BilibiliController } from '../../src/controller/bilibili.controller';
import { SubmissionTemplateService } from '../../src/service/submission-template.service';

describe('BilibiliController uploadVideo title resolution', () => {
  const createTemplateService = () => {
    const service = new SubmissionTemplateService() as any;
    service.submissionConfig = {
      defaultTid: 171,
      defaultTitleTemplate: '{streamerName}的直播录像 {date}',
    };
    service.logger = {
      warn: jest.fn(),
    };
    return service;
  };

  it('keeps explicit upload titles while using streamer defaults for missing fields', async () => {
    const controller = new BilibiliController() as any;
    controller.ctx = {
      logger: {
        error: jest.fn(),
      },
      status: 200,
    };
    controller.submissionTemplateService = createTemplateService();
    controller.streamerService = {
      findById: jest.fn().mockResolvedValue(null),
      findByStreamerId: jest.fn().mockResolvedValue({
        name: '主播A',
        platform: 'bilibili',
        roomId: '12345',
        coverPath: 'streamers/streamer-1/cover/default.jpg',
        uploadSettings: {
          title: '{streamerName}默认标题 {date}',
          description: '默认简介',
          tags: ['默认标签'],
          tid: 171,
        },
      }),
    };
    controller.jobService = {
      findByJobId: jest.fn().mockResolvedValue(null),
    };
    controller.bilibiliUploadService = {
      upload: jest.fn().mockResolvedValue({
        bvid: 'BV1xx411c7mD',
        avid: '123456',
      }),
    };

    const result = await controller.uploadVideo({
      s3Key: 'raw/job-1/video/segment_001.mkv',
      title: '手动标题',
      streamerId: 'streamer-1',
    });

    expect(controller.bilibiliUploadService.upload).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          title: '手动标题',
        }),
      ],
      expect.objectContaining({
        title: '手动标题',
        description: '默认简介',
        tags: ['默认标签'],
        tid: 171,
        cover: 'streamers/streamer-1/cover/default.jpg',
        copyright: 2,
        source: 'https://live.bilibili.com/12345',
      })
    );
    expect(result.bvid).toBe('BV1xx411c7mD');
  });

  it('uses recorded job context when rendering upload titles from templates', async () => {
    const controller = new BilibiliController() as any;
    controller.ctx = {
      logger: {
        error: jest.fn(),
      },
      status: 200,
    };
    controller.submissionTemplateService = createTemplateService();
    controller.streamerService = {
      findById: jest.fn().mockResolvedValue({
        name: '当前主播名',
        platform: 'bilibili',
        roomId: '99999',
        coverPath: 'streamers/streamer-1/cover/current.jpg',
        uploadSettings: {
          description: '默认简介',
          tags: ['默认标签'],
          tid: 171,
        },
      }),
      findByStreamerId: jest.fn().mockResolvedValue(null),
    };
    controller.jobService = {
      findByJobId: jest.fn().mockResolvedValue({
        jobId: 'job-1',
        streamerName: '录制时主播名',
        platform: 'douyu',
        roomId: '7788',
        startTime: new Date('2026-04-18T12:34:00+08:00'),
        createdAt: new Date('2026-04-18T12:34:00+08:00'),
        coverPath: 'jobs/job-1/cover/snapshot.jpg',
      }),
    };
    controller.bilibiliUploadService = {
      upload: jest.fn().mockResolvedValue({
        bvid: 'BV1xx411c7mD',
        avid: '123456',
      }),
    };

    await controller.uploadVideo({
      s3Key: 'raw/job-1/video/segment_001.mkv',
      title: '{streamerName} {date} {time}',
      jobId: 'job-1',
      streamerId: 'streamer-1',
    });

    expect(controller.jobService.findByJobId).toHaveBeenCalledWith('job-1');
    expect(controller.bilibiliUploadService.upload).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          title: '录制时主播名 2026-04-18 12:34',
        }),
      ],
      expect.objectContaining({
        title: '录制时主播名 2026-04-18 12:34',
        description: '默认简介',
        tags: ['默认标签'],
        tid: 171,
        cover: 'jobs/job-1/cover/snapshot.jpg',
        copyright: 2,
        source: 'https://www.douyu.com/7788',
      })
    );
  });
});
