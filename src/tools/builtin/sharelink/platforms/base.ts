/**
 * Platform adapter abstract base class and shared VideoMetadata type.
 *
 * Ported from archive; zero module-level state — each adapter is instantiated
 * per registry, and registries are built per (config, complete) pair.
 */

import { unlinkSync } from "fs";

/** Video metadata returned uniformly by every platform adapter. */
export interface VideoMetadata {
  readonly videoId: string;
  readonly title: string;
  readonly platform: string;
  readonly description: string;
  readonly duration: number;
  readonly owner: string;
  readonly thumbnailUrl: string;
  readonly extra: Record<string, unknown>;
}

/** Abstract base for share-link platform adapters. */
export abstract class BasePlatformAdapter {
  abstract readonly name: string;
  abstract readonly displayName: string;

  get idLabel(): string {
    return "视频 ID";
  }

  abstract match(url: string): boolean;
  abstract extractId(url: string): string | undefined;

  async resolveUrl(_url: string): Promise<string | undefined> {
    return undefined;
  }

  abstract fetchMetadata(videoId: string): Promise<VideoMetadata | undefined>;
  abstract fetchSubtitles(videoId: string, maxLength?: number): Promise<string | undefined>;
  abstract getVideoUrl(videoId: string): string;

  async downloadAudio(_videoId: string, _timeout?: number): Promise<string | undefined> {
    return undefined;
  }

  static cleanupAudio(audioPath: string): void {
    if (!audioPath) return;
    try {
      unlinkSync(audioPath);
    } catch {
      // ignore cleanup errors
    }
  }

  formatDisplayId(videoId: string): string {
    return videoId;
  }
}
