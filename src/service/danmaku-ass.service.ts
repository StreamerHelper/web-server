import { ILogger, Logger, Provide, Scope, ScopeEnum } from '@midwayjs/core';
import * as fs from 'fs/promises';
import {
  DanmakuMessage,
  DanmakuType,
  DanmakuPosition,
  DanmakuColor,
} from '../interface/data';

/**
 * ASS 弹幕样式选项
 */
export interface AssStyleOptions {
  fontName?: string; // 字体名称
  fontSize?: number; // 弹幕字号
  scFontSize?: number; // SC/礼物字号
  resolutionX?: number; // 视频 X 分辨率
  resolutionY?: number; // 视频 Y 分辨率
  displayArea?: number; // 弹幕显示区域 (0.0-1.0)
  rollTime?: number; // 滚动时间（秒）
  fixTime?: number; // 固定弹幕时间（秒）
  alpha?: number; // 不透明度 (0.0-1.0)
  bold?: number; // 加粗 (0/1)
  outline?: number; // 描边宽度
  shadow?: number; // 阴影宽度
}

/**
 * ASS 导出选项
 */
export interface AssExportOptions {
  style?: AssStyleOptions;
  removeEmoji?: boolean; // 移除 emoji
}

/**
 * ASS 弹幕渲染服务
 *
 * 将弹幕数据转换为 ASS 格式用于视频渲染
 * 参考：https://github.com/timerring/DanmakuConvert
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class DanmakuAssService {
  @Logger()
  private logger: ILogger;

  // 默认样式选项
  private readonly defaultStyle: AssStyleOptions = {
    fontName: 'Microsoft YaHei',
    fontSize: 38,
    scFontSize: 30,
    resolutionX: 1920,
    resolutionY: 1080,
    displayArea: 1.0,
    rollTime: 12,
    fixTime: 5,
    alpha: 0.8,
    bold: 0,
    outline: 1.0,
    shadow: 0.0,
  };

  /**
   * 将弹幕消息转换为 ASS 格式
   *
   * @param messages 弹幕消息列表
   * @param options 导出选项
   * @returns ASS 字符串
   */
  messagesToAss(
    messages: DanmakuMessage[],
    options: AssExportOptions = {}
  ): string {
    const style = { ...this.defaultStyle, ...options.style };

    let ass = '';

    // [Script Info] 部分
    ass += this.buildScriptInfo(style);

    // [V4+ Styles] 部分
    ass += this.buildStyles(style);

    // [Events] 部分
    ass += this.buildEvents(messages, style, options);

    return ass;
  }

  /**
   * 构建 [Script Info] 部分
   */
  private buildScriptInfo(style: AssStyleOptions): string {
    return `[Script Info]
ScriptType: v4.00+
Collisions: Normal
PlayResX: ${style.resolutionX}
PlayResY: ${style.resolutionY}
Timer: 100.0000
WrapStyle: 2
ScaledBorderAndShadow: yes

`;
  }

  /**
   * 构建 [V4+ Styles] 部分
   */
  private buildStyles(style: AssStyleOptions): string {
    const alphaValue = Math.round((style.alpha || 0.8) * 255);
    const primaryColor = `&H${alphaValue.toString(16).padStart(2, '0')}FFFFFF`;

    return `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding

Style: R2L,${style.fontName},${style.fontSize},${primaryColor},&H00FFFFFF,&H00000000,&H1E6A5149,${style.bold},0,0,0,100.00,100.00,0.00,0.00,1,${style.outline},${style.shadow},8,0,0,0,1
Style: L2R,${style.fontName},${style.fontSize},${primaryColor},&H00FFFFFF,&H00000000,&H1E6A5149,${style.bold},0,0,0,100.00,100.00,0.00,0.00,1,${style.outline},${style.shadow},8,0,0,0,1
Style: TOP,${style.fontName},${style.fontSize},${primaryColor},&H00FFFFFF,&H00000000,&H1E6A5149,${style.bold},0,0,0,100.00,100.00,0.00,0.00,1,${style.outline},${style.shadow},8,0,0,0,1
Style: BTM,${style.fontName},${style.fontSize},${primaryColor},&H00FFFFFF,&H00000000,&H1E6A5149,${style.bold},0,0,0,100.00,100.00,0.00,0.00,1,${style.outline},${style.shadow},8,0,0,0,1
Style: SP,${style.fontName},${style.scFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H1E6A5149,${style.bold},0,0,0,100.00,100.00,0.00,0.00,1,0.0,1.0,7,0,0,0,1
Style: message_box,${style.fontName},${style.scFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H1E6A5149,${style.bold},0,0,0,100.00,100.00,0.00,0.00,1,0.0,0.7,7,0,0,0,1

`;
  }

  /**
   * 构建 [Events] 部分
   */
  private buildEvents(
    messages: DanmakuMessage[],
    style: AssStyleOptions,
    options: AssExportOptions
  ): string {
    let events = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    // 按时间排序弹幕
    const sortedMessages = [...messages].sort(
      (a, b) => a.timestamp - b.timestamp
    );

    // TODO: 实现弹幕位置计算算法（防止重叠）
    // 目前使用简化版本：随机 Y 位置
    const rollYPositions = new Map<number, number>();
    const currentRow = 0;

    for (const msg of sortedMessages) {
      const dialogue = this.messageToAssDialogue(
        msg,
        style,
        options,
        rollYPositions,
        currentRow
      );
      events += dialogue + '\n';
    }

    return events;
  }

  /**
   * 将单条弹幕消息转换为 ASS Dialogue
   */
  private messageToAssDialogue(
    msg: DanmakuMessage,
    style: AssStyleOptions,
    options: AssExportOptions,
    rollYPositions: Map<number, number>,
    currentRow: number
  ): string {
    switch (msg.type) {
      case DanmakuType.CHAT:
        return this.chatToAssDialogue(
          msg,
          style,
          options,
          rollYPositions,
          currentRow
        );
      case DanmakuType.SUPER_CHAT:
        return this.superChatToAssDialogue(msg, style, options);
      case DanmakuType.GIFT:
        return this.giftToAssDialogue(msg, style, options);
      default:
        return '';
    }
  }

  /**
   * 普通弹幕转 ASS Dialogue
   */
  private chatToAssDialogue(
    msg: DanmakuMessage,
    style: AssStyleOptions,
    options: AssExportOptions,
    rollYPositions: Map<number, number>,
    currentRow: number
  ): string {
    const {
      timestamp = 0,
      position = DanmakuPosition.SCROLL,
      color = DanmakuColor.WHITE,
      content = '',
    } = msg;

    // 计算开始和结束时间
    const startTime = this.formatAssTime(timestamp / 1000);
    const endTime = this.formatAssTime(
      timestamp / 1000 +
        (position === DanmakuPosition.SCROLL ? style.rollTime! : style.fixTime!)
    );

    // 获取样式
    const assStyle = this.getAssStyle(position);

    // 计算位置
    const { resolutionX, fontSize } = style;
    let effect = '';

    if (position === DanmakuPosition.SCROLL) {
      // 滚动弹幕：使用 move 效果
      const y = this.getRollYPosition(msg, rollYPositions, currentRow, style);
      const textLength = this.calculateTextLength(content, fontSize);
      const startX = resolutionX + textLength / 2;
      const endX = -textLength / 2;
      effect = `{\\move(${startX},${y},${endX},${y})}`;
    } else if (position === DanmakuPosition.BOTTOM) {
      // 底部弹幕：使用 pos 效果
      const y = this.getBottomYPosition(msg, rollYPositions, currentRow, style);
      const x = style.resolutionX / 2;
      effect = `{\\pos(${x},${y})}`;
    } else if (position === DanmakuPosition.TOP) {
      // 顶部弹幕
      const y = fontSize + 10;
      const x = style.resolutionX / 2;
      effect = `{\\pos(${x},${y})}`;
    }

    // 颜色
    const colorTag = this.getColorTag(color);

    // 文本（移除 emoji）
    let text = content;
    if (options.removeEmoji) {
      text = this.removeEmoji(text);
    }

    return `Dialogue: 0,${startTime},${endTime},${assStyle},,,0000,0000,0000,,${effect}${colorTag}${text}`;
  }

  /**
   * SuperChat 转 ASS Dialogue
   */
  private superChatToAssDialogue(
    msg: DanmakuMessage,
    style: AssStyleOptions,
    options: AssExportOptions
  ): string {
    const { timestamp = 0, username, content = '' } = msg;

    // 从 msg 中获取 superChat 信息
    const price = (msg as any).superChat?.price || 0;

    // 计算显示时长
    const { duration } = this.getSuperChatConfig(price);

    const startTime = this.formatAssTime(timestamp / 1000);
    const endTime = this.formatAssTime(timestamp / 1000 + duration);

    // 计算 SC 框的位置（从底部往上堆叠）
    // TODO: 实现动态位置调整算法
    const scHeight = style.scFontSize! * 3 + 20;
    const y = (style.resolutionY || 1080) - scHeight - 10;
    const x = 20;

    // SC 颜色
    const scColor = this.getSuperChatColor(price);

    // 构建 SC 框和内容
    const maskedUser = this.maskUsername(username);

    return `Dialogue: 0,${startTime},${endTime},message_box,,,0000,0000,0000,,{\\pos(${x},${y})\\c&H${scColor}\\b1}${maskedUser}: {\\c&H${scColor}\\b0}${content}`;
  }

  /**
   * 礼物弹幕转 ASS Dialogue
   */
  private giftToAssDialogue(
    msg: DanmakuMessage,
    style: AssStyleOptions,
    options: AssExportOptions
  ): string {
    const { timestamp = 0, username } = msg;

    // 从 msg 中获取 gift 信息
    const gift = (msg as any).gift || {};
    const { giftName = '', count = 1 } = gift;

    // 礼物显示时间（较短）
    const displayTime = 2;

    const startTime = this.formatAssTime(timestamp / 1000);
    const endTime = this.formatAssTime(timestamp / 1000 + displayTime);

    // 礼物弹幕从下往上滚动
    // TODO: 实现礼物弹幕滚动算法
    const y = (style.resolutionY || 1080) - style.scFontSize! - 10;
    const x = 10;

    const maskedUser = this.maskUsername(username);
    const content = `${maskedUser}: ${giftName} x${count}`;

    return `Dialogue: 0,${startTime},${endTime},message_box,,,0000,0000,0000,,{\\pos(${x},${y})\\c&H1C7795\\b1}${content}`;
  }

  /**
   * 保存 ASS 到文件
   */
  async saveToFile(
    messages: DanmakuMessage[],
    filePath: string,
    options: AssExportOptions = {}
  ): Promise<void> {
    const ass = this.messagesToAss(messages, options);
    await fs.writeFile(filePath, ass, 'utf-8');
    this.logger.info('Danmaku ASS saved', {
      filePath,
      messageCount: messages.length,
    });
  }

  /**
   * 格式化 ASS 时间
   */
  private formatAssTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const cs = Math.floor((seconds % 1) * 100);

    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs
      .toString()
      .padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
  }

  /**
   * 获取 ASS 样式名称
   */
  private getAssStyle(position: DanmakuPosition): string {
    switch (position) {
      case DanmakuPosition.SCROLL:
        return 'R2L';
      case DanmakuPosition.BOTTOM:
        return 'BTM';
      case DanmakuPosition.TOP:
        return 'TOP';
      default:
        return 'R2L';
    }
  }

  /**
   * 计算滚动弹幕的 Y 位置
   * TODO: 实现完整的防碰撞算法
   */
  private getRollYPosition(
    msg: DanmakuMessage,
    rollYPositions: Map<number, number>,
    currentRow: number,
    style: AssStyleOptions
  ): number {
    const { fontSize } = style;
    // 简化实现：按行号计算 Y 位置
    return 1 + currentRow * (fontSize || 38);
  }

  /**
   * 计算底部弹幕的 Y 位置
   * TODO: 实现完整的防碰撞算法
   */
  private getBottomYPosition(
    msg: DanmakuMessage,
    rollYPositions: Map<number, number>,
    currentRow: number,
    style: AssStyleOptions
  ): number {
    const { fontSize } = style;
    // 简化实现：从底部往上
    return (style.resolutionY || 1080) - fontSize! * (currentRow + 1);
  }

  /**
   * 计算文本长度
   */
  private calculateTextLength(text: string, fontSize: number): number {
    // 简化实现：按字符数计算
    const cnt = text.length;
    return cnt * Math.floor(fontSize / 1.2);
  }

  /**
   * 获取颜色标签
   */
  private getColorTag(color: number | DanmakuColor): string {
    const colorValue = typeof color === 'number' ? color : color;
    // 转换为 BGR 格式
    const r = (colorValue >> 16) & 0xff;
    const g = (colorValue >> 8) & 0xff;
    const b = colorValue & 0xff;
    const bgr = (b << 16) | (g << 8) | r;
    return `{\\c&H${bgr.toString(16).padStart(6, '0').toUpperCase()}`;
  }

  /**
   * 获取 SuperChat 颜色
   */
  private getSuperChatColor(price: number): string {
    // 根据 B站 SC 颜色规则
    if (price < 30) return 'FF9E00'; // 浅蓝色
    if (price < 50) return 'E91E63'; // 粉红色
    if (price < 100) return '9C27B0'; // 紫色
    if (price < 500) return 'FF5722'; // 橙红色
    if (price < 1000) return 'F44336'; // 红色
    return 'FFD700'; // 金色
  }

  /**
   * 移除 emoji
   */
  private removeEmoji(text: string): string {
    // 简化实现：移除常见 emoji 范围
    return text
      .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
      .replace(/[\u{2600}-\u{26FF}]/gu, '')
      .replace(/[\u{2700}-\u{27BF}]/gu, '');
  }

  /**
   * 脱敏用户名
   */
  private maskUsername(username = ''): string {
    if (!username || username.length <= 2) {
      return username;
    }
    const firstChar = username[0];
    const lastChar = username[username.length - 1];
    return `${firstChar}${'***'.substring(0, 3)}${lastChar}`;
  }

  /**
   * 获取 SuperChat 配置
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
