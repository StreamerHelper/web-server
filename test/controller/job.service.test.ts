jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { JobService } from '../../src/service/job.service';

describe('JobService browse cover data', () => {
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

    const groups = await service.findAllGroupedByDate();

    expect(groups['2026-04-18']).toEqual([
      expect.objectContaining({
        jobId: 'job-1',
        streamerName: '主播A',
        coverUrl: 'https://signed.example/job-cover.jpg',
      }),
    ]);
  });

  it('falls back to null coverUrl when signing a cover fails', async () => {
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

    const groups = await service.findAllGroupedByDate();

    expect(groups['2026-04-18']).toEqual([
      expect.objectContaining({
        jobId: 'job-2',
        coverUrl: null,
      }),
    ]);
    expect(service.logger.warn).toHaveBeenCalled();
  });
});
