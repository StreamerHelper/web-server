import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { TranscriptMessage, TranscriptType } from '../interface/data';

interface RunCommandResult {
  stdout: string;
  stderr: string;
}

interface MediaProbe {
  durationMs: number;
  sizeBytes: number;
  hasAudio: boolean;
}

interface AudioChunk {
  index: number;
  path: string;
  startMs: number;
  durationMs: number;
  sizeBytes: number;
}

interface FFProbeOutput {
  streams?: Array<{
    codec_type?: string;
    duration?: string;
  }>;
  format?: {
    duration?: string;
    size?: string;
  };
}

interface CompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  code?: string;
  message?: string;
  request_id?: string;
}

export interface StreamerHelperAsrServiceOptions {
  id: string;
  outputDir?: string;
  language?: string;
  enableSpeakerDiarization?: boolean;
  enablePunctuation?: boolean;
  enableInterimResults?: boolean;
  chunkSeconds?: number;
  concurrency?: number;
}

export interface StreamerHelperAliyunOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  enableItn?: boolean;
}

export interface StreamerHelperAsrResult {
  jobId: string;
  segmentId: string;
  messages: TranscriptMessage[];
  duration: number;
  wordCount: number;
  language: string;
}

export async function transcribeFileForStreamerHelper(
  inputPath: string,
  options: StreamerHelperAsrServiceOptions,
  aliyun: StreamerHelperAliyunOptions
): Promise<StreamerHelperAsrResult> {
  const source = await resolveInputPath(inputPath);
  const media = await probeMedia(source);
  if (!media.hasAudio) {
    throw new Error(`Input has no audio stream: ${inputPath}`);
  }

  const tempRoot = await createTempDir(options.outputDir);
  const chunkDir = path.join(tempRoot, 'audio');

  try {
    const chunks = await extractAudioChunks(source, {
      outputDir: chunkDir,
      chunkSeconds: options.chunkSeconds ?? 240,
    });
    const client = new AliyunQwenAsrClient(aliyun);
    const language = options.language ?? aliyun.language ?? 'zh-CN';
    const concurrency = Math.max(1, options.concurrency ?? 1);

    const messages = await mapLimit(chunks, concurrency, async chunk =>
      client.transcribeChunk(chunk, {
        language,
        enableItn: aliyun.enableItn,
      })
    );
    const nonEmptyMessages = messages
      .filter(message => message.text.trim().length > 0)
      .sort((left, right) => left.timestamp - right.timestamp);
    const text = nonEmptyMessages.map(message => message.text).join('\n');
    const durationMs =
      chunks.reduce(
        (max, chunk) => Math.max(max, chunk.startMs + chunk.durationMs),
        0
      ) || media.durationMs;

    await fs.rm(tempRoot, { recursive: true, force: true });

    return {
      jobId: options.id,
      segmentId: path.basename(inputPath).replace(/\.[^/.]+$/, ''),
      messages: nonEmptyMessages,
      duration: durationMs,
      wordCount: countWords(text),
      language: normalizeTranscriptLanguage(language),
    };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

class AliyunQwenAsrClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: StreamerHelperAliyunOptions) {
    if (!options.apiKey) {
      throw new Error('Missing Aliyun DashScope API key');
    }

    this.apiKey = options.apiKey;
    this.baseUrl =
      options.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    this.model = options.model || 'qwen3-asr-flash';
  }

  async transcribeChunk(
    chunk: AudioChunk,
    options: { language?: string; enableItn?: boolean } = {}
  ): Promise<TranscriptMessage> {
    const dataUri = await fileToDataUri(chunk.path);
    if (Buffer.byteLength(dataUri, 'utf8') > 10 * 1024 * 1024) {
      throw new Error(
        `Audio chunk ${chunk.path} exceeds qwen3-asr-flash Data URL limit. Reduce ASR chunk seconds.`
      );
    }

    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: dataUri,
              },
            },
          ],
        },
      ],
      stream: false,
      asr_options: {
        enable_itn: options.enableItn ?? true,
      },
    };

    const asrOptions = payload.asr_options as Record<string, unknown>;
    if (options.language) {
      asrOptions.language = normalizeAliyunLanguage(options.language);
    }

    const response = await postJson<CompletionResponse>(
      `${this.baseUrl.replace(/\/$/, '')}/chat/completions`,
      payload,
      this.apiKey
    );
    const text = extractContentText(response);

    return {
      id: `asr-${String(chunk.index).padStart(5, '0')}`,
      timestamp: chunk.startMs,
      type: TranscriptType.FINAL,
      text,
      confidence: 1,
      language: normalizeTranscriptLanguage(options.language),
      raw: {
        provider: 'aliyun',
        model: this.model,
        chunkIndex: chunk.index,
        chunkStartMs: chunk.startMs,
        chunkDurationMs: chunk.durationMs,
        sizeBytes: chunk.sizeBytes,
      },
    };
  }
}

