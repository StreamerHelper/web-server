import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Config,
  Init,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
  ILogger,
} from '@midwayjs/core';
import { Readable } from 'stream';
import { StorageError } from '../interface';

/**
 * 从 S3 错误中提取详细信息
 */
function getS3ErrorMessage(error: unknown): string {
  if (error instanceof S3ServiceException) {
    return `[${error.name}] ${error.message} (Code: ${error.$fault}, StatusCode: ${error.$metadata?.httpStatusCode})`;
  }
  if (error instanceof Error) {
    // AWS SDK 错误可能有额外属性
    const awsError = error as any;
    if (awsError.Code || awsError.$metadata) {
      return `[${awsError.Code || awsError.name}] ${
        awsError.message || 'Unknown error'
      } (StatusCode: ${awsError.$metadata?.httpStatusCode})`;
    }
    return error.message || error.toString();
  }
  return String(error);
}

@Provide()
@Scope(ScopeEnum.Singleton)
export class StorageService {
  @Config('streamerhelper.s3')
  s3Config: any;

  @Logger()
  private logger: ILogger;

  /** 内部客户端：用于上传、下载、删除等操作 (endpoint: minio:9000) */
  private client: S3Client;

  /** 公开客户端：用于生成浏览器可访问的签名 URL (publicEndpoint: localhost:9000) */
  private publicClient: S3Client;

  @Init()
  async init() {
    const { endpoint, publicEndpoint, region, credentials, forcePathStyle } =
      this.s3Config;

    this.logger.info('Initializing S3 clients', {
      endpoint,
      publicEndpoint,
      bucket: this.s3Config.bucket,
    });

    // 内部客户端：用于服务端操作（容器内网络）
    this.client = new S3Client({
      endpoint,
      region,
      credentials,
      forcePathStyle: forcePathStyle ?? true,
    });

    // 公开客户端：用于生成浏览器可访问的 URL
    this.publicClient = new S3Client({
      endpoint: publicEndpoint,
      region,
      credentials,
      forcePathStyle: forcePathStyle ?? true,
    });

    await this.ensureBucketExists();
  }

