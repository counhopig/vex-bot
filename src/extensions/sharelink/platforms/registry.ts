/**
 * 平台适配器注册中心
 */

import { BasePlatformAdapter } from "./base.js";
import { getChildLogger } from "../../../utils/logger.js";

const logger = getChildLogger("sharelink-registry");

/** 平台适配器注册中心 */
export class PlatformRegistry {
  private readonly adapters: BasePlatformAdapter[] = [];

  /** 注册一个平台适配器 */
  register(adapter: BasePlatformAdapter): void {
    this.adapters.push(adapter);
    logger.info({ name: adapter.name, displayName: adapter.displayName }, "Platform adapter registered");
  }

  /** 按 name 移除已注册的适配器 */
  unregister(name: string): boolean {
    const idx = this.adapters.findIndex((a) => a.name === name);
    if (idx >= 0) {
      this.adapters.splice(idx, 1);
      return true;
    }
    return false;
  }

  /** 从已注册的适配器中找到第一个能处理该 URL 的 */
  match(url: string): BasePlatformAdapter | undefined {
    for (const adapter of this.adapters) {
      if (adapter.match(url)) {
        return adapter;
      }
    }
    return undefined;
  }

  /** 返回所有已注册平台的 name 列表 */
  get platforms(): readonly string[] {
    return this.adapters.map((a) => a.name);
  }
}
