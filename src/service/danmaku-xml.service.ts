import { ILogger, Logger, Provide, Scope, ScopeEnum } from '@midwayjs/core';
import * as fs from 'fs/promises';
import {
  DanmakuMessage,
  DanmakuType,
  DanmakuPosition,
  DanmakuColor,
} from '../interface/data';

/**
 * B站弹幕类型映射到 DanmakuConvert 格式
 */
const BILI_DANMAKU_TYPE_MAP: Record<DanmakuPosition, number> = {
  [DanmakuPosition.SCROLL]: 1, // 滚动弹幕
  [DanmakuPosition.BOTTOM]: 4, // 底部弹幕
  [DanmakuPosition.TOP]: 5, // 顶部弹幕
  [DanmakuPosition.REVERSE]: 6, // 逆向滚动
  [DanmakuPosition.POSITION]: 7, // 位置弹幕
};

/**
 * XML 弹幕文件元数据
 */
export interface DanmakuXmlMetadata {
  chatserver?: string;
  chatid?: string;
  mission?: string;
  maxlimit?: string;
  state?: string;
  real_name?: string;
  source?: string;
  user_name?: string;
  room_id?: string;
  room_title?: string;
  area?: string;
  parent_area?: string;
  live_start_time?: string;
  record_start_time?: string;
}

/**
 * XML 弹幕文件选项
 */
export interface DanmakuXmlOptions {
  metadata?: DanmakuXmlMetadata;
  version?: '1.0';
  encoding?: 'utf-8';
}

