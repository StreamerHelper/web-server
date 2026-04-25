export function buildPlatformRoomUrl(
  platform?: string | null,
  roomId?: string | null
): string | undefined {
  if (!platform || !roomId) {
    return undefined;
  }

  if (platform === 'bilibili') {
    return `https://live.bilibili.com/${roomId}`;
  }

  if (platform === 'huya') {
    return `https://www.huya.com/${roomId}`;
  }

  if (platform === 'douyu') {
    return `https://www.douyu.com/${roomId}`;
  }

  if (platform === 'douyin') {
    return `https://live.douyin.com/${roomId}`;
  }

  return undefined;
}
