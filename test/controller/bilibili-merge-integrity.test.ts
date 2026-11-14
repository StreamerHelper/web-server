jest.mock('nanoid', () => ({ nanoid: () => 'mock-job-id' }));

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BilibiliSubmissionService } from '../../src/service/bilibili-submission.service';

describe('Bilibili merge input validation', () => {
  it('skips empty stored segments and only fails when nothing usable is left', async () => {
    const service = new BilibiliSubmissionService() as any;
    service.logger = { debug: jest.fn(), warn: jest.fn() };
    service.storageService = {
      download: jest.fn().mockResolvedValue(Buffer.alloc(0)),
    };
    await expect(
      service.downloadAndMergeSegments(['raw/job/video/empty.mkv'], '/tmp', 1)
    ).rejects.toThrow('No non-empty video segments');
    expect(service.logger.warn).toHaveBeenCalledWith(
      'Skipping empty video segment',
      { s3Key: 'raw/job/video/empty.mkv' }
    );
  });
});

const hasFFmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
(hasFFmpeg ? describe : describe.skip)(
  'Bilibili merge real FFmpeg regression',
  () => {
    let dir: string;
    let service: any;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-merge-test-'));
      service = new BilibiliSubmissionService() as any;
      service.logger = { debug: jest.fn(), warn: jest.fn() };
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=64x64:rate=10',
        '-t',
        '0.5',
        '-c:v',
        'libx264',
        '-y',
        path.join(dir, 'good.mkv'),
      ]);
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('merges every valid input', async () => {
      const input = path.join(dir, 'good.mkv');
      const result = await service.mergeSegments(
        [input, input],
        path.join(dir, 'merged.mkv')
      );
      expect(result.duration).toBeGreaterThanOrEqual(1000);
      // -avoid_negative_ts make_zero 会把第二个分片的 0.022s 偏移补齐，多出约 0.2s
      expect(result.duration).toBeLessThan(1300);
    });

    it('rejects a broken middle input instead of accepting a truncated successful exit', async () => {
      const input = path.join(dir, 'good.mkv');
      const broken = path.join(dir, 'broken.mkv');
      await fs.writeFile(broken, Buffer.from('invalid matroska'));
      await expect(
        service.mergeSegments(
          [input, broken, input],
          path.join(dir, 'merged.mkv')
        )
      ).rejects.toThrow('FFmpeg merge failed');
    });

    it('rejects probe errors rather than leaving the upload promise hanging', async () => {
      const input = path.join(dir, 'good.mkv');
      service.getVideoDuration = jest
        .fn()
        .mockRejectedValue(new Error('probe failed'));
      await expect(
        service.mergeSegments([input], path.join(dir, 'merged.mkv'))
      ).rejects.toThrow('probe failed');
    });
  }
);