  /**
   * 上传文件
   */
  async upload(
    key: string,
    body: Buffer,
    contentType?: string
  ): Promise<string> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.s3Config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      });
      await this.client.send(command);
      return key;
    } catch (error) {
      const errorMsg = getS3ErrorMessage(error);
      console.error(`[Storage] Upload failed for ${key}:`, errorMsg);
      throw new StorageError(
        `Failed to upload ${key}: ${errorMsg}`,
        'upload',
        true
      );
    }
  }

  /**
   * 上传流
   */
  async uploadStream(
    key: string,
    stream: Readable,
    contentType?: string
  ): Promise<string> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.s3Config.bucket,
        Key: key,
        Body: stream,
        ContentType: contentType,
      });
      await this.client.send(command);
      return key;
    } catch (error) {
      const errorMsg = getS3ErrorMessage(error);
      console.error(`[Storage] Upload stream failed for ${key}:`, errorMsg);
      throw new StorageError(
        `Failed to upload stream ${key}: ${errorMsg}`,
        'uploadStream',
        true
      );
    }
  }

  /**
   * 下载文件
   */
  async download(key: string): Promise<Buffer> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.s3Config.bucket,
        Key: key,
      });
      const response = await this.client.send(command);

      if (!response.Body) {
        throw new StorageError(
          `Empty response body for ${key}`,
          'download',
          false
        );
      }

      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const errorMsg = getS3ErrorMessage(error);
      throw new StorageError(
        `Failed to download ${key}: ${errorMsg}`,
        'download',
        true
      );
    }
  }

  /**
   * 获取对象流，用于代理给浏览器下载/播放
   */
  async getObjectStream(
    key: string,
    range?: string
  ): Promise<{
    body: Readable;
    contentType?: string;
    contentLength?: number;
    contentRange?: string;
    acceptRanges?: string;
    etag?: string;
    lastModified?: Date;
  }> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.s3Config.bucket,
        Key: key,
        ...(range ? { Range: range } : {}),
      });
      const response = await this.client.send(command);

      if (!response.Body) {
        throw new StorageError(
          `Empty response body for ${key}`,
          'getObjectStream',
          false
        );
      }

      return {
        body: response.Body as Readable,
        contentType: response.ContentType,
        contentLength: response.ContentLength,
        contentRange: response.ContentRange,
        acceptRanges: response.AcceptRanges,
        etag: response.ETag,
        lastModified: response.LastModified,
      };
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      const errorMsg = getS3ErrorMessage(error);
      throw new StorageError(
        `Failed to stream ${key}: ${errorMsg}`,
        'getObjectStream',
        true
      );
    }
  }

  /**
   * 获取下载 URL（使用 publicClient 生成浏览器可访问的 URL）
   */
  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.s3Config.bucket,
        Key: key,
      });
      // 使用 publicClient 生成 URL，确保浏览器可以访问
      return await getSignedUrl(this.publicClient, command, { expiresIn });
    } catch (error) {
      const errorMsg = getS3ErrorMessage(error);
      throw new StorageError(
        `Failed to get signed URL for ${key}: ${errorMsg}`,
        'getSignedUrl',
        false
      );
    }
  }

  /**
   * 删除文件
   */
  async delete(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.s3Config.bucket,
        Key: key,
      });
      await this.client.send(command);
    } catch (error) {
      const errorMsg = getS3ErrorMessage(error);
      throw new StorageError(
        `Failed to delete ${key}: ${errorMsg}`,
        'delete',
        true
      );
    }
  }

  /**
   * 删除多个文件
   */
  async deleteMultiple(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => this.delete(key)));
  }

  /**
   * 列出文件
   */
  async list(prefix: string): Promise<string[]> {
    try {
      const keys: string[] = [];
      let continuationToken: string | undefined;

      do {
        const command = new ListObjectsV2Command({
          Bucket: this.s3Config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });
        const response = await this.client.send(command);
        keys.push(
          ...(response.Contents?.map(obj => obj.Key!).filter(Boolean) || [])
        );
        continuationToken = response.IsTruncated
          ? response.NextContinuationToken
          : undefined;
      } while (continuationToken);

      return keys;
    } catch (error) {
      const errorMsg = getS3ErrorMessage(error);
      throw new StorageError(
        `Failed to list ${prefix}: ${errorMsg}`,
        'list',
        true
      );
    }
  }

  /**
   * 获取完整 S3 路径（使用 publicEndpoint，供浏览器访问）
   */
  getS3Path(key: string): string {
    const publicEndpoint = this.s3Config.publicEndpoint.replace(/\/$/, '');
    return `${publicEndpoint}/${this.s3Config.bucket}/${key}`;
  }

  private async ensureBucketExists(): Promise<void> {
    try {
      await this.client.send(
        new HeadBucketCommand({
          Bucket: this.s3Config.bucket,
        })
      );
    } catch (error) {
      const awsError = error as any;
      const code = awsError?.Code || awsError?.name;
      const statusCode = awsError?.$metadata?.httpStatusCode;

      if (
        statusCode === 404 ||
        code === 'NotFound' ||
        code === 'NoSuchBucket'
      ) {
        this.logger.warn('S3 bucket not found, creating automatically', {
          bucket: this.s3Config.bucket,
        });
        await this.client.send(
          new CreateBucketCommand({
            Bucket: this.s3Config.bucket,
          })
        );
        this.logger.info('S3 bucket created', {
          bucket: this.s3Config.bucket,
        });
        return;
      }

      const errorMsg = getS3ErrorMessage(error);
      throw new StorageError(
        `Failed to verify bucket ${this.s3Config.bucket}: ${errorMsg}`,
        'init',
        true
      );
    }
  }
}
