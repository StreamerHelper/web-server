jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { BilibiliSubmissionService } from '../../src/service/bilibili-submission.service';
import { SubmissionTemplateService } from '../../src/service/submission-template.service';
import {
  PartStatus,
  SubmissionStatus,
} from '../../src/entity/bilibili-submission.entity';

describe('BilibiliSubmissionService title handling', () => {
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
      findById: jest.fn(),
      updateStatus: jest.fn(),
      updatePartStatus: jest.fn(),
      updateUploadedResult: jest.fn(),
      updateCollectionResult: jest.fn(),
      completeSubmission: jest.fn(),
    };
    service.uploadService = {
      submitVideoParts: jest.fn(),
      editVideoParts: jest.fn(),
      uploadPartFromLocal: jest.fn(),
    };
    service.bilibiliSeasonService = {
      addVideoToSeason: jest.fn(),
    };
    service.bilibiliPartitionService = {
      resolveHumanType2: jest
        .fn()
        .mockImplementation(value => value || 2066),
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
        title: '{主播名} {日期}',
        description: '默认简介',
        tags: ['默认标签'],
        humanType2: 2066,
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
        humanType2: 2066,
        tid: 171,
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
      roomName: '录制时房间名',
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
        title: '{主播名} {房间名} {日期} {时间}',
      },
    });

    await service.createSubmission({
      jobId: 'job-rename',
    });

    expect(service.submissionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '录制时主播名 录制时房间名 2026-04-18 08:30',
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
        title: '{主播名} {日期}',
        description: '默认简介',
        tags: ['默认标签'],
        humanType2: 2096,
      },
    });

    await service.createSubmission({
      jobId: 'job-2',
      title: '手动标题',
      description: '手动简介',
      tags: ['手动标签'],
      humanType2: 2016,
    });

    expect(service.submissionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-2',
        title: '手动标题',
        description: '手动简介',
        tags: ['手动标签'],
        humanType2: 2016,
        tid: 171,
        cover: 'streamers/streamer-2/cover/default.jpg',
        copyright: 2,
        source: 'https://www.huya.com/room-200',
      })
    );
  });

  it('stores the streamer collection binding on created submissions', async () => {
    const service = createService();
    service.jobService.findByJobId.mockResolvedValue({
      jobId: 'job-collection',
      streamerId: 'streamer-collection',
      streamerName: '合集主播',
      platform: 'bilibili',
      roomId: '12345',
      startTime: new Date('2026-04-18T12:00:00+08:00'),
      createdAt: new Date('2026-04-18T12:00:00+08:00'),
      metadata: {
        uploadedSegments: ['raw/job-collection/video/segment_001.mkv'],
      },
    });
    service.streamerService.findByStreamerId.mockResolvedValue({
      name: '合集主播',
      uploadSettings: {
        collection: {
          autoAdd: true,
          seasonId: 1001,
          sectionId: 2002,
          seasonTitle: '合集主播直播录像',
          sectionTitle: '正片',
        },
      },
    });

    await service.createSubmission({
      jobId: 'job-collection',
    });

    expect(service.submissionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionAutoAdd: true,
        collectionSeasonId: 1001,
        collectionSectionId: 2002,
        collectionSeasonTitle: '合集主播直播录像',
        collectionSectionTitle: '正片',
      })
    );
  });

  it('groups uploaded segments into 1-hour parts by default', async () => {
    const service = createService();
    const uploadedSegments = Array.from(
      { length: 361 },
      (_, index) =>
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

  it('uses date and time as fixed part titles', async () => {
    const service = createService();
    const uploadedSegments = [
      'raw/job-title/video/segment_20260426_120000.mkv',
      'raw/job-title/video/segment_20260426_120010.mkv',
    ];

    service.jobService.findByJobId.mockResolvedValue({
      jobId: 'job-title',
      streamerId: 'streamer-title',
      streamerName: '标题主播',
      platform: 'douyin',
      roomId: '88983834188',
      startTime: new Date('2026-04-26T12:00:00+08:00'),
      createdAt: new Date('2026-04-26T12:00:00+08:00'),
      metadata: {
        uploadedSegments,
      },
    });
    service.streamerService.findByStreamerId.mockResolvedValue({
      name: '标题主播',
      uploadSettings: {},
    });

    await service.createSubmission({
      jobId: 'job-title',
    });

    expect(service.submissionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [
          expect.objectContaining({
            title: '2026-04-26 12:00',
            s3Keys: uploadedSegments,
          }),
        ],
      })
    );
  });

  it('edits an existing archive when new pending parts are appended', async () => {
    const service = createService();
    service.submissionRepository.findById.mockResolvedValue({
      id: 'submission-append',
      status: SubmissionStatus.COMPLETED,
      totalParts: 2,
      completedParts: 1,
      parts: [
        {
          index: 1,
          title: '2026-04-26 12:00',
          s3Keys: ['raw/job-append/video/segment_20260426_120000.mkv'],
          status: PartStatus.COMPLETED,
          filename: 'old-file',
          cid: 1001,
        },
        {
          index: 2,
          s3Keys: ['raw/job-append/video/segment_20260426_123000.mkv'],
          status: PartStatus.PENDING,
        },
      ],
      bvid: 'BV1xx411c7mD',
      avid: 123456,
      title: '分段投稿标题',
      description: '简介',
      tags: ['直播'],
      tid: 171,
      humanType2: 2066,
      cover: null,
      copyright: 2,
      source: 'https://live.douyin.com/88983834188',
      dynamic: '',
      collectionAutoAdd: false,
    });
    service.downloadAndMergeSegments = jest
      .fn()
      .mockResolvedValue({
        filePath: '/tmp/part_2.mkv',
        duration: 1800000,
        fileSize: 512000000,
      });
    service.uploadService.uploadPartFromLocal.mockResolvedValue({
      filename: 'new-file',
      cid: 1002,
    });
    service.uploadService.editVideoParts.mockResolvedValue({
      bvid: '',
      avid: 123456,
    });

    await service.processSubmission('submission-append');

    expect(service.uploadService.submitVideoParts).not.toHaveBeenCalled();
    expect(service.uploadService.editVideoParts).toHaveBeenCalledWith(
      123456,
      [
        {
          title: '2026-04-26 12:00',
          filename: 'old-file',
          cid: 1001,
        },
        {
          title: '2026-04-26 12:30',
          filename: 'new-file',
          cid: 1002,
        },
      ],
      expect.objectContaining({
        title: '分段投稿标题',
        humanType2: 2066,
      })
    );
    expect(service.submissionRepository.updateUploadedResult).toHaveBeenCalledWith(
      'submission-append',
      'BV1xx411c7mD',
      123456
    );
    expect(service.submissionRepository.updatePartStatus).toHaveBeenCalledWith(
      'submission-append',
      2,
      PartStatus.COMPLETED,
      expect.objectContaining({
        duration: 1800000,
        size: 512000000,
      })
    );
  });

  it('adds an already uploaded submission to its configured collection without reuploading', async () => {
    const service = createService();
    service.submissionRepository.findById.mockResolvedValue({
      id: 'submission-collection',
      status: SubmissionStatus.FAILED,
      totalParts: 1,
      completedParts: 1,
      parts: [],
      bvid: 'BV1xx411c7mD',
      avid: 123456,
      title: '合集投稿标题',
      collectionAutoAdd: true,
      collectionSeasonId: 1001,
      collectionSectionId: 2002,
    });
    service.bilibiliSeasonService.addVideoToSeason.mockResolvedValue({
      episodeId: 3003,
      alreadyExists: false,
    });

    await service.processSubmission('submission-collection');

    expect(service.uploadService.submitVideoParts).not.toHaveBeenCalled();
    expect(service.bilibiliSeasonService.addVideoToSeason).toHaveBeenCalledWith(
      {
        aid: 123456,
        sectionId: 2002,
        title: '合集投稿标题',
      }
    );
    expect(
      service.submissionRepository.updateCollectionResult
    ).toHaveBeenCalledWith('submission-collection', 3003);
    expect(
      service.submissionRepository.completeSubmission
    ).toHaveBeenCalledWith('submission-collection');
  });

  it('passes the uploaded part cid when adding a new submission to collection', async () => {
    const service = createService();
    service.submissionRepository.findById.mockResolvedValue({
      id: 'submission-new-collection',
      status: SubmissionStatus.PENDING,
      totalParts: 1,
      completedParts: 0,
      parts: [
        {
          index: 1,
          title: '2026-04-26 12:00',
          s3Keys: ['raw/job-new/video/segment_20260426_120000.mkv'],
          status: PartStatus.PENDING,
        },
      ],
      bvid: null,
      avid: null,
      title: '新投稿合集标题',
      description: '简介',
      tags: ['直播'],
      tid: 171,
      humanType2: 2066,
      cover: null,
      copyright: 2,
      source: 'https://live.bilibili.com/12345',
      dynamic: '',
      collectionAutoAdd: true,
      collectionSeasonId: 1001,
      collectionSectionId: 2002,
    });
    service.downloadAndMergeSegments = jest.fn().mockResolvedValue({
      filePath: '/tmp/part_1.mkv',
      duration: 1800000,
      fileSize: 512000000,
    });
    service.uploadService.uploadPartFromLocal.mockResolvedValue({
      filename: 'uploaded-file',
      cid: 654321,
    });
    service.uploadService.submitVideoParts.mockResolvedValue({
      bvid: 'BV1xx411c7mD',
      avid: 123456,
    });
    service.bilibiliSeasonService.addVideoToSeason.mockResolvedValue({
      episodeId: 3003,
      alreadyExists: false,
    });

    await service.processSubmission('submission-new-collection');

    expect(service.bilibiliSeasonService.addVideoToSeason).toHaveBeenCalledWith(
      {
        aid: 123456,
        sectionId: 2002,
        title: '新投稿合集标题',
        cid: 654321,
      }
    );
  });

  it('regenerates a deleted archive from reusable bilibili filenames', async () => {
    const service = createService();
    service.submissionRepository.findById
      .mockResolvedValueOnce({
        id: 'submission-regenerate',
        jobId: 'job-regenerate',
        status: SubmissionStatus.COMPLETED,
        totalParts: 1,
        completedParts: 1,
        parts: [
          {
            index: 1,
            title: '2026-05-09 14:54',
            s3Keys: ['raw/job-regenerate/video/segment_20260509_145400.mkv'],
            status: PartStatus.COMPLETED,
            filename: 'n260509sa1p5pm5tjzhi3s2zvzqlo86x',
            cid: 38219941091,
          },
        ],
        bvid: 'BV1old',
        avid: 100001,
        title: '可恶小乐的直播录像 2026-05-09',
        description: '简介',
        tags: ['直播'],
        tid: 171,
        humanType2: 2066,
        cover: null,
        copyright: 2,
        source: 'https://live.bilibili.com/1914111820',
        dynamic: '',
        collectionAutoAdd: false,
      })
      .mockResolvedValueOnce({
        id: 'submission-regenerate',
        bvid: 'BV1new',
        avid: 200002,
      });
    service.uploadService.submitVideoParts.mockResolvedValue({
      bvid: 'BV1new',
      avid: 200002,
    });

    const result = await service.regenerateSubmission('submission-regenerate');

    expect(service.submissionRepository.updateStatus).toHaveBeenCalledWith(
      'submission-regenerate',
      SubmissionStatus.SUBMITTING
    );
    expect(service.uploadService.submitVideoParts).toHaveBeenCalledWith(
      [
        {
          title: '2026-05-09 14:54',
          filename: 'n260509sa1p5pm5tjzhi3s2zvzqlo86x',
          cid: 38219941091,
          omitCid: true,
        },
      ],
      expect.objectContaining({
        title: '可恶小乐的直播录像 2026-05-09',
        humanType2: 2066,
      })
    );
    expect(service.submissionRepository.updateUploadedResult).toHaveBeenCalledWith(
      'submission-regenerate',
      'BV1new',
      200002
    );
    expect(
      service.submissionRepository.completeSubmission
    ).toHaveBeenCalledWith('submission-regenerate');
    expect(result.bvid).toBe('BV1new');
  });

  it('rejects regeneration when uploaded filename or cid is missing', async () => {
    const service = createService();
    service.submissionRepository.findById.mockResolvedValue({
      id: 'submission-missing-upload',
      parts: [
        {
          index: 1,
          title: '2026-05-09 14:54',
          s3Keys: ['raw/job/video/segment_20260509_145400.mkv'],
          status: PartStatus.COMPLETED,
        },
      ],
    });

    await expect(
      service.regenerateSubmission('submission-missing-upload')
    ).rejects.toThrow('Missing reusable Bilibili filename or CID for parts: P1');
    expect(service.uploadService.submitVideoParts).not.toHaveBeenCalled();
  });

  it('retries regeneration with a temporary recovery title when bilibili blocks duplicate title submission', async () => {
    const service = createService();
    service.submissionRepository.findById
      .mockResolvedValueOnce({
        id: 'submission-duplicate-title',
        jobId: 'job-duplicate-title',
        status: SubmissionStatus.FAILED,
        totalParts: 1,
        completedParts: 1,
        parts: [
          {
            index: 1,
            title: '2026-05-09 14:54',
            s3Keys: ['raw/job/video/segment_20260509_145400.mkv'],
            status: PartStatus.COMPLETED,
            filename: 'uploaded-file',
            cid: 1001,
          },
        ],
        bvid: 'BV1old',
        avid: 100001,
        title: '重复标题投稿',
        description: '简介',
        tags: ['直播'],
        tid: 171,
        humanType2: 2066,
        cover: null,
        copyright: 2,
        source: 'https://live.bilibili.com/1914111820',
        dynamic: '',
        collectionAutoAdd: false,
      })
      .mockResolvedValueOnce({
        id: 'submission-duplicate-title',
        bvid: 'BV1new',
        avid: 200002,
      });
    service.uploadService.submitVideoParts
      .mockRejectedValueOnce(
        new Error(
          'Failed to submit video: 稿件已成功投稿，请勿重新提交哦～\n提交时间：23:06 稿件名《重复标题投稿》'
        )
      )
      .mockResolvedValueOnce({
        bvid: 'BV1new',
        avid: 200002,
      });
    service.uploadService.editVideoParts
      .mockRejectedValueOnce(new Error('deleted archive cannot edit directly'))
      .mockResolvedValueOnce({
        bvid: 'BV1new',
        avid: 200002,
      });

    await service.regenerateSubmission('submission-duplicate-title');

    expect(service.uploadService.submitVideoParts).toHaveBeenCalledTimes(2);
    expect(service.uploadService.submitVideoParts).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      expect.objectContaining({
        title: expect.stringContaining('重复标题投稿 恢复'),
      })
    );
    expect(service.uploadService.editVideoParts).toHaveBeenCalledWith(
      200002,
      expect.any(Array),
      expect.objectContaining({
        title: '重复标题投稿',
      })
    );
    expect(service.submissionRepository.updateUploadedResult).toHaveBeenCalledWith(
      'submission-duplicate-title',
      'BV1new',
      200002
    );
  });
});
