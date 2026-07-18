import {
  Config,
  ILogger,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import * as http from 'http';
import * as https from 'https';
import { promises as fs } from 'fs';
import { join } from 'path';
import { TranscriptMessage } from '../interface/data';
import { transcribeFileForStreamerHelper } from './asr-transcriber';

interface AsrConfig {
  enabled: boolean;
  provider: 'aliyun';
  apiKey: string;
  apiKeyEnv: string;
  baseUrl: string;
  model: string;
  language: string;
  chunkSeconds: number;
  concurrency: number;
  transcribeRecordings: boolean;
}

/**
 * ASR 服务选项
 */
export interface AsrServiceOptions {
  id: string; // Job ID
  outputDir: string; // 输出目录
  language?: string; // 语言代码（默认 zh-CN）
  enableSpeakerDiarization?: boolean; // 是否启用说话人分离
  enablePunctuation?: boolean; // 是否启用标点符号
  enableInterimResults?: boolean; // 是否启用临时结果
}

/**
 * ASR 识别结果
 */
export interface AsrResult {
  jobId: string;
  segmentId: string;
  messages: TranscriptMessage[];
  duration: number; // 有效语音时长（毫秒）
  wordCount: number;
  language: string;
}

export interface AsrAvailableModel {
  id: string;
  object?: string;
  created?: number;
  ownedBy?: string;
}

export interface AsrModelsResponse {
  models: AsrAvailableModel[];
  fetchedAt: number;
  source: string;
  error?: string;
}

/**
 * ASR 服务
 *
 * 当前实现复用 v2t 的音频切片和阿里云百炼 qwen3-asr-flash
 * 识别逻辑。输出保持 TranscriptMessage JSONL 结构，供现有
 * transcript-upload/text 查询链路复用。
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class AsrService {
  @Logger()
  private logger: ILogger;

  @Config('streamerhelper.asr')
  private injectedConfig: AsrConfig;

  private runtimeConfig?: AsrConfig;

  /**
   * 转录音视频文件
   *
   * @param audioPath 音视频文件路径
   * @param options ASR 选项
   * @returns 转录结果
   */
  async transcribeFile(
    audioPath: string,
    options: AsrServiceOptions
  ): Promise<AsrResult> {
    if (!this.isAvailable()) {
      throw new Error('ASR service is not available');
    }

    const config = this.getConfig();
    const language = options.language || config.language;

    this.logger.info('Starting ASR transcription', {
      audioPath,
      jobId: options.id,
      provider: config.provider,
      model: config.model,
      language,
      chunkSeconds: config.chunkSeconds,
      concurrency: config.concurrency,
    });

    const result = await transcribeFileForStreamerHelper(
      audioPath,
      {
        id: options.id,
        outputDir: options.outputDir,
        language,
        enableSpeakerDiarization: options.enableSpeakerDiarization,
        enablePunctuation: options.enablePunctuation,
        enableInterimResults: options.enableInterimResults,
        chunkSeconds: config.chunkSeconds,
        concurrency: config.concurrency,
      },
      {
        apiKey: this.resolveApiKey(true),
        baseUrl: config.baseUrl,
        model: config.model,
        language,
      }
    );

    this.logger.info('ASR transcription completed', {
      audioPath,
      jobId: result.jobId,
      segmentId: result.segmentId,
      messageCount: result.messages.length,
      duration: result.duration,
      wordCount: result.wordCount,
    });

    return result as AsrResult;
  }

  /**
   * 实时转录音频流（占位）
   *
   * @param audioStream 音频流
   * @param options ASR 选项
   * @returns AsyncIterator<TranscriptMessage>
   */
  async *transcribeStream(
    audioStream: NodeJS.ReadableStream,
    options: AsrServiceOptions
  ): AsyncGenerator<TranscriptMessage, void, undefined> {
    this.logger.warn('ASR stream transcription is not implemented yet', {
      options,
    });

    // TODO: 实现实际的流式 ASR
    // 1. 建立WebSocket连接到ASR服务
    // 2. 发送音频数据
    // 3. 接收并yield转录结果
    yield* [];
    // 占位：不产生任何结果
    return;
  }

  /**
   * 保存转录结果到本地文件
   *
   * @param result 转录结果
   * @param outputPath 输出文件路径（JSONL 格式）
   */
  async saveToFile(result: AsrResult, outputPath: string): Promise<void> {
    const dir = join(outputPath, '..');
    await fs.mkdir(dir, { recursive: true });

    const jsonl =
      result.messages.map(msg => JSON.stringify(msg)).join('\n') + '\n';

    await fs.writeFile(outputPath, jsonl, 'utf-8');

    this.logger.info('Transcript saved to file', {
      jobId: result.jobId,
      segmentId: result.segmentId,
      messageCount: result.messages.length,
      outputPath,
    });
  }

  /**
   * 从本地文件加载转录结果
   *
   * @param inputPath 输入文件路径（JSONL 格式）
   * @returns 转录结果
   */
  async loadFromFile(inputPath: string): Promise<TranscriptMessage[]> {
    const content = await fs.readFile(inputPath, 'utf-8');
    const lines = content.trim().split('\n');

    return lines
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as TranscriptMessage);
  }

  /**
   * 检查服务是否可用
   */
  isAvailable(): boolean {
    const config = this.getConfig();
    return (
      config.enabled &&
      config.provider === 'aliyun' &&
      Boolean(this.resolveApiKey(false))
    );
  }

  /**
   * 获取支持的语言列表
   */
  getSupportedLanguages(): string[] {
    // TODO: 返回实际支持的语言列表
    return ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'];
  }

  async listAvailableModels(): Promise<AsrModelsResponse> {
    const config = this.getConfig();
    const source = this.buildModelsEndpoint(config.baseUrl);
    const fetchedAt = Date.now();
    const apiKey = this.resolveApiKey(false);

    if (!apiKey) {
      return {
        models: [],
        fetchedAt,
        source,
        error: `Missing ASR API key. Set streamerhelper.asr.apiKey or ${config.apiKeyEnv}.`,
      };
    }

    try {
      const payload = await this.getJson<Record<string, unknown>>(
        source,
        apiKey,
        15_000
      );
      const rawModels = Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload.models)
        ? payload.models
        : [];
      const models = this.normalizeModelList(rawModels);

      if (models.length === 0) {
        return {
          models,
          fetchedAt,
          source,
          error: 'Aliyun model list response did not contain any models.',
        };
      }

      return {
        models,
        fetchedAt,
        source,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Failed to fetch Aliyun ASR model list', {
        source,
        error: message,
      });
      return {
        models: [],
        fetchedAt,
        source,
        error: message,
      };
    }
  }

  /**
   * 获取支持的特性
   */
  getSupportedFeatures(): {
    speakerDiarization: boolean;
    punctuation: boolean;
    interimResults: boolean;
    streaming: boolean;
  } {
    return {
      speakerDiarization: false,
      punctuation: true,
      interimResults: false,
      streaming: false,
    };
  }

  getPublicStatus(): Omit<AsrConfig, 'apiKey'> & {
    available: boolean;
    apiKeySet: boolean;
    apiKeyMasked: string;
  } {
    const config = this.getConfig();
    const apiKey = this.resolveApiKey(false) || '';

    return {
      enabled: config.enabled,
      provider: config.provider,
      apiKeyEnv: config.apiKeyEnv,
      baseUrl: config.baseUrl,
      model: config.model,
      language: config.language,
      chunkSeconds: config.chunkSeconds,
      concurrency: config.concurrency,
      transcribeRecordings: config.transcribeRecordings,
      available: this.isAvailable(),
      apiKeySet: Boolean(apiKey),
      apiKeyMasked: this.maskApiKey(apiKey),
    };
  }

  updateConfig(patch: Partial<AsrConfig>): void {
    this.runtimeConfig = {
      ...this.getConfig(),
      ...patch,
    };
  }

  private getConfig(): AsrConfig {
    return (
      this.runtimeConfig ||
      this.injectedConfig || {
        enabled: true,
        provider: 'aliyun',
        apiKey: '',
        apiKeyEnv: 'DASHSCOPE_API_KEY',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-asr-flash',
        language: 'zh-CN',
        chunkSeconds: 240,
        concurrency: 1,
        transcribeRecordings: true,
      }
    );
  }

  private resolveApiKey(throwOnMissing: true): string;
  private resolveApiKey(throwOnMissing: false): string | undefined;
  private resolveApiKey(throwOnMissing: boolean): string | undefined {
    const config = this.getConfig();
    const apiKey = config.apiKey || process.env[config.apiKeyEnv];

    if (!apiKey && throwOnMissing) {
      throw new Error(
        `Missing ASR API key. Set streamerhelper.asr.apiKey or ${config.apiKeyEnv}.`
      );
    }

    return apiKey;
  }

  private maskApiKey(apiKey: string): string {
    if (!apiKey) {
      return '';
    }
    if (apiKey.length <= 8) {
      return '********';
    }
    return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
  }

  private buildModelsEndpoint(baseUrl: string): string {
    const normalizedBaseUrl = (
      baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    ).replace(/\/+$/, '');
    return `${normalizedBaseUrl}/models`;
  }

  private normalizeModelList(items: unknown[]): AsrAvailableModel[] {
    const models = new Map<string, AsrAvailableModel>();

    for (const item of items) {
      const model = this.normalizeModelItem(item);
      if (model) {
        models.set(model.id, model);
      }
    }

    return Array.from(models.values()).sort((left, right) => {
      const priorityDiff =
        this.getModelPriority(left.id) - this.getModelPriority(right.id);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return left.id.localeCompare(right.id);
    });
  }

  private normalizeModelItem(item: unknown): AsrAvailableModel | undefined {
    if (typeof item === 'string') {
      return { id: item };
    }

    if (!item || typeof item !== 'object') {
      return undefined;
    }

    const record = item as Record<string, unknown>;
    const id =
      typeof record.id === 'string'
        ? record.id
        : typeof record.model === 'string'
        ? record.model
        : '';

    if (!id) {
      return undefined;
    }

    return {
      id,
      object: typeof record.object === 'string' ? record.object : undefined,
      created: typeof record.created === 'number' ? record.created : undefined,
      ownedBy:
        typeof record.owned_by === 'string'
          ? record.owned_by
          : typeof record.ownedBy === 'string'
          ? record.ownedBy
          : undefined,
    };
  }

  private getModelPriority(id: string): number {
    const value = id.toLowerCase();
    if (value.includes('asr')) {
      return 0;
    }
    if (value.includes('audio') || value.includes('paraformer')) {
      return 1;
    }
    return 2;
  }

  private getJson<T>(
    urlString: string,
    apiKey: string,
    timeoutMs: number
  ): Promise<T> {
    const url = new URL(urlString);
    const transport =
      url.protocol === 'http:'
        ? http
        : url.protocol === 'https:'
        ? https
        : undefined;

    if (!transport) {
      throw new Error(`Unsupported ASR model list protocol: ${url.protocol}`);
    }

    return new Promise((resolve, reject) => {
      const request = transport.request(
        {
          method: 'GET',
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
          timeout: timeoutMs,
        },
        response => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', chunk => {
            data += chunk;
          });
          response.on('end', () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = { message: data };
            }

            if (
              response.statusCode &&
              response.statusCode >= 200 &&
              response.statusCode < 300
            ) {
              resolve(parsed as T);
              return;
            }

            const record =
              parsed && typeof parsed === 'object'
                ? (parsed as Record<string, unknown>)
                : {};
            reject(
              new Error(
                `Aliyun model list HTTP ${response.statusCode}: ${
                  record.code || ''
                } ${record.message || data}`.trim()
              )
            );
          });
        }
      );

      request.on('timeout', () => {
        request.destroy(new Error('Aliyun model list request timed out'));
      });
      request.on('error', reject);
      request.end();
    });
  }
}
