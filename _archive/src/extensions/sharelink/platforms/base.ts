/**
 * 平台适配器抽象基类与统一数据结构
 */
import { unlinkSync } from "fs";

/** 视频元信息，所有平台适配器统一返回此结构 */
export interface VideoMetadata {
  /** 平台内部 ID（B站为 BV号去掉前缀） */
  readonly videoId: string;
  /** 视频标题 */
  readonly title: string;
  /** 平台标识，如 "bilibili"、"youtube" */
  readonly platform: string;
  /** 视频简介 */
  readonly description: string;
  /** 时长（秒） */
  readonly duration: number;
  /** 作者/UP主 */
  readonly owner: string;
  /** 封面图 URL */
  readonly thumbnailUrl: string;
  /** 平台特有字段（如 B站 cid） */
  readonly extra: Record<string, unknown>;
}

/** 平台适配器抽象基类 */
export abstract class BasePlatformAdapter {
  /** 平台唯一标识，如 'bilibili'、'youtube' */
  abstract readonly name: string;

  /** 平台显示名称，如 'B站'、'YouTube' */
  abstract readonly displayName: string;

  /** 视频 ID 的显示标签，如 'BV号'、'Video ID' */
  get idLabel(): string {
    return "视频 ID";
  }

  /** 判断是否支持该 URL 或纯 ID */
  abstract match(url: string): boolean;

  /** 从 URL 或纯 ID 中提取平台视频 ID */
  abstract extractId(url: string): string | undefined;

  /** 解析短链接 / 重定向链接，返回规范化完整 URL */
  async resolveUrl(_url: string): Promise<string | undefined> {
    return undefined;
  }

  /** 获取视频元信息 */
  abstract fetchMetadata(videoId: string): Promise<VideoMetadata | undefined>;

  /** 获取视频字幕 / 文本内容 */
  abstract fetchSubtitles(videoId: string, maxLength?: number): Promise<string | undefined>;

  /** 获取可直接播放/下载的视频 URL（供 yt-dlp 使用） */
  abstract getVideoUrl(videoId: string): string;

  /** 下载视频音频作为字幕后备方案 */
  async downloadAudio(_videoId: string, _timeout?: number): Promise<string | undefined> {
    return undefined;
  }

  /** 清理下载的临时音频文件 */
  static cleanupAudio(audioPath: string): void {
    if (!audioPath) return;
    try {
      unlinkSync(audioPath);
    } catch {
      // ignore cleanup errors
    }
  }

  /** 格式化视频 ID 用于输出显示 */
  formatDisplayId(videoId: string): string {
    return videoId;
  }
}
