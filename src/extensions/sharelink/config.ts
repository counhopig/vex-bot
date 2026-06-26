/**
 * ShareLink 运行时配置存储
 *
 * 由于工具在 Agent 初始化时创建，而扩展在之后初始化，
 * 使用模块级单例让工具可以读取最新配置。
 */

import type { ShareLinkConfig } from "../../types/index.js";

let shareLinkConfig: ShareLinkConfig | undefined;

/** 设置 ShareLink 运行时配置 */
export function setShareLinkConfig(config: ShareLinkConfig | undefined): void {
  shareLinkConfig = config;
}

/** 获取 ShareLink 运行时配置 */
export function getShareLinkConfig(): ShareLinkConfig | undefined {
  return shareLinkConfig;
}
