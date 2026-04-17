jest.mock('nanoid', () => ({
  nanoid: () => 'mock-cover-id',
}));

import { StreamerController } from '../../src/controller/streamer.controller';
import { InvalidStreamerCoverError } from '../../src/service/streamer.service';

describe('StreamerController cover handling', () => {
  it('uploads and persists streamer cover during creation', async () => {
    const controller = new StreamerController() as any;
    controller.ctx = {
      logger: {
        error: jest.fn(),
      },
      status: 200,
    };
    controller.platformService = {
      validateStreamerId: jest.fn().mockResolvedValue(true),
    };
    controller.streamerService = {
      create: jest.fn().mockResolvedValue({
        id: 'streamer-uuid-1',
        streamerId: 'streamer-1',
      }),
      uploadCoverDataUrl: jest
        .fn()
        .mockResolvedValue('streamers/streamer-uuid-1/cover/cover.jpg'),
      update: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn().mockResolvedValue({
        id: 'streamer-uuid-1',
        streamerId: 'streamer-1',
        coverPath: 'streamers/streamer-uuid-1/cover/cover.jpg',
      }),
      buildStreamerInfo: jest.fn().mockResolvedValue({
        id: 'streamer-uuid-1',
        streamerId: 'streamer-1',
        name: '主播A',
        platform: 'bilibili',
        roomId: '1000',
        coverPath: 'streamers/streamer-uuid-1/cover/cover.jpg',
        coverUrl: 'https://signed.example/cover.jpg',
      }),
      deleteCover: jest.fn(),
      delete: jest.fn(),
    };

    const result = await controller.addStreamer({
      streamerId: 'streamer-1',
      name: '主播A',
      platform: 'bilibili',
      roomId: '1000',
      coverDataUrl: 'data:image/jpeg;base64,aGVsbG8=',
    });

    expect(controller.streamerService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        streamerId: 'streamer-1',
        name: '主播A',
        platform: 'bilibili',
        roomId: '1000',
      })
    );
    expect(controller.streamerService.uploadCoverDataUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'streamer-uuid-1',
      }),
      'data:image/jpeg;base64,aGVsbG8='
    );
    expect(controller.streamerService.update).toHaveBeenCalledWith(
      'streamer-uuid-1',
      { coverPath: 'streamers/streamer-uuid-1/cover/cover.jpg' }
    );
    expect(controller.ctx.status).toBe(201);
    expect(result.coverUrl).toBe('https://signed.example/cover.jpg');
  });

  it('deletes the stored cover when removing a streamer', async () => {
    const controller = new StreamerController() as any;
    controller.ctx = {
      logger: {
        error: jest.fn(),
      },
      status: 200,
    };
    controller.streamerService = {
      findById: jest.fn().mockResolvedValue({
        id: 'streamer-uuid-1',
        coverPath: 'streamers/streamer-uuid-1/cover/cover.jpg',
      }),
      deleteCover: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    const result = await controller.deleteStreamer('streamer-uuid-1');

    expect(controller.streamerService.deleteCover).toHaveBeenCalledWith(
      'streamers/streamer-uuid-1/cover/cover.jpg'
    );
    expect(controller.streamerService.delete).toHaveBeenCalledWith(
      'streamer-uuid-1'
    );
    expect(result).toEqual({
      success: true,
      message: 'Streamer deleted',
    });
  });

  it('returns 400 when the cover payload is invalid', async () => {
    const controller = new StreamerController() as any;
    controller.ctx = {
      logger: {
        error: jest.fn(),
      },
      status: 200,
    };
    controller.platformService = {
      validateStreamerId: jest.fn().mockResolvedValue(true),
    };
    controller.streamerService = {
      create: jest.fn().mockResolvedValue({
        id: 'streamer-uuid-2',
        streamerId: 'streamer-2',
      }),
      uploadCoverDataUrl: jest
        .fn()
        .mockRejectedValue(new InvalidStreamerCoverError('Invalid cover image payload')),
      delete: jest.fn().mockResolvedValue(undefined),
      deleteCover: jest.fn(),
    };

    const result = await controller.addStreamer({
      streamerId: 'streamer-2',
      name: '主播B',
      platform: 'bilibili',
      roomId: '1001',
      coverDataUrl: 'broken',
    });

    expect(controller.ctx.status).toBe(400);
    expect(result).toEqual({
      error: 'Invalid cover image payload',
    });
  });
});
