jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { BilibiliSubmissionRhythmService } from '../../src/service/bilibili-submission-rhythm.service';
import { BilibiliSubmissionService } from '../../src/service/bilibili-submission.service';
import {
  PartStatus,
  SubmissionStatus,
} from '../../src/entity/bilibili-submission.entity';

describe('BilibiliSubmissionRhythmService', () => {
  const originalTimeZone = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = 'Asia/Shanghai';
  });

  afterAll(() => {
    if (originalTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimeZone;
    }
  });

  const createSegmentKeys = (jobId: string, count: number, startMinute = 0) =>
    Array.from({ length: count }, (_, index) => {
      const totalSeconds = startMinute * 60 + index * 10;
      const minute = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
      const second = String(totalSeconds % 60).padStart(2, '0');
      return `raw/${jobId}/video/segment_20260426_04${minute}${second}.mkv`;
    });

  const createService = () => {
    const service = new BilibiliSubmissionRhythmService() as any;
    const submissionCore = new BilibiliSubmissionService() as any;
    service.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    service.jobService = {
      findById: jest.fn(),
      findByJobId: jest.fn(),
    };
    service.streamerService = {
      findByStreamerId: jest.fn(),
    };
    service.submissionRepository = {
      findById: jest.fn(),
      findByJobId: jest.fn(),
      save: jest.fn(async value => value),
    };
    service.submissionService = {
      buildSubmissionPart:
        submissionCore.buildSubmissionPart.bind(submissionCore),
      normalizeSubmissionParts:
        submissionCore.normalizeSubmissionParts.bind(submissionCore),
      createSubmission: jest.fn(async payload => ({
        id: 'submission-first',
        ...payload,
      })),
    };
    service.queue = {
      addJobToQueue: jest.fn(),
    };
    service.bullFramework = {
      getQueue: jest.fn(() => service.queue),
    };
    return service;
  };

  it('creates the first segmented submission when an interval is ready', async () => {
    const service = createService();
    const uploadedSegments = createSegmentKeys('job-first', 6);

    service.jobService.findById.mockResolvedValue({
      id: 'job-entity-first',
      jobId: 'job-first',
      streamerId: 'streamer-first',
      metadata: { uploadedSegments },
    });
    service.streamerService.findByStreamerId.mockResolvedValue({
      uploadSettings: {
        autoUpload: true,
        rhythm: { mode: 'segmented', intervalMinutes: 1 },
        title: '{主播名}直播录像',
        tags: ['直播'],
      },
    });
    service.submissionRepository.findByJobId.mockResolvedValue([]);

    await service.handleUploadedVideoSegment('job-entity-first');

    expect(service.submissionService.createSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-first',
        parts: [
          expect.objectContaining({
            title: '2026-04-26 12:00',
            rhythmIntervalMinutes: 1,
            s3Keys: uploadedSegments,
          }),
        ],
      })
    );
    expect(service.queue.addJobToQueue).toHaveBeenCalledWith(
      { submissionId: 'submission-first' },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      }
    );
  });

  it('appends ready parts to the existing segmented submission', async () => {
    const service = createService();
    const uploadedSegments = createSegmentKeys('job-append', 12);
    const firstPart = service.submissionService.buildSubmissionPart(
      uploadedSegments.slice(0, 6),
      1,
      PartStatus.COMPLETED,
      1,
      { filename: 'old-file', cid: 1001 }
    );
    const existingSubmission = {
      id: 'submission-existing',
      jobId: 'job-append',
      status: SubmissionStatus.COMPLETED,
      parts: [firstPart],
      totalParts: 1,
      completedParts: 1,
      lastError: null,
    };

    service.jobService.findById.mockResolvedValue({
      id: 'job-entity-append',
      jobId: 'job-append',
      streamerId: 'streamer-append',
      metadata: { uploadedSegments },
    });
    service.streamerService.findByStreamerId.mockResolvedValue({
      uploadSettings: {
        autoUpload: true,
        rhythm: { mode: 'segmented', intervalMinutes: 1 },
      },
    });
    service.submissionRepository.findByJobId.mockResolvedValue([
      existingSubmission,
    ]);

    await service.handleUploadedVideoSegment('job-entity-append');

    expect(service.submissionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'submission-existing',
        status: SubmissionStatus.PENDING,
        totalParts: 2,
        parts: [
          expect.objectContaining({ index: 1 }),
          expect.objectContaining({
            index: 2,
            title: '2026-04-26 12:01',
            rhythmIntervalMinutes: 1,
            s3Keys: uploadedSegments.slice(6),
          }),
        ],
      })
    );
    expect(service.queue.addJobToQueue).toHaveBeenCalledWith(
      { submissionId: 'submission-existing' },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      }
    );
  });

  it('flushes the remaining tail segment when recording ends', async () => {
    const service = createService();
    const uploadedSegments = createSegmentKeys('job-tail', 3);

    service.jobService.findById.mockResolvedValue({
      id: 'job-entity-tail',
      jobId: 'job-tail',
      streamerId: 'streamer-tail',
      metadata: { uploadedSegments },
    });
    service.streamerService.findByStreamerId.mockResolvedValue({
      uploadSettings: {
        autoUpload: true,
        rhythm: { mode: 'segmented', intervalMinutes: 1 },
      },
    });
    service.submissionRepository.findByJobId.mockResolvedValue([]);

    await service.flushJob('job-entity-tail');

    expect(service.submissionService.createSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-tail',
        parts: [
          expect.objectContaining({
            rhythmIntervalMinutes: 1,
            s3Keys: uploadedSegments,
          }),
        ],
      })
    );
  });

  it('waits for matching transcript segments before burn-in subtitle submissions', async () => {
    const service = createService();
    const uploadedSegments = createSegmentKeys('job-subtitles', 6);
    const transcriptSegments = uploadedSegments.slice(0, 5).map(key => ({
      segmentId: key
        .split('/')
        .pop()!
        .replace(/\.[^.]+$/, ''),
    }));

    service.jobService.findById.mockResolvedValueOnce({
      id: 'job-entity-subtitles',
      jobId: 'job-subtitles',
      streamerId: 'streamer-subtitles',
      metadata: {
        uploadedSegments,
        transcriptIndex: {
          segments: transcriptSegments,
        },
      },
    });
    service.streamerService.findByStreamerId.mockResolvedValue({
      uploadSettings: {
        autoUpload: true,
        burnInSubtitles: true,
        rhythm: { mode: 'segmented', intervalMinutes: 1 },
      },
    });
    service.submissionRepository.findByJobId.mockResolvedValue([]);

    await service.handleUploadedVideoSegment('job-entity-subtitles');

    expect(service.submissionService.createSubmission).not.toHaveBeenCalled();
    expect(service.queue.addJobToQueue).not.toHaveBeenCalled();

    service.jobService.findById.mockResolvedValueOnce({
      id: 'job-entity-subtitles',
      jobId: 'job-subtitles',
      streamerId: 'streamer-subtitles',
      metadata: {
        uploadedSegments,
        transcriptIndex: {
          segments: uploadedSegments.map(key => ({
            segmentId: key
              .split('/')
              .pop()!
              .replace(/\.[^.]+$/, ''),
          })),
        },
      },
    });

    await service.handleTranscriptSegmentReady('job-entity-subtitles');

    expect(service.submissionService.createSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-subtitles',
        parts: [
          expect.objectContaining({
            burnInSubtitles: true,
            rhythmIntervalMinutes: 1,
            s3Keys: uploadedSegments,
          }),
        ],
        burnInSubtitles: true,
      })
    );
    expect(service.queue.addJobToQueue).toHaveBeenCalledWith(
      { submissionId: 'submission-first' },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      }
    );
  });
});
