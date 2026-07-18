jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

jest.mock('../../src/config/loader', () => ({
  getConfig: jest.fn(),
  updateConfig: jest.fn(),
}));

import { SystemController } from '../../src/controller/system.controller';
import { getConfig, updateConfig } from '../../src/config/loader';

describe('SystemController ASR settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getConfig as jest.Mock).mockReturnValue({
      asr: {
        enabled: true,
        provider: 'aliyun',
        apiKey: 'existing-secret',
        apiKeyEnv: 'DASHSCOPE_API_KEY',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-asr-flash',
        language: 'zh-CN',
        chunkSeconds: 240,
        concurrency: 1,
        transcribeRecordings: true,
      },
    });
    (updateConfig as jest.Mock).mockImplementation(patch => ({
      asr: patch.asr,
    }));
  });

  const createController = () => {
    const controller = new SystemController() as any;
    controller.ctx = {
      logger: {
        error: jest.fn(),
      },
      status: 200,
    };
    controller.asrService = {
      getPublicStatus: jest.fn().mockReturnValue({
        enabled: true,
        provider: 'aliyun',
        available: true,
        apiKeySet: true,
        apiKeyMasked: 'new-****cret',
      }),
      listAvailableModels: jest.fn().mockResolvedValue({
        models: [{ id: 'qwen3-asr-flash' }],
        fetchedAt: 1710000000000,
        source: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
      }),
      updateConfig: jest.fn(),
    };
    return controller;
  };

  it('returns public ASR status without raw API key', async () => {
    const controller = createController();

    const result = await controller.getAsrSettings();

    expect(result).toEqual(
      expect.objectContaining({
        available: true,
        apiKeySet: true,
        apiKeyMasked: 'new-****cret',
      })
    );
    expect(result).not.toHaveProperty('apiKey');
  });

  it('returns ASR model list from the runtime service', async () => {
    const controller = createController();

    const result = await controller.getAsrModels();

    expect(controller.asrService.listAvailableModels).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        models: [{ id: 'qwen3-asr-flash' }],
        source: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
      })
    );
  });

  it('persists sanitized ASR settings and refreshes the runtime service', async () => {
    const controller = createController();

    await controller.updateAsrSettings({
      enabled: false,
      apiKey: ' new-secret ',
      model: 'qwen3-asr-flash',
      language: 'zh-CN',
      chunkSeconds: 10,
      concurrency: 99,
      transcribeRecordings: false,
    });

    expect(updateConfig).toHaveBeenCalledWith({
      asr: expect.objectContaining({
        enabled: false,
        provider: 'aliyun',
        apiKey: 'new-secret',
        chunkSeconds: 30,
        concurrency: 8,
        transcribeRecordings: false,
      }),
    });
    expect(controller.asrService.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'new-secret',
        enabled: false,
      })
    );
  });
});
