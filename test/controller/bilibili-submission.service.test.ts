jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { BilibiliSubmissionService } from '../../src/service/bilibili-submission.service';
import { SubmissionTemplateService } from '../../src/service/submission-template.service';
import { SubmissionStatus } from '../../src/entity/bilibili-submission.entity';

describe('BilibiliSubmissionService title handling', () => {
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

  const createService = () => {
    const service = new BilibiliSubmissionService() as any;
    service.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    service.jobService = {
      findByJobId: jest.fn(),
    };
    service.streamerService = {
      findByStreamerId: jest.fn(),
    };
    service.submissionRepository = {
      create: jest.fn().mockImplementation(async payload => ({
        id: 'submission-1',
        ...payload,
      })),
    };
    service.submissionTemplateService = createTemplateService();
    return service;
  };

  it('uses streamer template defaults when explicit title metadata is omitted', async () => {
    const service = createService();
    service.jobService.findByJobId.mockResolvedValue({
      jobId: 'job-1',
      streamerId: 'streamer-1',
      streamerName: '主播A',
      platform: 'bilibili',
      roomId: '12345',
      startTime: new Date('2026-04-18T12:00:00+08:00'),
      createdAt: new Date('2026-04-18T12:00:00+08:00'),
      metadata: {
        uploadedSegments: ['raw/job-1/video/segment_001.mkv'],
      },
    });
    service.streamerService.findByStreamerId.mockResolvedValue({
      name: '主播A',
      coverPath: 'streamers/streamer-1/cover/default.jpg',
      uploadSettings: {
        title: '{streamerName} {date}',
        description: '默认简介',
        tags: ['默认标签'],
        tid: 172,
      },
    });

    await service.createSubmission({
      jobId: 'job-1',
    });

    expect(service.submissionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        title: '主播A 2026-04-18',
        description: '默认简介',
        tags: ['默认标签'],
        tid: 172,
        cover: 'streamers/streamer-1/cover/default.jpg',
        copyright: 2,
        source: 'https://live.bilibili.com/12345',
        status: SubmissionStatus.PENDING,
      })
    );
  });

  it('prefers the recorded streamer snapshot over the current streamer name', async () => {
    const service = createService();
    service.jobService.findByJobId.mockResolvedValue({
      jobId: 'job-rename',
      streamerId: 'streamer-rename',
      streamerName: '录制时主播名',
      platform: 'bilibili',
      roomId: '67890',
      startTime: new Date('2026-04-18T08:30:00+08:00'),
      createdAt: new Date('2026-04-18T08:30:00+08:00'),
      coverPath: 'jobs/job-rename/cover/snapshot.jpg',
      metadata: {
        uploadedSegments: ['raw/job-rename/video/segment_001.mkv'],
      },
    });
    service.streamerService.findByStreamerId.mockResolvedValue({
      name: '当前主播名',
      coverPath: 'streamers/streamer-rename/cover/current.jpg',
      uploadSettings: {
        title: '{streamerName} {date} {time}',
      },
    });

    await service.createSubmission({
      jobId: 'job-rename',
    });

    expect(service.submissionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '录制时主播名 2026-04-18 08:30',
        cover: 'jobs/job-rename/cover/snapshot.jpg',
      })
    );
  });

  it('preserves explicit manual submission metadata over streamer defaults', async () => {
    const service = createService();
    service.jobService.findByJobId.mockResolvedValue({
      jobId: 'job-2',
      streamerId: 'streamer-2',
      streamerName: '主播B',
      platform: 'huya',
      roomId: 'room-200',
      startTime: new Date('2026-04-18T12:00:00+08:00'),
      createdAt: new Date('2026-04-18T12:00:00+08:00'),
      metadata: {
        uploadedSegments: ['raw/job-2/video/segment_001.mkv'],
      },
    });
    service.streamerService.findByStreamerId.mockResolvedValue({
      name: '主播B',
      coverPath: 'streamers/streamer-2/cover/default.jpg',
      uploadSettings: {
        title: '{streamerName} {date}',
        description: '默认简介',
        tags: ['默认标签'],
        tid: 172,
      },
    });

    await service.createSubmission({
      jobId: 'job-2',
      title: '手动标题',
      description: '手动简介',
      tags: ['手动标签'],
      tid: 24,
    });

    expect(service.submissionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-2',
        title: '手动标题',
        description: '手动简介',
        tags: ['手动标签'],
        tid: 24,
        cover: 'streamers/streamer-2/cover/default.jpg',
        copyright: 2,
        source: 'https://www.huya.com/room-200',
      })
    );
  });

  it('groups uploaded segments into 1-hour parts by default', async () => {
    const service = createService();
    const uploadedSegments = Array.from({ length: 361 }, (_, index) =>
      `raw/job-long/video/segment_${String(index + 1).padStart(3, '0')}.mkv`
    );

    service.jobService.findByJobId.mockResolvedValue({
      jobId: 'job-long',
      streamerId: 'streamer-long',
      streamerName: '长直播主播',
      platform: 'douyu',
      roomId: '8899',
      startTime: new Date('2026-04-18T12:00:00+08:00'),
      createdAt: new Date('2026-04-18T12:00:00+08:00'),
      metadata: {
        uploadedSegments,
      },
    });
    service.streamerService.findByStreamerId.mockResolvedValue({
      name: '长直播主播',
      uploadSettings: {},
    });

    await service.createSubmission({
      jobId: 'job-long',
    });

    expect(service.submissionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        totalParts: 2,
        parts: [
          expect.objectContaining({
            index: 1,
            s3Keys: uploadedSegments.slice(0, 360),
          }),
          expect.objectContaining({
            index: 2,
            s3Keys: uploadedSegments.slice(360),
          }),
        ],
      })
    );
  });
});
