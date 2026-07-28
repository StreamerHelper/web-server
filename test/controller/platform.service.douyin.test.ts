import { PlatformService } from '../../src/service/platform.service';

describe('PlatformService Douyin auth outcomes', () => {
  it('persists only explicit browser challenge and expiry outcomes', async () => {
    const service = new PlatformService() as any;
    service.logger = {};
    service.douyinBrowserProfileService = {
      fetchLiveRoomPage: jest.fn(),
    };
    service.douyinAuthService = {
      markRuntimeChallenge: jest.fn().mockResolvedValue(undefined),
      markRuntimeExpired: jest.fn().mockResolvedValue(undefined),
    };

    const adapter = service.getAdapter('douyin') as any;
    await adapter.options.onBrowserOutcome('challenged', 'captcha');
    await adapter.options.onBrowserOutcome('expired', 'signed out');
    await adapter.options.onBrowserOutcome('transient', 'timeout');

    expect(service.douyinAuthService.markRuntimeChallenge).toHaveBeenCalledWith(
      'captcha'
    );
    expect(service.douyinAuthService.markRuntimeExpired).toHaveBeenCalledWith(
      'signed out'
    );
    expect(
      service.douyinAuthService.markRuntimeChallenge
    ).toHaveBeenCalledTimes(1);
    expect(service.douyinAuthService.markRuntimeExpired).toHaveBeenCalledTimes(
      1
    );
  });
});