async function extractAudioChunks(
  input: string,
  options: {
    outputDir: string;
    chunkSeconds: number;
  }
): Promise<AudioChunk[]> {
  await fs.mkdir(options.outputDir, { recursive: true });
  const pattern = path.join(options.outputDir, 'chunk_%05d.mp3');
  const chunkSeconds = Math.max(30, options.chunkSeconds);

  await runCommand('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '32k',
    '-f',
    'segment',
    '-segment_time',
    String(chunkSeconds),
    '-reset_timestamps',
    '1',
    pattern,
  ]);

  const files = (await fs.readdir(options.outputDir))
    .filter(file => /^chunk_\d+\.mp3$/.test(file))
    .sort();
  if (files.length === 0) {
    throw new Error('ffmpeg did not create any audio chunks');
  }

  const chunks: AudioChunk[] = [];
  let cursorMs = 0;
  for (let index = 0; index < files.length; index += 1) {
    const filePath = path.join(options.outputDir, files[index]);
    const stat = await fs.stat(filePath);
    const probe = await probeMedia(filePath);
    const durationMs = probe.durationMs || chunkSeconds * 1000;
    chunks.push({
      index,
      path: filePath,
      startMs: cursorMs,
      durationMs,
      sizeBytes: stat.size,
    });
    cursorMs += durationMs;
  }

  return chunks;
}

async function probeMedia(input: string): Promise<MediaProbe> {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    input,
  ]);

  const data = JSON.parse(stdout) as FFProbeOutput;
  const streams = data.streams || [];
  return {
    durationMs: secondsToMs(data.format?.duration),
    sizeBytes: Number(data.format?.size || 0),
    hasAudio: streams.some(stream => stream.codec_type === 'audio'),
  };
}

async function resolveInputPath(input: string): Promise<string> {
  const direct = path.resolve(input);
  try {
    await fs.access(direct);
    return direct;
  } catch {
    throw new Error(`Input path does not exist: ${input}`);
  }
}

async function createTempDir(parent?: string): Promise<string> {
  if (parent) {
    await fs.mkdir(parent, { recursive: true });
    return await fs.mkdtemp(path.join(parent, 'asr-'));
  }
  return await fs.mkdtemp(path.join(os.tmpdir(), 'asr-'));
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; maxBufferBytes?: number } = {}
): Promise<RunCommandResult> {
  const maxBufferBytes = options.maxBufferBytes ?? 2_000_000;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const pushLimited = (chunks: Buffer[], chunk: Buffer, current: number) => {
      if (current < maxBufferBytes) {
        chunks.push(chunk);
      }
      return current + chunk.length;
    };

    child.stdout?.on('data', chunk => {
      stdoutBytes = pushLimited(stdoutChunks, chunk, stdoutBytes);
    });
    child.stderr?.on('data', chunk => {
      stderrBytes = pushLimited(stderrChunks, chunk, stderrBytes);
    });
    child.on('error', reject);
    child.on('close', code => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} exited with code ${code}${stderr ? `: ${stderr}` : ''}`
        )
      );
    });
  });
}

async function fileToDataUri(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return `data:${audioMimeFromExt(filePath)};base64,${bytes.toString(
    'base64'
  )}`;
}

function audioMimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.wav') {
    return 'audio/wav';
  }
  if (ext === '.m4a' || ext === '.mp4') {
    return 'audio/mp4';
  }
  if (ext === '.ogg' || ext === '.opus') {
    return 'audio/ogg';
  }
  return 'audio/mpeg';
}

function extractContentText(response: CompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          if (typeof record.text === 'string') {
            return record.text;
          }
          if (typeof record.content === 'string') {
            return record.content;
          }
        }
        return '';
      })
      .join('')
      .trim();
  }

  if (response.code || response.message) {
    throw new Error(
      `Aliyun ASR returned no transcript: ${response.code || ''} ${
        response.message || ''
      } request_id=${response.request_id || ''}`.trim()
    );
  }

  throw new Error('Aliyun ASR returned an unexpected response shape');
}

function postJson<T>(
  urlString: string,
  payload: unknown,
  apiKey: string
): Promise<T> {
  const url = new URL(urlString);
  const body = JSON.stringify(payload);
  const transport = url.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 120_000,
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
              `Aliyun ASR HTTP ${response.statusCode}: ${record.code || ''} ${
                record.message || data
              }`.trim()
            )
          );
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error('Aliyun ASR request timed out'));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current], current);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

function countWords(text: string): number {
  const latinTokens = text.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g) || [];
  const cjkChars = text.match(/[\u3400-\u9fff]/g) || [];
  return latinTokens.length + cjkChars.length;
}

function secondsToMs(value?: string): number {
  if (!value) {
    return 0;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return 0;
  }
  return Math.round(seconds * 1000);
}

function normalizeAliyunLanguage(language: string): string {
  const value = language.toLowerCase();
  if (value === 'zh-cn' || value === 'zh') {
    return 'zh';
  }
  if (value === 'zh-yue' || value === 'yue') {
    return 'yue';
  }
  if (value.startsWith('en')) {
    return 'en';
  }
  if (value.startsWith('ja')) {
    return 'ja';
  }
  return value;
}

function normalizeTranscriptLanguage(language?: string): string {
  if (!language) {
    return 'zh-CN';
  }
  const value = language.toLowerCase();
  if (value === 'zh' || value === 'zh-cn') {
    return 'zh-CN';
  }
  if (value === 'yue' || value === 'zh-yue') {
    return 'zh-yue';
  }
  if (value === 'en') {
    return 'en-US';
  }
  if (value === 'ja') {
    return 'ja-JP';
  }
  return language;
}
