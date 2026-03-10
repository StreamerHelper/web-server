import {
    DeleteObjectCommand,
    GetObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Config, Init, Provide, Scope, ScopeEnum } from '@midwayjs/core';
import { Readable } from 'stream';
import { StorageError } from '../interface';

@Provide()
@Scope(ScopeEnum.Request, { allowDowngrade: true })
export class StorageService {
  @Config('streamerhelper.s3')
  s3Config: any;

  private client: S3Client;

  @Init()
  async init() {
    this.client = new S3Client({
      endpoint: this.s3Config.endpoint,
      region: this.s3Config.region,
      credentials: this.s3Config.credentials,
      forcePathStyle: this.s3Config.forcePathStyle ?? true,
    });
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
      throw new StorageError(
        `Failed to upload ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
      throw new StorageError(
        `Failed to upload stream ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
      throw new StorageError(
        `Failed to download ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'download',
        true
      );
    }
  }

  /**
   * 获取下载 URL
   */
  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.s3Config.bucket,
        Key: key,
      });
      return await getSignedUrl(this.client, command, { expiresIn });
    } catch (error) {
      throw new StorageError(
        `Failed to get signed URL for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
      throw new StorageError(
        `Failed to delete ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
      const command = new ListObjectsV2Command({
        Bucket: this.s3Config.bucket,
        Prefix: prefix,
      });
      const response = await this.client.send(command);
      return response.Contents?.map(obj => obj.Key!) || [];
    } catch (error) {
      throw new StorageError(
        `Failed to list ${prefix}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'list',
        true
      );
    }
  }

  /**
   * 获取完整 S3 路径
   */
  getS3Path(key: string): string {
    const endpoint = this.s3Config.endpoint.replace(/\/$/, '');
    return `${endpoint}/${this.s3Config.bucket}/${key}`;
  }
}
