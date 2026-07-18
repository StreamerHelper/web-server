import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BilibiliUploadService } from '../../src/service/bilibili-upload.service';

describe('BilibiliUploadService streaming uploads', () => {
  const createService = () => {
    const service = new BilibiliUploadService() as any;
    service.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    service.credentialRepository = {
      findValid: jest.fn().mockResolvedValue({
        expiresAt: new Date(Date.now() + 60_000),
        cookies: {
          bili_jct: 'csrf-token',
          SESSDATA: 'session',
        },
      }),
    };
    service.probeLine = jest.fn().mockResolvedValue({
      name: 'bldsa',
      query: 'zone=cs',
    });
    service.preupload = jest.fn().mockResolvedValue({
      chunkSize: 4,
      auth: 'upos-auth',
      endpoint: 'upload.example.com',
      bizId: 9988,
      uposUri: 'upos://ugc/video/test-file.mkv',
    });
    service.getUploadId = jest.fn().mockResolvedValue('upload-id');
    service.mergeChunks = jest.fn().mockResolvedValue(undefined);
    return service;
  };

  it('reads a local file by upload chunk instead of loading the whole file', async () => {
    const service = createService();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-upload-'));
    const localPath = path.join(tempDir, 'video.mkv');
    const uploadedChunks: string[] = [];
    const uploadedSizes: number[] = [];

    service.uploadChunk = jest.fn(
      async (
        _endpoint: string,
        _uposUri: string,
        _uploadId: string,
        _chunkIndex: number,
        _totalChunks: number,
        _totalSize: number,
        _start: number,
        _end: number,
        chunkSize: number,
        chunkData: AsyncIterable<Buffer>
      ) => {
        const chunks: Buffer[] = [];
        for await (const chunk of chunkData) {
          chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        uploadedSizes.push(chunkSize);
        uploadedChunks.push(body.toString('utf8'));
        expect(body).toHaveLength(chunkSize);
        return `etag-${uploadedChunks.length}`;
      }
    );

    try {
      await fs.writeFile(localPath, Buffer.from('abcdefghij'));

      const result = await service.uploadPartFromLocal(localPath, {
        title: 'P1',
        filename: 'video.mkv',
        s3Key: '',
        duration: 0,
        size: 0,
      });

      expect(service.preupload).toHaveBeenCalledWith(
        'P1',
        10,
        { name: 'bldsa', query: 'zone=cs' },
        {
          bili_jct: 'csrf-token',
          SESSDATA: 'session',
        }
      );
      expect(uploadedChunks).toEqual(['abcd', 'efgh', 'ij']);
      expect(uploadedSizes).toEqual([4, 4, 2]);
      expect(service.mergeChunks).toHaveBeenCalledWith(
        'upload.example.com',
        'upos://ugc/video/test-file.mkv',
        'upload-id',
        9988,
        'P1',
        [
          { partNumber: 1, eTag: 'etag-1' },
          { partNumber: 2, eTag: 'etag-2' },
          { partNumber: 3, eTag: 'etag-3' },
        ],
        'upos-auth'
      );
      expect(result).toEqual({
        filename: 'test-file',
        cid: 9988,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('aborts stalled upload requests and destroys their streams', async () => {
    jest.useFakeTimers();
    const service = createService();
    const body = { destroy: jest.fn() };
    jest.spyOn(global, 'fetch').mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })
    );

    try {
      const request = service.fetchWithTimeout(
        'https://upload.example.com/chunk',
        { method: 'POST', body } as any,
        1000,
        'upload test chunk'
      );
      const rejection = expect(request).rejects.toThrow(
        'Bilibili request timed out after 1000ms: upload test chunk'
      );

      await jest.advanceTimersByTimeAsync(1000);
      await rejection;

      expect(body.destroy).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });
});
