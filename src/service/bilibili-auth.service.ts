import { ILogger, Provide, Scope, ScopeEnum, Logger } from '@midwayjs/core';
import * as crypto from 'crypto';

// B站 App Key 配置
export const BILIBILI_APP_KEYS = {
  BiliTV: {
    appkey: '4409e2ce8ffd12b8',
    appsecret: '59b43e04ad6965f34319062b478f83dd',
  },
  Android: {
    appkey: '783bbb7264451d82',
    appsecret: '2653583c8873dea268ab9386918b1d65',
  },
  BCutAndroid: {
    appkey: '5dce947fe22167f9',
    appsecret: '5491a31c6bc11fb764a9b1f8d4acf092',
  },
};

// 二维码登录状态
interface QRCodeStatus {
  authCode: string;
  url: string;
  expiresAt: number;
}

// 登录轮询响应
interface LoginPollResponse {
  status: 'waiting' | 'success' | 'expired';
  cookieInfo?: {
    cookies: Array<{
      name: string;
      value: string;
    }>;
    domains: string[];
  };
  tokenInfo?: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    mid: number;
  };
  sso?: string[];
}

/**
 * B站认证服务 - 处理二维码登录和 Token 管理
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class BilibiliAuthService {
  @Logger()
  private logger: ILogger;

  // 内存中临时存储二维码状态（实际生产应使用数据库)
  private qrCodeCache = new Map<string, QRCodeStatus>();

  /**
   * 构建查询字符串（按 key 排序）
   */
  private buildQueryString(
    params: Record<string, string | number | boolean>
  ): string {
    const sortedKeys = Object.keys(params).sort();
    return sortedKeys
      .map(
        key =>
          `${encodeURIComponent(key)}=${encodeURIComponent(
            String(params[key])
          )}`
      )
      .join('&');
  }

  /**
   * 生成签名
   */
  private sign(params: Record<string, string | number | boolean>): string {
    const queryString = this.buildQueryString(params);
    return crypto
      .createHash('md5')
      .update(queryString + BILIBILI_APP_KEYS.BiliTV.appsecret)
      .digest('hex');
  }

  /**
   * 签名请求参数（添加 sign 字段）
   */
  private signPayload(
    params: Record<string, string | number | boolean>
  ): Record<string, string> {
    const signature = this.sign(params);
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      result[key] = String(value);
    }
    result.sign = signature;
    return result;
  }

  /**
   * 获取当前时间戳（秒）
   */
  private getTimestamp(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * 获取二维码
   * 前端调用此接口获取二维码 URL， 用户扫码登录
   */
  async getQRCode(): Promise<{
    authCode: string;
    url: string;
    expiresIn: number;
  }> {
    const timestamp = this.getTimestamp();
    const params = this.signPayload({
      appkey: BILIBILI_APP_KEYS.BiliTV.appkey,
      local_id: '0',
      ts: timestamp,
    });

    const apiUrl =
      'https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code';

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: new URLSearchParams(params).toString(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get QR code: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      code: number;
      message?: string;
      data?: { auth_code: string; url: string };
    };
    if (data.code !== 0) {
      this.logger.error('Bilibili API error', {
        code: data.code,
        message: data.message,
      });
      throw new Error(`API error: ${data.message || 'Unknown error'}`);
    }

    const { auth_code, url } = data.data!;
    const expiresIn = Date.now() + 5 * 60 * 1000; // 5分钟过期

    this.qrCodeCache.set(auth_code, {
      authCode: auth_code,
      url,
      expiresAt: expiresIn,
    });

    this.logger.info('QR code generated', { authCode: auth_code });

    return { authCode: auth_code, url, expiresIn };
  }

  /**
   * 轮询二维码登录状态
   * 前端调用此接口检查是否已扫码登录成功
   */
  async pollQRCode(authCode: string): Promise<LoginPollResponse> {
    const cached = this.qrCodeCache.get(authCode);
    if (!cached) {
      throw new Error('QR code not found or expired');
    }

    const timestamp = this.getTimestamp();
    const params = this.signPayload({
      appkey: BILIBILI_APP_KEYS.BiliTV.appkey,
      auth_code: authCode,
      local_id: '0',
      ts: timestamp,
    });

    const apiUrl =
      'https://passport.bilibili.com/x/passport-tv-login/qrcode/poll';
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: new URLSearchParams(params).toString(),
    });

    if (!response.ok) {
      throw new Error(`Failed to poll QR code: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      code: number;
      message?: string;
      data?: {
        token_info?: {
          mid: number;
          access_token: string;
          refresh_token: string;
          expires_in: number;
        };
        cookie_info?: LoginPollResponse['cookieInfo'];
        sso?: string[];
      };
    };

    // 86038: 二维码已过期
    if (data.code === 86038) {
      this.qrCodeCache.delete(authCode);
      return { status: 'expired' };
    }

    // 86039: 等待扫码
    if (data.code === 86039) {
      return { status: 'waiting' };
    }

    // 0: 登录成功
    if (data.code === 0) {
      const loginData = data.data!;

      // 清理缓存
      this.qrCodeCache.delete(authCode);

      this.logger.info('Bilibili login successful', {
        mid: loginData.token_info?.mid,
      });

      return {
        status: 'success',
        cookieInfo: loginData.cookie_info,
        tokenInfo: loginData.token_info
          ? {
              accessToken: loginData.token_info.access_token,
              refreshToken: loginData.token_info.refresh_token,
              expiresIn: loginData.token_info.expires_in,
              mid: loginData.token_info.mid,
            }
          : undefined,
        sso: loginData.sso,
      };
    }

    throw new Error(`Login failed: ${data.message || 'Unknown error'}`);
  }

  /**
   * 使用 Cookie 确认二维码（服务端自动确认）
   * 用于已有 Web Cookie 但无需用户扫码的场景
   */
  async confirmQRCodeWithCookie(
    authCode: string,
    sessdata: string,
    biliJct: string
  ): Promise<void> {
    const url =
      'https://passport.bilibili.com/x/passport-tv-login/h5/qrcode/confirm';
    const params = new URLSearchParams({
      auth_code: authCode,
      csrf: biliJct,
      scanning_type: '3',
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `SESSDATA=${sessdata}; bili_jct=${biliJct}`,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Failed to confirm QR code: HTTP ${response.status}`);
    }

    const data = (await response.json()) as { code: number; message?: string };
    if (data.code !== 0) {
      throw new Error(`Confirm failed: ${data.message || 'Unknown error'}`);
    }

    this.logger.info('QR code confirmed with cookie');
  }

  /**
   * 获取用户账号信息
   * 使用 Cookie 认证方式（更可靠）
   */
  async getAccountInfo(cookies: {
    SESSDATA: string;
    bili_jct: string;
    Dedeuserid: string;
  }): Promise<{
    mid: number;
    name: string;
    face: string;
    sign: string;
    level: number;
    vipType: number;
    vipStatus: number;
  }> {
    const url = 'https://api.bilibili.com/x/space/myinfo';
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Cookie: `SESSDATA=${cookies.SESSDATA}; bili_jct=${cookies.bili_jct}; Dedeuserid=${cookies.Dedeuserid}`,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/63.0.3239.108',
        Referer: 'https://www.bilibili.com/',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get account info: HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      code: number;
      message?: string;
      data?: {
        mid?: number;
        name?: string;
        face?: string;
        sign?: string;
        level?: number;
        vip?: {
          vipType?: number;
          vipStatus?: number;
        };
      };
    };

    if (data.code !== 0) {
      throw new Error(
        `Failed to get account info: ${data.message || 'Unknown error'}`
      );
    }

    const userInfo = data.data!;
    return {
      mid: userInfo.mid || 0,
      name: userInfo.name || '',
      face: userInfo.face || '',
      sign: userInfo.sign || '',
      level: userInfo.level || 0,
      vipType: userInfo.vip?.vipType || 0,
      vipStatus: userInfo.vip?.vipStatus || 0,
    };
  }
}
