jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { DanmakuUploadProcessor } from '../../src/processor/danmaku-upload.processor';

describe('DanmakuUploadProcessor index aggregation', () => {
  it('merges segment stats, users, and timeline across uploads', async () => {
    const processor = new DanmakuUploadProcessor() as any;
    processor.jobService = {
      findById: jest.fn().mockResolvedValue({
        id: 'job-1',
        streamerId: 'streamer-1',
        platform: 'bilibili',
        roomId: 'room-1',
        metadata: {
          danmakuUserIds: ['alice', 'bob'],
          danmakuIndex: {
            jobId: 'job-1',
            streamerId: 'streamer-1',
            platform: 'bilibili',
            roomId: 'room-1',
            startTime: 0,
            endTime: 8000,
            duration: 8000,
            totalMessages: 2,
            uniqueUsers: 2,
            types: { chat: 2 },
            segments: [
              {
                segmentId: 'seg-1',
                jobId: 'job-1',
                startTime: 0,
                endTime: 8000,
                messageCount: 2,
                types: { chat: 2 },
                s3Key: 'danmaku/job-1/seg-1.jsonl',
                size: 128,
                createdAt: 1,
              },
            ],
            files: {},
          },
        },
      }),
      updateMetadata: jest.fn().mockResolvedValue(undefined),
    };

    await processor.updateDanmakuIndex(
      'job-1',
      {
        segmentId: 'seg-2',
        jobId: 'job-1',
        startTime: 10000,
        endTime: 18000,
        messageCount: 3,
        types: { chat: 1, gift: 2 },
        s3Key: 'danmaku/job-1/seg-2.jsonl',
        size: 256,
        createdAt: 2,
      },
      [
        { userId: 'alice' },
        { userId: 'charlie' },
        { userId: 'charlie' },
      ]
    );

    expect(processor.jobService.updateMetadata).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        danmakuUserIds: ['alice', 'bob', 'charlie'],
        danmakuIndex: expect.objectContaining({
          totalMessages: 5,
          uniqueUsers: 3,
          endTime: 18000,
          duration: 18000,
          types: expect.objectContaining({
            chat: 3,
            gift: 2,
          }),
        }),
      })
    );

    const payload = processor.jobService.updateMetadata.mock.calls[0][1];
    expect(payload.danmakuIndex.segments).toHaveLength(2);
    expect(payload.danmakuIndex.segments.map((segment: any) => segment.segmentId)).toEqual([
      'seg-1',
      'seg-2',
    ]);
  });
});
