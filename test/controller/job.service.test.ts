jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { JobService } from '../../src/service/job.service';
import { SubmissionTemplateService } from '../../src/service/submission-template.service';

describe('JobService browse cover data', () => {
  const createTemplateService = () => {
    const service = new SubmissionTemplateService() as any;
    service.submissionConfig = {
      defaultTid: 171,
      defaultTitleTemplate: '{主播名}的直播录像 {日期}',
    };
    service.logger = {
      warn: jest.fn(),
    };
    return service;
  };

  it('includes streamer cover URLs in browse results', async () => {
    const service = new JobService() as any;
    const job = {
      id: 'job-db-id',
      jobId: 'job-1',
      streamerId: 'streamer-1',
      streamerName: '主播A',
      roomName: '直播间A',
      platform: 'bilibili',
      status: 'completed',
      duration: 3600000,
      segmentCount: 10,
      startTime: new Date('2026-04-18T10:00:00+08:00'),
      endTime: new Date('2026-04-18T11:00:00+08:00'),
      createdAt: new Date('2026-04-18T10:00:00+08:00'),
      coverPath: 'jobs/job-1/cover/snapshot.jpg',
    };

    service.jobModel = {
      createQueryBuilder: jest.fn().mockReturnValue({
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([job]),
      }),
    };
    service.storageService = {
      getSignedUrl: jest
        .fn()
        .mockResolvedValue('https://signed.example/job-cover.jpg'),
    };
    service.streamerModel = {
      find: jest.fn().mockResolvedValue([
        {
          streamerId: 'streamer-1',
          name: '当前主播A',
          uploadSettings: {
            title: '{主播名} - {房间名} - {日期}',
          },
        },
      ]),
    };
    service.submissionTemplateService = createTemplateService();

    const groups = await service.findAllGroupedByDate();

    expect(groups['2026-04-18']).toEqual([
      expect.objectContaining({
        jobId: 'job-1',
        title: '主播A - 直播间A - 2026-04-18',
        streamerName: '主播A',
        coverUrl: '/api/jobs/job-db-id/cover',
      }),
    ]);
  });

  it('returns the job cover endpoint when a cover exists', async () => {
    const service = new JobService() as any;
    service.logger = {
      warn: jest.fn(),
    };
    service.jobModel = {
      createQueryBuilder: jest.fn().mockReturnValue({
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: 'job-db-id',
            jobId: 'job-2',
            streamerId: 'streamer-2',
            streamerName: '主播B',
            roomName: '直播间B',
            platform: 'bilibili',
            status: 'completed',
            duration: 1000,
            segmentCount: 3,
            startTime: new Date('2026-04-18T12:00:00+08:00'),
            endTime: new Date('2026-04-18T12:10:00+08:00'),
            createdAt: new Date('2026-04-18T12:00:00+08:00'),
            coverPath: 'jobs/job-2/cover/snapshot.jpg',
          },
        ]),
      }),
    };
    service.storageService = {
      getSignedUrl: jest.fn().mockRejectedValue(new Error('missing object')),
    };
    service.streamerModel = {
      find: jest.fn().mockResolvedValue([
        {
          streamerId: 'streamer-2',
          name: '当前主播B',
          uploadSettings: {
            title: '{房间名} / {主播名} / {时间}',
          },
        },
      ]),
    };
    service.submissionTemplateService = createTemplateService();

    const groups = await service.findAllGroupedByDate();

    expect(groups['2026-04-18']).toEqual([
      expect.objectContaining({
        jobId: 'job-2',
        title: '直播间B / 主播B / 12:00',
        coverUrl: '/api/jobs/job-db-id/cover',
      }),
    ]);
  });

  it('uses the default submission title template when streamer has no title template', async () => {
    const service = new JobService() as any;
    service.jobModel = {
      createQueryBuilder: jest.fn().mockReturnValue({
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: 'job-db-id',
            jobId: 'job-3',
            streamerId: 'streamer-3',
            streamerName: '主播C',
            roomName: '直播间C',
            platform: 'bilibili',
            status: 'completed',
            duration: 1000,
            segmentCount: 3,
            startTime: new Date('2026-04-18T12:00:00+08:00'),
            endTime: new Date('2026-04-18T12:10:00+08:00'),
            createdAt: new Date('2026-04-18T12:00:00+08:00'),
            coverPath: null,
          },
        ]),
      }),
    };
    service.streamerModel = {
      find: jest.fn().mockResolvedValue([
        {
          streamerId: 'streamer-3',
          name: '当前主播C',
          uploadSettings: {},
        },
      ]),
    };
    service.submissionTemplateService = createTemplateService();

    const groups = await service.findAllGroupedByDate();

    expect(groups['2026-04-18']).toEqual([
      expect.objectContaining({
        jobId: 'job-3',
        title: '主播C的直播录像 2026-04-18',
      }),
    ]);
  });

  it('returns video offsets for timeline aligned playback', async () => {
    const service = new JobService() as any;
    service.jobModel = {
      findOne: jest.fn().mockResolvedValue({
        id: 'job-db-id',
        jobId: 'job-public-id',
        streamerName: '主播C',
        roomName: '直播间C',
        platform: 'bilibili',
        duration: 24000,
        segmentCount: 3,
        metadata: {
          uploadedSegments: [
            'raw/job-db-id/video/segment_20260418_100000.mkv',
            'raw/job-db-id/video/segment_20260418_100010.mkv',
            'raw/job-db-id/video/segment_20260418_100020.mkv',
          ],
        },
      }),
    };

    const result = await service.getJobVideos('job-db-id');

    expect(result.videos).toEqual([
      expect.objectContaining({
        index: 0,
        startOffsetMs: 0,
        endOffsetMs: 10000,
        durationMs: 10000,
      }),
      expect.objectContaining({
        index: 1,
        startOffsetMs: 10000,
        endOffsetMs: 20000,
        durationMs: 10000,
      }),
      expect.objectContaining({
        index: 2,
        startOffsetMs: 20000,
        endOffsetMs: 24000,
        durationMs: 4000,
      }),
    ]);
  });
});