/**
 * 弹幕 XML 格式服务
 *
 * 负责将弹幕数据转换为 DanmakuConvert 兼容的 XML 格式
 * 参考：https://github.com/timerring/DanmakuConvert
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class DanmakuXmlService {
  @Logger()
  private logger: ILogger;

  /**
   * 将弹幕消息转换为 XML 格式
   *
   * @param messages 弹幕消息列表
   * @param options XML 选项
   * @returns XML 字符串
   */
  messagesToXml(
    messages: DanmakuMessage[],
    options: DanmakuXmlOptions = {}
  ): string {
    const { metadata = {}, version = '1.0', encoding = 'utf-8' } = options;

    // XML 头部
    let xml = `<?xml version='${version}' encoding='${encoding}'?>\n`;
    xml += '<i>\n';

    // 元数据
    xml += this.metadataToXml(metadata);

    // 弹幕列表
    for (const msg of messages) {
      xml += this.messageToXml(msg);
    }

    xml += '</i>\n';

    return xml;
  }

  /**
   * 将元数据转换为 XML
   */
  private metadataToXml(metadata: DanmakuXmlMetadata): string {
    let xml = '';

    if (metadata.chatserver)
      xml += `    <chatserver>${metadata.chatserver}</chatserver>\n`;
    if (metadata.chatid) xml += `    <chatid>${metadata.chatid}</chatid>\n`;
    if (metadata.mission) xml += `    <mission>${metadata.mission}</mission>\n`;
    if (metadata.maxlimit)
      xml += `    <maxlimit>${metadata.maxlimit}</maxlimit>\n`;
    if (metadata.state) xml += `    <state>${metadata.state}</state>\n`;
    if (metadata.real_name)
      xml += `    <real_name>${metadata.real_name}</real_name>\n`;
    if (metadata.source) xml += `    <source>${metadata.source}</source>\n`;

    if (Object.keys(metadata).length > 0 && !metadata.user_name) {
      xml += '    <metadata>\n';
      if (metadata.user_name)
        xml += `        <user_name>${metadata.user_name}</user_name>\n`;
      if (metadata.room_id)
        xml += `        <room_id>${metadata.room_id}</room_id>\n`;
      if (metadata.room_title)
        xml += `        <room_title>${metadata.room_title}</room_title>\n`;
      if (metadata.area) xml += `        <area>${metadata.area}</area>\n`;
      if (metadata.parent_area)
        xml += `        <parent_area>${metadata.parent_area}</parent_area>\n`;
      if (metadata.live_start_time)
        xml += `        <live_start_time>${metadata.live_start_time}</live_start_time>\n`;
      if (metadata.record_start_time)
        xml += `        <record_start_time>${metadata.record_start_time}</record_start_time>\n`;
      xml += '    </metadata>\n';
    }

    return xml;
  }

  /**
   * 将单条弹幕消息转换为 XML
   */
  private messageToXml(msg: DanmakuMessage): string {
    switch (msg.type) {
      case DanmakuType.CHAT:
        return this.chatToXml(msg);
      case DanmakuType.SUPER_CHAT:
        return this.superChatToXml(msg);
      case DanmakuType.GIFT:
        return this.giftToXml(msg);
      default:
        // 未知类型，尝试作为普通弹幕处理
        return this.chatToXml(msg);
    }
  }

  /**
   * 普通弹幕转 XML
   * 格式：<d p="{time},{type},{size},{color},{timestamp},{pool},{uid_crc32},{row_id}" uid="{uid}" user="{user}">{text}</d>
   */
  private chatToXml(msg: DanmakuMessage): string {
    const {
      timestamp = 0,
      position = DanmakuPosition.SCROLL,
      color = DanmakuColor.WHITE,
      timestamp: sendTime,
      userId,
      username,
      content = '',
    } = msg;

    // 计算弹幕类型
    const type = BILI_DANMAKU_TYPE_MAP[position] ?? 1;

    // 计算弹幕大小（使用中等大小作为默认）
    const size = this.calculateSize(content);

    // 计算弹幕颜色
    const colorValue = this.calculateColor(color);

    // 计算时间戳
    const ts = sendTime || Date.now() * 1000;

    // 生成 CRC32（简化实现）
    const uidCrc32 = this.crc32(userId);

    // 行 ID（随机生成）
    const rowId = Math.floor(Math.random() * 1000000000);

    // 转义内容中的特殊字符
    const escapedContent = this.escapeXml(content);

    // 构建属性字符串
    const p = `${(timestamp / 1000).toFixed(
      3
    )},${type},${size},${colorValue},${ts},0,${uidCrc32},${rowId}`;

    // 生成用户名（脱敏）
    const maskedUser = this.maskUsername(username);

    return `    <d p="${p}" uid="${userId}" user="${maskedUser}">${escapedContent}</d>\n`;
  }

  /**
   * SuperChat 转 XML
   * 格式：<sc ts="{time}" uid="{uid}" user="{user}" price="{price}" time="{duration}">{text}</sc>
   */
  private superChatToXml(msg: DanmakuMessage): string {
    const { timestamp = 0, userId, username, content = '' } = msg;

    // 从 msg 中获取 superChat 信息
    const superChat = (msg as any).superChat || {};
    const { price = 0 } = superChat;

    // 计算显示时长和字数限制（根据价格）
    const { duration, maxLength } = this.getSuperChatConfig(price);

    const ts = (timestamp / 1000).toFixed(3);
    const maskedUser = this.maskUsername(username);
    const escapedContent = this.escapeXml(
      content?.substring(0, maxLength) || ''
    );

    return `    <sc ts="${ts}" uid="${userId}" user="${maskedUser}" price="${price}" time="${duration}">${escapedContent}</sc>\n`;
  }

  /**
   * 礼物弹幕转 XML
   * 格式：<gift ts="{time}" uid="{uid}" user="{user}" giftname="{name}" giftcount="{count}" cointype="金瓜子" price="{price}"/>
   */
  private giftToXml(msg: DanmakuMessage): string {
    const { timestamp = 0, userId, username } = msg;

    // 从 msg 中获取 gift 信息
    const gift = (msg as any).gift || {};
    const { giftName = '', count = 1, totalPrice = 0 } = gift;

    const ts = (timestamp / 1000).toFixed(3);
    const maskedUser = this.maskUsername(username);

    return `    <gift ts="${ts}" uid="${userId}" user="${maskedUser}" giftname="${giftName}" giftcount="${count}" cointype="金瓜子" price="${totalPrice}"/>\n`;
  }

  /**
   * 保存 XML 到文件
   */
  async saveToFile(
    messages: DanmakuMessage[],
    filePath: string,
    options: DanmakuXmlOptions = {}
  ): Promise<void> {
    const xml = this.messagesToXml(messages, options);
    await fs.writeFile(filePath, xml, 'utf-8');
    this.logger.info('Danmaku XML saved', {
      filePath,
      messageCount: messages.length,
    });
  }

  /**
   * 从文件加载 XML
   */
  async loadFromFile(filePath: string): Promise<DanmakuMessage[]> {
    const content = await fs.readFile(filePath, 'utf-8');
    return this.parseXml(content);
  }

  /**
   * 解析 XML 字符串
   * TODO: 实现完整的 XML 解析
   */
  parseXml(xmlString: string): DanmakuMessage[] {
    // TODO: 实现 XML 解析
    this.logger.warn('XML parsing not implemented yet');
    return [];
  }

  /**
   * 计算弹幕大小
   */
  private calculateSize(text: string): number {
    const len = text?.length || 0;
    if (len <= 10) return 25;
    if (len <= 20) return 25;
    if (len <= 30) return 36;
    return 45;
  }

  /**
   * 计算弹幕颜色
   */
  private calculateColor(color: number | DanmakuColor): number {
    if (typeof color === 'number') {
      return color;
    }
    return color;
  }

  /**
   * 计算 CRC32（简化实现）
   */
  private crc32(str: string): number {
    let crc = 0 ^ -1;
    for (let i = 0; i < str.length; i++) {
      crc = (crc >>> 8) ^ this.crc32Table[(crc ^ str.charCodeAt(i)) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }

  private crc32Table: number[] = (() => {
    const table: number[] = [];
    for (let i = 0; i < 256; i++) {
      let crc = i;
      for (let j = 0; j < 8; j++) {
        crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
      table.push(crc);
    }
    return table;
  })();

  /**
   * 脱敏用户名
   */
  private maskUsername(username = ''): string {
    if (!username || username.length <= 2) {
      return username;
    }
    const firstChar = username[0];
    const lastChar = username[username.length - 1];
    const maskedLength = Math.max(3, username.length - 2);
    return `${firstChar}${'***'.substring(
      0,
      Math.min(3, maskedLength)
    )}${lastChar}`;
  }

  /**
   * 转义 XML 特殊字符
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * 获取 SuperChat 配置（根据价格）
   */
  private getSuperChatConfig(price: number): {
    duration: number;
    maxLength: number;
  } {
    if (price < 50) return { duration: 60, maxLength: 40 };
    if (price < 100) return { duration: 120, maxLength: 50 };
    if (price < 500) return { duration: 300, maxLength: 60 };
    if (price < 1000) return { duration: 1800, maxLength: 80 };
    if (price < 2000) return { duration: 3600, maxLength: 90 };
    return { duration: 7200, maxLength: 100 };
  }
}
