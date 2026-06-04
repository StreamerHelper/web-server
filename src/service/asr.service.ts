import {
  Config,
  ILogger,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
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
  private config: AsrConfig;

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
    this.config = {
      ...this.getConfig(),
      ...patch,
    };
  }

  private getConfig(): AsrConfig {
    return (
      this.config || {
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
}
