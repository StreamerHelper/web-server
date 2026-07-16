jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { JobService } from '../../src/service/job.service';
import { SubmissionTemplateService } from '../../src/service/submission-template.service';
import { JOB_STATUS } from '../../src/interface';

describe('JobService startup recovery', () => {
  it('atomically fails interrupted recording states once per process', async () => {
    const service = new JobService() as any;
    service.jobModel = {
      update: jest.fn().mockResolvedValue({ affected: 3 }),
    };
    service.logger = {
      warn: jest.fn(),
    };

    const [first, second] = await Promise.all([
      service.recoverInterruptedJobsOnStartup(),
      service.recoverInterruptedJobsOnStartup(),
    ]);

    expect(first).toBe(3);
    expect(second).toBe(3);
    expect(service.jobModel.update).toHaveBeenCalledTimes(1);

    const [criteria, update] = service.jobModel.update.mock.calls[0];
    expect(criteria.status._type).toBe('in');
    expect(criteria.status._value).toEqual([
      JOB_STATUS.PENDING,
      JOB_STATUS.RECORDING,
      JOB_STATUS.STOPPING,
      JOB_STATUS.PROCESSING,
    ]);
    expect(update).toEqual({
      status: JOB_STATUS.FAILED,
      endTime: expect.any(Date),
      errorMessage: 'Application restarted before recording completed',
    });
  });

  it('retries recovery after a transient database error', async () => {
    const service = new JobService() as any;
    service.jobModel = {
      update: jest
        .fn()
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValueOnce({ affected: 0 }),
    };
    service.logger = {
      warn: jest.fn(),
    };

    await expect(service.recoverInterruptedJobsOnStartup()).rejects.toThrow(
      'database unavailable'
    );
    await expect(service.recoverInterruptedJobsOnStartup()).resolves.toBe(0);
    expect(service.jobModel.update).toHaveBeenCalledTimes(2);
  });
});

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

  it('attaches B站 submission summaries to jobs by public jobId', async () => {
    const service = new JobService() as any;
    const jobs = [
      {
        id: 'job-db-1',
        jobId: 'job-public-1',
      },
      {
        id: 'job-db-2',
        jobId: 'job-public-2',
      },
    ];
    const createdAt = new Date('2026-04-18T10:00:00+08:00');
    const updatedAt = new Date('2026-04-18T10:30:00+08:00');

    service.bilibiliSubmissionRepository = {
      findByJobIds: jest.fn().mockResolvedValue([
        {
          id: 'submission-1',
          jobId: 'job-public-1',
          title: '主播A的直播录像',
          status: 'completed',
          bvid: 'BV1xx411c7mD',
          avid: 123,
          totalParts: 2,
          completedParts: 2,
          lastError: null,
          createdAt,
          updatedAt,
        },
      ]),
    };

    const result = await service.attachSubmissionSummaries(jobs as any);

    expect(service.bilibiliSubmissionRepository.findByJobIds).toHaveBeenCalledWith(
      ['job-public-1', 'job-public-2']
    );
    expect(result[0].submissions).toEqual([
      expect.objectContaining({
        id: 'submission-1',
        jobId: 'job-public-1',
        title: '主播A的直播录像',
        status: 'completed',
        bvid: 'BV1xx411c7mD',
        totalParts: 2,
        completedParts: 2,
      }),
    ]);
    expect(result[1].submissions).toEqual([]);
  });

  it('deletes all job-scoped storage objects without touching streamer assets', async () => {
    const service = new JobService() as any;
    const job = {
      id: 'job-db-id',
      jobId: 'job-public-id',
      videoPath: 'processed/job-db-id/full.mp4',
      danmakuPath: null,
      coverPath: 'streamers/streamer-1/cover/current.jpg',
      metadata: {
        stream_url: 'https://example.com/live.flv',
        uploadedSegments: ['raw/job-db-id/video/segment_001.mkv'],
        uploadedDanmakuSegments: ['danmaku/job-db-id/segment_001.jsonl'],
        danmakuIndex: {
          segments: [
            {
              s3Key: 'danmaku/job-db-id/segment_002.jsonl',
            },
          ],
          files: {
            ass: 'danmaku/job-db-id/export.ass',
          },
        },
        transcriptIndex: {
          segments: [
            {
              s3Key: 'transcript/job-db-id/segment_001.jsonl',
            },
          ],
        },
      },
    };
    const listedObjects: Record<string, string[]> = {
      'merged/job-db-id/': ['merged/job-db-id/clip.mkv'],
      'jobs/job-public-id/': ['jobs/job-public-id/cover/snapshot.jpg'],
    };

    service.jobModel = {
      findOne: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
    };
    service.storageService = {
      list: jest
        .fn()
        .mockImplementation((prefix: string) =>
          Promise.resolve(listedObjects[prefix] || [])
        ),
      deleteMultiple: jest.fn().mockResolvedValue(undefined),
    };
    service.logger = {
      info: jest.fn(),
    };

    const result = await service.deleteJobStorage('job-db-id', 'manual');
    const deletedKeys = service.storageService.deleteMultiple.mock.calls.flatMap(
      (call: [string[]]) => call[0]
    );

    expect(result.deletedKeys).toEqual(deletedKeys);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        'processed/job-db-id/full.mp4',
        'raw/job-db-id/video/segment_001.mkv',
        'danmaku/job-db-id/segment_001.jsonl',
        'danmaku/job-db-id/segment_002.jsonl',
        'danmaku/job-db-id/export.ass',
        'transcript/job-db-id/segment_001.jsonl',
        'merged/job-db-id/clip.mkv',
        'jobs/job-public-id/cover/snapshot.jpg',
      ])
    );
    expect(deletedKeys).not.toContain('streamers/streamer-1/cover/current.jpg');
    expect(deletedKeys).not.toContain('https://example.com/live.flv');
    expect(service.jobModel.update).toHaveBeenCalledWith(
      { id: 'job-db-id' },
      { videoPath: null, danmakuPath: null }
    );
    expect(service.jobModel.query).toHaveBeenCalledWith(
      expect.stringContaining('SET metadata'),
      [
        'job-db-id',
        expect.stringContaining('"storageDeleted":true'),
      ]
    );
  });
});
