import {
  ILogger,
  Inject,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import * as path from 'path';
import { BilibiliCredential } from '../interface';
import { BilibiliCredentialRepository } from '../repository/bilibili-credential.repository';
import { StorageService } from './storage.service';
import { DEFAULT_BILIBILI_HUMAN_TYPE2 } from '../config/bilibili-partitions';

/**
 * 视频分片信息
 */
export interface VideoPart {
  title: string;
  filename: string;
  s3Key: string;
  duration: number;
  size: number;
}

/**
 * B站投稿选项
 */
export interface BilibiliUploadOptions {
  title: string;
  description?: string;
  tags?: string[];
  tid?: number;
  humanType2?: number;
  cover?: string;
  copyright?: number;
  source?: string;
  dynamic?: string;
  noReprint?: number;
}

/**
 * 上传结果
 */
export interface BilibiliUploadResult {
  bvid: string;
  avid: number;
}

export interface BilibiliUploadedPart {
  title: string;
  filename: string;
  cid: number;
}

// 上传线路配置
const UPLOAD_LINES = [
  { name: 'bldsa', query: 'zone=cs&upcdn=bldsa&probe_version=20221109' },
  { name: 'bda2', query: 'probe_version=20221109&upcdn=bda2&zone=cs' },
  { name: 'tx', query: 'zone=cs&upcdn=tx&probe_version=20221109' },
  { name: 'alia', query: 'zone=cs&upcdn=alia&probe_version=20221109' },
];

interface PreuploadResult {
  chunkSize: number;
  auth: string;
  endpoint: string;
  bizId: number;
  uposUri: string;
}

interface BilibiliPredictedPartition {
  id: number;
  show?: boolean;
}

interface UploadPartInfo {
  partNumber: number;
  eTag: string;
}

/**
 * B站视频上传服务
 * 实现 UPOS 协议上传
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class BilibiliUploadService {
  @Logger()
  private logger: ILogger;

  @Inject()
  private credentialRepository: BilibiliCredentialRepository;

  @Inject()
  private storageService: StorageService;

  /**
   * 上传视频到 B站
   *
   * @param parts 视频分 P 列表
   * @param options 投稿选项
   * @returns 上传结果
   */
  async upload(
    parts: VideoPart[],
    options: BilibiliUploadOptions
  ): Promise<BilibiliUploadResult> {
    // 获取凭证
    const credential = await this.credentialRepository.findValid();
    if (!credential) {
      throw new Error('Bilibili not authenticated. Please login first.');
    }

    // 检查凭证是否过期
    if (new Date() >= credential.expiresAt) {
      throw new Error('Bilibili credential expired. Please login again.');
    }

    const cookies = credential.cookies as Record<string, string>;

    // 1. 探测最优线路
    const line = await this.probeLine();
    this.logger.info('Selected upload line', { line: line.name });

    // 2. 上传所有视频分 P
    const uploadedParts: BilibiliUploadedPart[] = [];

    for (const part of parts) {
      this.logger.info('Uploading video part', {
        title: part.title,
        s3Key: part.s3Key,
      });

      // 2.1 分片上传
      const uploadResult = await this.uploadPart(part, line, cookies);
      uploadedParts.push({
        title: part.title,
        filename: uploadResult.filename,
        cid: uploadResult.cid,
      });
    }

    // 3. 上传封面
    const coverUrl = await this.resolveCoverForSubmission(
      options.cover,
      cookies
    );

    // 4. 提交稿件
    const result = await this.submitVideo(
      uploadedParts,
      options,
      coverUrl,
      credential
    );

    this.logger.info('Bilibili upload completed', {
      bvid: result.bvid,
      avid: result.avid,
    });

    return result;
  }

  /**
   * 线路探测
   */
  private async probeLine(): Promise<(typeof UPLOAD_LINES)[0]> {
    const lines: Array<{ name: string; query: string; responseTime: number }> =
      [];

    for (const line of UPLOAD_LINES) {
      const url = `https://upos-cs-upcdn${line.name}.bilivideo.com/OK`;
      try {
        const startTime = Date.now();
        await fetch(url, { method: 'GET' });
        const responseTime = Date.now() - startTime;
        lines.push({ name: line.name, query: line.query, responseTime });
      } catch (error) {
        this.logger.warn('Line probe failed', {
          line: line.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (lines.length === 0) {
      // 如果所有线路探测失败，使用默认线路
      return UPLOAD_LINES[0];
    }

    lines.sort((a, b) => a.responseTime - b.responseTime);
    return lines[0];
  }

  /**
   * 从本地文件上传单个视频分 P
   */
  async uploadPartFromLocal(
    localPath: string,
    part: VideoPart
  ): Promise<{ filename: string; cid: number }> {
    const credential = await this.credentialRepository.findValid();
    if (!credential) {
      throw new Error('Bilibili not authenticated. Please login first.');
    }

    if (new Date() >= credential.expiresAt) {
      throw new Error('Bilibili credential expired. Please login again.');
    }

    const cookies = credential.cookies as Record<string, string>;
    const line = await this.probeLine();

    this.logger.info('Uploading from local file', {
      localPath,
      line: line.name,
    });

    // 读取文件
    const fs = await import('fs/promises');
    const fileBuffer = await fs.readFile(localPath);
    const fileSize = fileBuffer.length;

    // 预上传获取凭证
    const preupload = await this.preupload(part.title, fileSize, line, cookies);

    // 获取 UploadId
    const uploadId = await this.getUploadId(
      preupload.endpoint,
      preupload.uposUri,
      preupload.auth
    );

    // 分片上传
    const chunks = Math.ceil(fileSize / preupload.chunkSize);
    const parts: UploadPartInfo[] = [];

    for (let i = 0; i < chunks; i++) {
      const start = i * preupload.chunkSize;
      const end = Math.min(start + preupload.chunkSize, fileSize);
      const chunkData = fileBuffer.subarray(start, end);

      const eTag = await this.uploadChunk(
        preupload.endpoint,
        preupload.uposUri,
        uploadId,
        i,
        chunks,
        fileSize,
        start,
        end,
        chunkData,
        preupload.auth
      );

      parts.push({ partNumber: i + 1, eTag });

      this.logger.debug('Chunk uploaded', {
        partIndex: part.title,
        chunkIndex: i + 1,
        totalChunks: chunks,
        progress: Math.round(((i + 1) / chunks) * 100),
      });
    }

    // 合并分片
    await this.mergeChunks(
      preupload.endpoint,
      preupload.uposUri,
      uploadId,
      preupload.bizId,
      part.title,
      parts,
      preupload.auth
    );

    // 从 uposUri 提取 filename（只取文件名，不含路径和扩展名）
    const filenameWithExt = path.basename(
      preupload.uposUri.replace('upos://', '')
    );
    const filename = path.parse(filenameWithExt).name;

    this.logger.info('Local file upload completed', {
      localPath,
      filename,
      cid: preupload.bizId,
    });

    return {
      filename,
      cid: preupload.bizId,
    };
  }

  /**
   * 上传单个视频分 P
   */
  private async uploadPart(
    part: VideoPart,
    line: (typeof UPLOAD_LINES)[0],
    cookies: Record<string, string>
  ): Promise<{ filename: string; cid: number }> {
    // 从 S3 下载文件
    const fileBuffer = await this.storageService.download(part.s3Key);
    const fileSize = fileBuffer.length;

    // 预上传获取凭证
    const preupload = await this.preupload(part.title, fileSize, line, cookies);

    // 获取 UploadId
    const uploadId = await this.getUploadId(
      preupload.endpoint,
      preupload.uposUri,
      preupload.auth
    );

    // 分片上传
    const chunks = Math.ceil(fileSize / preupload.chunkSize);
    const parts: UploadPartInfo[] = [];

    for (let i = 0; i < chunks; i++) {
      const start = i * preupload.chunkSize;
      const end = Math.min(start + preupload.chunkSize, fileSize);
      const chunkData = fileBuffer.subarray(start, end);

      const eTag = await this.uploadChunk(
        preupload.endpoint,
        preupload.uposUri,
        uploadId,
        i,
        chunks,
        fileSize,
        start,
        end,
        chunkData,
        preupload.auth
      );

      parts.push({ partNumber: i + 1, eTag });
    }

    // 合并分片
    await this.mergeChunks(
      preupload.endpoint,
      preupload.uposUri,
      uploadId,
      preupload.bizId,
      part.title,
      parts,
      preupload.auth
    );

    // 从 uposUri 提取 filename（只取文件名，不含路径和扩展名）
    const filenameWithExt = path.basename(
      preupload.uposUri.replace('upos://', '')
    );
    const filename = path.parse(filenameWithExt).name;

    return { filename, cid: preupload.bizId };
  }

  /**
   * 预上传获取凭证
   */
  private async preupload(
    filename: string,
    fileSize: number,
    line: (typeof UPLOAD_LINES)[0],
    cookies: Record<string, string>
  ): Promise<PreuploadResult> {
    const params = new URLSearchParams({
      name: filename,
      r: 'upos',
      profile: 'ugcupos/bup',
      ssl: '0',
      version: '2.14.0',
      build: '2140000',
      size: fileSize.toString(),
    });

    const url = `https://member.bilibili.com/preupload?${
      line.query
    }&${params.toString()}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Cookie: Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to preupload: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      OK?: number;
      message?: string;
      chunk_size?: number;
      auth?: string;
      endpoint?: string;
      biz_id?: number;
      upos_uri?: string;
    };
    if (data.OK !== 1) {
      throw new Error(`Preupload failed: ${data.message || 'Unknown error'}`);
    }

    return {
      chunkSize: data.chunk_size!,
      auth: data.auth!,
      endpoint: data.endpoint!.replace('//', ''),
      bizId: data.biz_id!,
      uposUri: data.upos_uri!,
    };
  }

  /**
   * 获取 UploadId
   */
  private async getUploadId(
    endpoint: string,
    uposUri: string,
    auth: string
  ): Promise<string> {
    // 移除 upos:// 前缀
    const uposPath = uposUri.replace('upos://', '');
    // endpoint 不包含协议，需要添加 https://
    const url = `https://${endpoint}/${uposPath}?uploads&output=json`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Upos-Auth': auth,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get uploadId: HTTP ${response.status}`);
    }

    const data = (await response.json()) as { upload_id?: string };
    if (!data.upload_id) {
      throw new Error('No upload_id in response');
    }

    return data.upload_id;
  }

  /**
   * 上传分片
   */
  private async uploadChunk(
    endpoint: string,
    uposUri: string,
    uploadId: string,
    chunkIndex: number,
    totalChunks: number,
    totalSize: number,
    start: number,
    end: number,
    chunkData: Buffer,
    auth: string
  ): Promise<string> {
    // 移除 upos:// 前缀
    const uposPath = uposUri.replace('upos://', '');
    const params = new URLSearchParams({
      uploadId: uploadId,
      chunks: totalChunks.toString(),
      total: totalSize.toString(),
      chunk: chunkIndex.toString(),
      size: chunkData.length.toString(),
      partNumber: (chunkIndex + 1).toString(),
      start: start.toString(),
      end: end.toString(),
    });

    const url = `https://${endpoint}/${uposPath}?${params.toString()}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'X-Upos-Auth': auth,
        'Content-Type': 'application/octet-stream',
        'Content-Length': chunkData.length.toString(),
      },
      body: chunkData as unknown as BodyInit,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload chunk: HTTP ${response.status}`);
    }

    const eTag = response.headers.get('ETag') || '';
    return eTag.replace(/"/g, '');
  }

  /**
   * 合并分片
   */
  private async mergeChunks(
    endpoint: string,
    uposUri: string,
    uploadId: string,
    bizId: number,
    filename: string,
    parts: UploadPartInfo[],
    auth: string
  ): Promise<void> {
    // 移除 upos:// 前缀
    const uposPath = uposUri.replace('upos://', '');
    const params = new URLSearchParams({
      name: filename,
      uploadId: uploadId,
      biz_id: bizId.toString(),
      output: 'json',
      profile: 'ugcupos/bup',
    });

    const url = `https://${endpoint}/${uposPath}?${params.toString()}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Upos-Auth': auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parts }),
    });

    if (!response.ok) {
      throw new Error(`Failed to merge chunks: HTTP ${response.status}`);
    }

    const data = (await response.json()) as { OK?: number; message?: string };
    if (data.OK !== 1) {
      throw new Error(`Merge failed: ${data.message || 'Unknown error'}`);
    }
  }

  /**
   * 从 S3 下载封面并上传到 B 站
   */
  private async uploadCoverFromS3(
    s3Key: string,
    cookies: Record<string, string>
  ): Promise<string> {
    // 从 S3 下载封面
    const imageBuffer = await this.storageService.download(s3Key);
    return this.uploadCover(
      imageBuffer,
      cookies,
      this.inferCoverMimeType(s3Key)
    );
  }

  private async uploadCoverFromDataUrl(
    dataUrl: string,
    cookies: Record<string, string>
  ): Promise<string> {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) {
      throw new Error('Invalid cover data URL');
    }
    return this.uploadCover(Buffer.from(match[2], 'base64'), cookies, match[1]);
  }

  /**
   * 上传封面到 B 站
   */
  private async uploadCover(
    imageBuffer: Buffer,
    cookies: Record<string, string>,
    mimeType = 'image/jpeg'
  ): Promise<string> {
    const base64 = imageBuffer.toString('base64');
    const params = new URLSearchParams({
      cover: `data:${mimeType};base64,${base64}`,
      csrf: cookies['bili_jct'],
    });

    const url = `https://member.bilibili.com/x/vu/web/cover/up?ts=${Date.now()}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://member.bilibili.com',
        Referer: 'https://member.bilibili.com/platform/upload/video/frame',
        Cookie: Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Failed to upload cover: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      code?: number;
      message?: string;
      data?: { url?: string };
    };
    if (data.code !== 0) {
      throw new Error(`Failed to upload cover: ${data.message}`);
    }

    return data.data?.url || '';
  }

  private inferCoverMimeType(s3Key: string): string {
    const lowerKey = s3Key.toLowerCase();
    if (lowerKey.endsWith('.png')) {
      return 'image/png';
    }
    if (lowerKey.endsWith('.webp')) {
      return 'image/webp';
    }
    return 'image/jpeg';
  }

  private async resolveCoverForSubmission(
    coverSource: string | undefined,
    cookies: Record<string, string>
  ): Promise<string> {
    if (!coverSource) {
      return '';
    }

    if (this.isBilibiliCoverUrl(coverSource)) {
      return this.normalizeBilibiliCoverUrl(coverSource);
    }

    if (this.isDataUrl(coverSource)) {
      try {
        const uploadedCoverUrl = await this.uploadCoverFromDataUrl(
          coverSource,
          cookies
        );
        return this.normalizeBilibiliCoverUrl(uploadedCoverUrl);
      } catch (error) {
        this.logger.warn(
          'Failed to upload data URL cover to bilibili, submitting without cover',
          {
            error: error instanceof Error ? error.message : String(error),
          }
        );
        return '';
      }
    }

    if (this.isExternalUrl(coverSource)) {
      this.logger.warn('Skipping external cover URL for bilibili submission', {
        coverSource,
      });
      return '';
    }

    try {
      const uploadedCoverUrl = await this.uploadCoverFromS3(
        coverSource,
        cookies
      );
      return this.normalizeBilibiliCoverUrl(uploadedCoverUrl);
    } catch (error) {
      this.logger.warn(
        'Failed to upload cover to bilibili, submitting without cover',
        {
          coverSource,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return '';
    }
  }

  async resolveCoverForCreative(coverSource?: string): Promise<string> {
    const credential = await this.credentialRepository.findValid();
    if (!credential) {
      throw new Error('Bilibili not authenticated. Please login first.');
    }
    if (new Date() >= credential.expiresAt) {
      throw new Error('Bilibili credential expired. Please login again.');
    }
    return this.resolveCoverForSubmission(
      coverSource,
      credential.cookies as Record<string, string>
    );
  }

  private isBilibiliCoverUrl(coverUrl: string): boolean {
    if (!coverUrl) {
      return false;
    }

    const normalizedUrl = coverUrl.startsWith('//')
      ? `https:${coverUrl}`
      : coverUrl;

    try {
      const hostname = new URL(normalizedUrl).hostname.toLowerCase();
      return hostname.endsWith('biliimg.com') || hostname.endsWith('hdslb.com');
    } catch {
      return false;
    }
  }

  private isExternalUrl(coverSource: string): boolean {
    return /^(https?:)?\/\//i.test(coverSource.trim());
  }

  private isDataUrl(coverSource: string): boolean {
    return /^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(
      coverSource.trim()
    );
  }

  private normalizeBilibiliCoverUrl(coverUrl: string): string {
    const normalizedUrl = coverUrl.trim();
    if (normalizedUrl.startsWith('http://')) {
      return normalizedUrl.replace(/^http:/, '');
    }
    return normalizedUrl;
  }

  /**
   * 提交视频稿件（公开方法）
   */
  async submitVideoParts(
    parts: BilibiliUploadedPart[],
    options: BilibiliUploadOptions,
    coverSource?: string
  ): Promise<BilibiliUploadResult> {
    const credential = await this.credentialRepository.findValid();
    if (!credential) {
      throw new Error('Bilibili not authenticated. Please login first.');
    }

    if (new Date() >= credential.expiresAt) {
      throw new Error('Bilibili credential expired. Please login again.');
    }

    const cookies = credential.cookies as Record<string, string>;
    const coverUrl = await this.resolveCoverForSubmission(
      coverSource ?? options.cover,
      cookies
    );

    return this.submitVideo(parts, options, coverUrl, credential);
  }

  /**
   * 编辑已投稿稿件的分 P 列表，用于追加分 P
   */
  async editVideoParts(
    avid: number,
    parts: BilibiliUploadedPart[],
    options: BilibiliUploadOptions,
    coverSource?: string
  ): Promise<BilibiliUploadResult> {
    const credential = await this.credentialRepository.findValid();
    if (!credential) {
      throw new Error('Bilibili not authenticated. Please login first.');
    }

    if (new Date() >= credential.expiresAt) {
      throw new Error('Bilibili credential expired. Please login again.');
    }

    const cookies = credential.cookies as Record<string, string>;
    const coverUrl = await this.resolveCoverForSubmission(
      coverSource ?? options.cover,
      cookies
    );

    return this.editVideo(avid, parts, options, coverUrl, credential);
  }

  /**
   * 提交视频稿件
   */
  private async submitVideo(
    parts: BilibiliUploadedPart[],
    options: BilibiliUploadOptions,
    coverUrl: string,
    credential: BilibiliCredential
  ): Promise<BilibiliUploadResult> {
    const cookies = credential.cookies as Record<string, string>;
    const tid = await this.resolvePredictedLegacyTid(
      cookies,
      parts[0]?.filename || '',
      options.title,
      options.tid
    );
    const humanType2 = options.humanType2 || DEFAULT_BILIBILI_HUMAN_TYPE2;

    const studio = this.buildStudio(parts, options, coverUrl, tid, humanType2);

    const url = new URL('https://member.bilibili.com/x/vu/web/add/v3');
    url.searchParams.set('ts', String(Date.now()));
    url.searchParams.set('csrf', cookies.bili_jct || '');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.buildBrowserHeaders(cookies),
      },
      body: JSON.stringify(studio),
    });

    if (!response.ok) {
      throw new Error(`Failed to submit video: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      code?: number;
      message?: string;
      data?: { bvid?: string; aid?: number };
    };
    this.logger.info('Submit video response', {
      code: data.code,
      message: data.message,
    });

    if (data.code !== 0) {
      throw new Error(`Failed to submit video: ${data.message}`);
    }

    return {
      bvid: data.data?.bvid || '',
      avid: data.data?.aid || 0,
    };
  }

  /**
   * 编辑视频稿件
   */
  private async editVideo(
    avid: number,
    parts: BilibiliUploadedPart[],
    options: BilibiliUploadOptions,
    coverUrl: string,
    credential: BilibiliCredential
  ): Promise<BilibiliUploadResult> {
    const cookies = credential.cookies as Record<string, string>;
    const tid = await this.resolvePredictedLegacyTid(
      cookies,
      parts[0]?.filename || '',
      options.title,
      options.tid
    );
    const humanType2 = options.humanType2 || DEFAULT_BILIBILI_HUMAN_TYPE2;
    const studio = {
      ...this.buildStudio(parts, options, coverUrl, tid, humanType2),
      aid: Number(avid),
    };

    const url = new URL('https://member.bilibili.com/x/vu/web/edit');
    url.searchParams.set('t', String(Date.now()));
    url.searchParams.set('csrf', cookies.bili_jct || '');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.buildBrowserHeaders(cookies),
      },
      body: JSON.stringify(studio),
    });

    if (!response.ok) {
      throw new Error(`Failed to edit video: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      code?: number;
      message?: string;
      data?: { bvid?: string; aid?: number };
    };
    this.logger.info('Edit video response', {
      code: data.code,
      message: data.message,
    });

    if (data.code !== 0) {
      throw new Error(`Failed to edit video: ${data.message}`);
    }

    return {
      bvid: data.data?.bvid || '',
      avid: data.data?.aid || Number(avid),
    };
  }

  private buildStudio(
    parts: BilibiliUploadedPart[],
    options: BilibiliUploadOptions,
    coverUrl: string,
    tid: number,
    humanType2: number
  ) {
    return {
      copyright: options.copyright || 2,
      source: options.source || '',
      tid,
      human_type2: humanType2,
      cover: coverUrl,
      title: options.title,
      desc_format_id: 9999,
      desc: options.description || '',
      desc_v2: [],
      dynamic: options.dynamic || '',
      subtitle: { open: 0, lan: '' },
      tag: (options.tags || []).join(','),
      videos: parts.map(p => ({
        title: p.title,
        filename: p.filename,
        cid: p.cid,
        desc: '',
      })),
      dtime: 0,
      open_subtitle: false,
      interactive: 0,
      recreate: -1,
      act_reserve_create: 0,
      dolby: 0,
      lossless_music: 0,
      no_reprint: options.noReprint || 0,
      no_disturbance: options.dynamic ? 1 : 0,
      is_only_self: 0,
      charging_pay: 0,
      up_selection_reply: false,
      up_close_reply: false,
      up_close_danmu: false,
      web_os: 3,
      is_360: -1,
    };
  }

  private async resolvePredictedLegacyTid(
    cookies: Record<string, string>,
    filename: string,
    title: string,
    fallbackTid?: number
  ): Promise<number> {
    const url = new URL(
      'https://member.bilibili.com/x/vupre/web/archive/types/predict'
    );
    url.searchParams.set('ts', String(Date.now()));
    url.searchParams.set('csrf', cookies.bili_jct || '');

    const form = new FormData();
    form.set('filename', filename);
    form.set('title', title);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildBrowserHeaders(cookies),
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Failed to predict bilibili partition: ${response.status}`);
    }

    const result = (await response.json()) as {
      code?: number;
      message?: string;
      data?: BilibiliPredictedPartition[];
    };

    if (result.code !== 0) {
      throw new Error(
        `Failed to predict bilibili partition: ${
          result.message || result.code
        }`
      );
    }

    const predictedTid = result.data?.find(item => item.show !== false)?.id;
    if (predictedTid && Number.isInteger(predictedTid) && predictedTid > 0) {
      return predictedTid;
    }

    if (fallbackTid && Number.isInteger(fallbackTid) && fallbackTid > 0) {
      return fallbackTid;
    }

    throw new Error('Bilibili partition prediction returned no usable tid');
  }

  private buildBrowserHeaders(
    cookies: Record<string, string>
  ): Record<string, string> {
    return {
      Cookie: this.buildCookieHeader(cookies),
      Origin: 'https://member.bilibili.com',
      Referer: 'https://member.bilibili.com/platform/upload/video/frame',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    };
  }

  private buildCookieHeader(cookies: Record<string, string>): string {
    return Object.entries(cookies)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }
}
