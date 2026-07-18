import { AsrService } from '../../src/service/asr.service';

describe('AsrService model discovery', () => {
  const createService = () => {
    const service = new AsrService() as any;
    service.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    service.injectedConfig = {
      enabled: true,
      provider: 'aliyun',
      apiKey: 'test-key',
      apiKeyEnv: 'TEST_DASHSCOPE_API_KEY',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
      model: 'qwen3-asr-flash',
      language: 'zh-CN',
      chunkSeconds: 240,
      concurrency: 1,
      transcribeRecordings: true,
    };
    service.getJson = jest.fn();
    return service;
  };

  it('normalizes, deduplicates and prioritizes available models', async () => {
    const service = createService();
    service.getJson.mockResolvedValue({
      data: [
        { id: 'text-model', object: 'model' },
        { model: 'paraformer-realtime-v2', owned_by: 'aliyun' },
        { id: 'qwen3-asr-flash', created: 123 },
        { id: 'qwen3-asr-flash', ownedBy: 'dashscope' },
      ],
    });

    const result = await service.listAvailableModels();

    expect(service.getJson).toHaveBeenCalledWith(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
      'test-key',
      15_000
    );
    expect(result.models.map(model => model.id)).toEqual([
      'qwen3-asr-flash',
      'paraformer-realtime-v2',
      'text-model',
    ]);
    expect(result.models[0]).toEqual({
      id: 'qwen3-asr-flash',
      object: undefined,
      created: undefined,
      ownedBy: 'dashscope',
    });
    expect(result.error).toBeUndefined();
  });

  it('returns a safe error without making a request when no API key exists', async () => {
    const service = createService();
    service.injectedConfig.apiKey = '';
    delete process.env.TEST_DASHSCOPE_API_KEY;

    const result = await service.listAvailableModels();

    expect(service.getJson).not.toHaveBeenCalled();
    expect(result.models).toEqual([]);
    expect(result.error).toContain('Missing ASR API key');
  });

  it('uses runtime settings immediately after an update', () => {
    const service = createService();

    service.updateConfig({ model: 'paraformer-realtime-v2', enabled: false });

    expect(service.getPublicStatus()).toEqual(
      expect.objectContaining({
        model: 'paraformer-realtime-v2',
        enabled: false,
        available: false,
      })
    );
  });
});
