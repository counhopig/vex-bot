/**
 * Static file service and Control UI
 */

import { existsSync, readFileSync } from "fs";
import { join, extname } from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { getChildLogger } from "../utils/logger.js";
import type { VexConfig } from "../types/index.js";
import { COMMON_CSS, WEBCHAT_CSS, CONTROL_CSS } from "./template-css.js";
import { WEBCHAT_CLIENT_JS, CONTROL_CLIENT_JS } from "./template-client.js";
import { I18N_CLIENT_JS } from "./i18n.js";

const logger = getChildLogger("static");

/** Vex mascot SVG (small, for avatar) */
const MASCOT_SVG_SMALL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="32" height="32"><circle cx="40" cy="40" r="38" fill="#0f172a"/><path d="M12 30 L22 8 L30 28 Z" fill="#d4a054"/><path d="M50 28 L58 8 L68 30 Z" fill="#d4a054"/><ellipse cx="40" cy="46" rx="26" ry="22" fill="#e8a840"/><ellipse cx="40" cy="52" rx="18" ry="16" fill="#fff8f0"/><path d="M32 34 Q40 28 48 34 L46 40 Q40 36 34 40 Z" fill="#fff8f0"/><ellipse cx="30" cy="44" rx="4" ry="5" fill="#1a1a2e"/><circle cx="31" cy="43" r="1.5" fill="white"/><ellipse cx="50" cy="44" rx="4" ry="5" fill="#1a1a2e"/><circle cx="51" cy="43" r="1.5" fill="white"/><ellipse cx="30" cy="38" rx="4" ry="1.5" fill="#c4903c"/><ellipse cx="50" cy="38" rx="4" ry="1.5" fill="#c4903c"/><ellipse cx="20" cy="50" rx="4" ry="2.5" fill="#fca5a5" opacity="0.4"/><ellipse cx="60" cy="50" rx="4" ry="2.5" fill="#fca5a5" opacity="0.4"/><ellipse cx="40" cy="52" rx="4" ry="3" fill="#1a1a2e"/><path d="M40 55 L40 58" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round"/><path d="M34 60 Q40 64 46 60" stroke="#1a1a2e" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M18 66 Q40 74 62 66" stroke="#10b981" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="40" cy="72" r="4" fill="#10b981"/></svg>`;

/** Vex mascot SVG (medium, for sidebar) */
const MASCOT_SVG_MEDIUM = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="28" height="28"><circle cx="40" cy="40" r="38" fill="#0f172a"/><path d="M12 30 L22 8 L30 28 Z" fill="#d4a054"/><path d="M50 28 L58 8 L68 30 Z" fill="#d4a054"/><ellipse cx="40" cy="46" rx="26" ry="22" fill="#e8a840"/><ellipse cx="40" cy="52" rx="18" ry="16" fill="#fff8f0"/><path d="M32 34 Q40 28 48 34 L46 40 Q40 36 34 40 Z" fill="#fff8f0"/><ellipse cx="30" cy="44" rx="4" ry="5" fill="#1a1a2e"/><circle cx="31" cy="43" r="1.5" fill="white"/><ellipse cx="50" cy="44" rx="4" ry="5" fill="#1a1a2e"/><circle cx="51" cy="43" r="1.5" fill="white"/><ellipse cx="30" cy="38" rx="4" ry="1.5" fill="#c4903c"/><ellipse cx="50" cy="38" rx="4" ry="1.5" fill="#c4903c"/><ellipse cx="20" cy="50" rx="4" ry="2.5" fill="#fca5a5" opacity="0.4"/><ellipse cx="60" cy="50" rx="4" ry="2.5" fill="#fca5a5" opacity="0.4"/><ellipse cx="40" cy="52" rx="4" ry="3" fill="#1a1a2e"/><path d="M40 55 L40 58" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round"/><path d="M34 60 Q40 64 46 60" stroke="#1a1a2e" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M18 66 Q40 74 62 66" stroke="#10b981" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="40" cy="72" r="4" fill="#10b981"/></svg>`;

/** Vex mascot SVG (large, animated, for welcome page) */
const MASCOT_SVG_LARGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="80" height="80"><defs><linearGradient id="mascot-g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#10b981"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient></defs><style>@keyframes mascot-wink{0%,90%,100%{transform:scaleY(1)}95%{transform:scaleY(0.1)}}@keyframes mascot-hide{0%,90%,100%{opacity:1}95%{opacity:0}}.mascot-left-eye{animation:mascot-wink 3s infinite;transform-origin:30px 44px}.mascot-left-highlight{animation:mascot-hide 3s infinite}</style><circle cx="40" cy="40" r="38" fill="#0f172a"/><path d="M12 30 L22 8 L30 28 Z" fill="#d4a054"/><path d="M15 28 L22 12 L28 26 Z" fill="#fca5a5" opacity="0.3"/><path d="M50 28 L58 8 L68 30 Z" fill="#d4a054"/><path d="M52 26 L58 12 L65 28 Z" fill="#fca5a5" opacity="0.3"/><ellipse cx="40" cy="46" rx="26" ry="22" fill="#e8a840"/><ellipse cx="40" cy="52" rx="18" ry="16" fill="#fff8f0"/><path d="M32 34 Q40 28 48 34 L46 40 Q40 36 34 40 Z" fill="#fff8f0"/><ellipse class="mascot-left-eye" cx="30" cy="44" rx="4" ry="5" fill="#1a1a2e"/><circle class="mascot-left-highlight" cx="31" cy="43" r="1.5" fill="white"/><ellipse cx="50" cy="44" rx="4" ry="5" fill="#1a1a2e"/><circle cx="51" cy="43" r="1.5" fill="white"/><ellipse cx="30" cy="38" rx="4" ry="1.5" fill="#c4903c"/><ellipse cx="50" cy="38" rx="4" ry="1.5" fill="#c4903c"/><ellipse cx="20" cy="50" rx="4" ry="2.5" fill="#fca5a5" opacity="0.4"/><ellipse cx="60" cy="50" rx="4" ry="2.5" fill="#fca5a5" opacity="0.4"/><ellipse cx="40" cy="52" rx="4" ry="3" fill="#1a1a2e"/><ellipse cx="39" cy="51" rx="1" ry="0.8" fill="white" opacity="0.3"/><path d="M40 55 L40 58" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round"/><path d="M34 60 Q40 64 46 60" stroke="#1a1a2e" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M18 66 Q40 74 62 66" stroke="#10b981" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="40" cy="72" r="4" fill="url(#mascot-g)"><animate attributeName="opacity" values="1;0.5;1" dur="2s" repeatCount="indefinite"/></circle></svg>`;

/** MIME type mapping */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** Get embedded HTML page */
function getEmbeddedHtml(config: VexConfig): string {
  const assistantName = "Vex";
  const defaultModel = config.agent.defaultModel;
  const defaultProvider = config.agent.defaultProvider;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${assistantName} - AI Assistant</title>
  <style>
${COMMON_CSS}${WEBCHAT_CSS}
  </style>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</head>
<body>
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-logo">${MASCOT_SVG_MEDIUM}</span>
      <span class="sidebar-title">${assistantName}</span>
    </div>
    <button class="new-chat-btn" id="newChatBtn">+ New Chat</button>
    <div class="session-list" id="sessionList">
      <div class="empty-sessions">No recent sessions</div>
    </div>
    <div class="sidebar-footer">
      <span id="sessionCount">0 sessions</span>
      <a href="/control" style="color: var(--primary); text-decoration: none;">Console</a>
    </div>
  </aside>
  <div class="sidebar-overlay" id="sidebarOverlay"></div>

  <div class="main-container">
    <header class="header">
      <div class="header-left">
        <button class="menu-btn" id="menuBtn">☰</button>
        <div>
          <div class="title">${assistantName}</div>
          <div class="subtitle">${defaultProvider} / ${defaultModel}</div>
        </div>
      </div>
      <div class="status">
        <span class="status-dot" id="statusDot"></span>
        <span id="statusText">Connecting...</span>
      </div>
    </header>

    <main class="main">
      <div class="messages" id="messages">
        <div class="welcome" id="welcome">
          <div class="welcome-icon">${MASCOT_SVG_LARGE}</div>
          <h2>Welcome to ${assistantName}</h2>
          <p>I'm an AI assistant powered by Chinese LLMs, here to help with questions, coding, data analysis, and more.</p>
          <div class="features">
            <div class="feature"><div class="feature-icon">💬</div><div class="feature-text">Smart Chat</div></div>
            <div class="feature"><div class="feature-icon">💻</div><div class="feature-text">Code Assistant</div></div>
            <div class="feature"><div class="feature-icon">📊</div><div class="feature-text">Data Analysis</div></div>
            <div class="feature"><div class="feature-icon">🔧</div><div class="feature-text">Tool Calling</div></div>
          </div>
        </div>
      </div>
      <div class="input-area">
        <textarea id="input" placeholder="Type a message... (Enter to send, Shift+Enter for new line, Esc to cancel)" rows="1"></textarea>
        <button class="btn-icon" id="clearBtn" title="Clear chat">🗑️</button>
        <button id="cancelBtn" class="cancel-btn" title="Cancel this request" style="display: none;">Cancel</button>
        <button id="sendBtn"><span>Send</span><span>↵</span></button>
      </div>
    </main>
  </div>

  <script>
${I18N_CLIENT_JS}
${WEBCHAT_CLIENT_JS.replace("${MASCOT_SVG_SMALL}", MASCOT_SVG_SMALL)}
  </script>
</body>
</html>`;
}

/** Get Control UI page */
function getControlHtml(config: VexConfig): string {
  const assistantName = "Vex";
  const defaultModel = config.agent.defaultModel;
  const defaultProvider = config.agent.defaultProvider;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${assistantName} - Console</title>
  <style>
${COMMON_CSS}${CONTROL_CSS}
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-logo">
          <span>${MASCOT_SVG_MEDIUM}</span>
          <span>${assistantName}</span>
        </div>
      </div>
      <div class="nav-section">Monitor</div>
      <div class="nav-item active" data-view="overview">
        <span class="nav-item-icon">📊</span>
        <span>Overview</span>
      </div>
      <div class="nav-item" data-view="sessions">
        <span class="nav-item-icon">💬</span>
        <span>Sessions</span>
      </div>
      <div class="nav-section">Configuration</div>
      <div class="nav-item" data-view="config">
        <span class="nav-item-icon">⚙️</span>
        <span>Config</span>
      </div>
      <div class="nav-item" data-view="settings">
        <span class="nav-item-icon">🛠️</span>
        <span>Settings</span>
      </div>
      <div class="nav-item" data-view="providers">
        <span class="nav-item-icon">🤖</span>
        <span>Model Providers</span>
      </div>
      <div class="nav-item" data-view="channels">
        <span class="nav-item-icon">📱</span>
        <span>Channels</span>
      </div>
      <div class="nav-section">Tools</div>
      <div class="nav-item" data-view="logs">
        <span class="nav-item-icon">📋</span>
        <span>Logs</span>
      </div>
      <div style="flex:1"></div>
      <a href="/" class="nav-item">
        <span class="nav-item-icon">💬</span>
        <span>Back to Chat</span>
      </a>
    </aside>

    <main class="main-content">
      <!-- Overview view -->
      <div class="view active" id="view-overview">
        <div class="page-header">
          <h1 class="page-title">System Overview</h1>
          <p class="page-desc">View system runtime status and key metrics</p>
        </div>
        <div class="cards">
          <div class="card">
            <div class="card-header">
              <span class="card-title">Connection Status</span>
              <span class="card-icon">🔌</span>
            </div>
            <div id="connection-status">
              <span class="status-badge offline"><span class="status-dot"></span>Connecting</span>
            </div>
          </div>
          <div class="card">
            <div class="card-header">
              <span class="card-title">Uptime</span>
              <span class="card-icon">⏱️</span>
            </div>
            <div class="card-value" id="uptime">--</div>
            <div class="card-label">since startup</div>
          </div>
          <div class="card">
            <div class="card-header">
              <span class="card-title">WebSocket Connections</span>
              <span class="card-icon">👥</span>
            </div>
            <div class="card-value" id="session-count">0</div>
            <div class="card-label">Current browser clients</div>
          </div>
          <div class="card">
            <div class="card-header">
              <span class="card-title">Default Model</span>
              <span class="card-icon">🧠</span>
            </div>
            <div class="card-value" style="font-size:1rem;word-break:break-all">${defaultModel}</div>
            <div class="card-label">${defaultProvider}</div>
          </div>
        </div>
        <div class="table-container">
          <div class="table-header">
            <span class="table-title">System Info</span>
            <button class="btn btn-secondary" onclick="refreshStatus()">Refresh</button>
          </div>
          <table>
            <tbody id="system-info">
              <tr><td>Version</td><td id="version">--</td></tr>
              <tr><td>Model Providers</td><td id="provider-count">--</td></tr>
              <tr><td>Channels</td><td id="channel-count">--</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Sessions view -->
      <div class="view" id="view-sessions">
        <div class="page-header">
          <h1 class="page-title">Session Management</h1>
          <p class="page-desc">View and manage active chat sessions</p>
        </div>
        <div class="table-container">
          <div class="table-header">
            <span class="table-title">Stored Sessions</span>
            <button class="btn btn-secondary" onclick="refreshSessions()">Refresh</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Session ID</th>
                <th>Channel</th>
                <th>Messages</th>
                <th>Last Active</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="sessions-list">
              <tr><td colspan="5" class="empty-state">No active sessions</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Model Providers view -->
      <div class="view" id="view-providers">
        <div class="page-header">
          <h1 class="page-title">Model Providers</h1>
          <p class="page-desc">View configured AI model providers and available models</p>
        </div>
        <div class="cards" id="providers-list">
          <div class="empty-state">
            <div class="empty-state-icon">🤖</div>
            <p>Loading...</p>
          </div>
        </div>
      </div>

      <!-- Channels view -->
      <div class="view" id="view-channels">
        <div class="page-header">
          <h1 class="page-title">Channels</h1>
          <p class="page-desc">View configured channel platform connection status</p>
        </div>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Status</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody id="channels-list">
              <tr><td colspan="3" class="empty-state">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Config view -->
      <div class="view" id="view-config">
        <div class="page-header">
          <h1 class="page-title">Configuration Management</h1>
          <p class="page-desc">Visually configure model providers, channels, and system settings</p>
        </div>
        <div style="display:flex;gap:0.5rem;margin-bottom:1.5rem;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="loadConfig()">Refresh Config</button>
          <button class="btn btn-secondary" onclick="saveAllConfig()">Save All Changes</button>
        </div>
        <div id="config-tabs" style="display:flex;gap:0.5rem;border-bottom:1px solid var(--border);padding-bottom:0.5rem;margin-bottom:1.5rem;">
          <button class="config-tab active" data-tab="agent">Agent</button>
          <button class="config-tab" data-tab="providers">Model Providers</button>
          <button class="config-tab" data-tab="channels">Channels</button>
          <button class="config-tab" data-tab="server">Server</button>
          <button class="config-tab" data-tab="memory">Memory</button>
        </div>

        <!-- Agent config -->
        <div class="config-content active" id="tab-agent">
          <div class="form-section">
            <h3 class="form-section-title">Agent Settings</h3>
            <div class="form-group">
              <label>Default Provider</label>
              <select id="agent-provider" class="form-input">
                <option value="deepseek">DeepSeek</option>
                <option value="doubao">Doubao</option>
                <option value="minimax">MiniMax</option>
                <option value="kimi">Kimi</option>
                <option value="stepfun">StepFun</option>
                <option value="modelscope">ModelScope</option>
                <option value="dashscope">DashScope (Qwen)</option>
                <option value="zhipu">Zhipu AI</option>
                <option value="longcat">LongCat</option>
                <option value="openai">OpenAI</option>
                <option value="ollama">Ollama</option>
                <option value="openrouter">OpenRouter</option>
                <option value="together">Together AI</option>
                <option value="groq">Groq</option>
                <option value="custom-openai">Custom OpenAI</option>
                <option value="custom-anthropic">Custom Anthropic</option>
              </select>
            </div>
            <div class="form-group">
              <label>Default Model</label>
              <input type="text" id="agent-model" class="form-input" placeholder="e.g. deepseek-chat" />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Temperature</label>
                <input type="number" id="agent-temperature" class="form-input" step="0.1" min="0" max="2" placeholder="0.7" />
              </div>
              <div class="form-group">
                <label>Max Tokens</label>
                <input type="number" id="agent-max-tokens" class="form-input" min="1" placeholder="4096" />
              </div>
            </div>
            <div class="form-group">
              <label>System Prompt</label>
              <textarea id="agent-system-prompt" class="form-input" rows="4" placeholder="Custom system prompt..."></textarea>
            </div>
          </div>
        </div>

        <!-- Providers config -->
        <div class="config-content" id="tab-providers">
          <div class="form-section">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
              <h3 class="form-section-title">Model Providers</h3>
              <button class="btn btn-secondary" onclick="showAddProviderModal()">+ Add Provider</button>
            </div>
            <div id="providers-list-form" class="providers-grid"></div>
          </div>
        </div>

        <!-- Channels config -->
        <div class="config-content" id="tab-channels">
          <div class="form-section">
            <h3 class="form-section-title">Channels</h3>
            <div class="channels-form-grid">
              <div class="channel-config-card">
                <div class="card-header">
                  <span class="card-title">Personal WeChat</span>
                  <label class="toggle-switch">
                    <input type="checkbox" id="weixin-enabled" />
                    <span class="toggle-slider"></span>
                  </label>
                </div>
                <div class="channel-form-fields">
                  <p class="form-hint">Personal WeChat uses QR code login, no manual credentials needed</p>
                  <input type="text" id="weixin-bot-type" class="form-input" placeholder="Bot Type (default: 3)" />
                  <input type="text" id="weixin-base-url" class="form-input" placeholder="API Base URL (default: https://ilinkai.weixin.qq.com)" />
                  <p id="weixin-status" class="form-hint" style="color: #f59e0b;">Status: Not logged in (click below to scan QR code)</p>
                  <button id="weixin-qr-btn" class="btn btn-primary" style="margin-top: 8px;" onclick="startWeixinQRLogin()">Scan QR Login</button>
                  <div id="weixin-qr-area" style="display:none; margin-top: 12px; text-align: center;">
                    <img id="weixin-qr-img" src="" alt="WeChat QR" style="max-width: 280px; border: 1px solid #e5e7eb; border-radius: 8px;" />
                    <p id="weixin-qr-status" style="color: #f59e0b; margin-top: 8px; font-weight: 500;">Waiting for scan...</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Server config -->
        <div class="config-content" id="tab-server">
          <div class="form-section">
            <h3 class="form-section-title">Server Settings</h3>
            <div class="form-row">
              <div class="form-group">
                <label>Port</label>
                <input type="number" id="server-port" class="form-input" min="1" max="65535" />
              </div>
              <div class="form-group">
                <label>Host</label>
                <input type="text" id="server-host" class="form-input" placeholder="0.0.0.0" />
              </div>
            </div>
            <div class="form-group">
              <label>Log Level</label>
              <select id="logging-level" class="form-input">
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>
            <p class="form-hint">Changing server port requires a restart to take effect</p>
          </div>
        </div>

        <!-- Memory config -->
        <div class="config-content" id="tab-memory">
          <div class="form-section">
            <h3 class="form-section-title">Memory</h3>
            <div class="form-group">
              <label class="checkbox-label">
                <input type="checkbox" id="memory-enabled" />
                <span>Enable Long-Term Memory</span>
              </label>
              <p class="form-hint">Allow Agent to remember user preferences and important info across sessions</p>
            </div>
            <div class="form-group">
              <label>Storage Directory</label>
              <input type="text" id="memory-directory" class="form-input" placeholder="~/.vex/memory" />
            </div>
          </div>
        </div>

        <!-- Save result -->
        <div id="save-result" class="save-result"></div>
      </div>

      <!-- Settings view -->
      <div class="view" id="view-settings">
        <div class="page-header">
          <h1 class="page-title">Settings</h1>
          <p class="page-desc">Edit bot persona, extensions, weather, skills, sessions, and raw config</p>
        </div>
        <div style="display:flex;gap:0.5rem;margin-bottom:1.5rem;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="loadSettings()">Refresh Settings</button>
          <button class="btn btn-secondary" onclick="saveAllSettings()">Save Settings</button>
        </div>
        <div id="settings-tabs" style="display:flex;gap:0.5rem;border-bottom:1px solid var(--border);padding-bottom:0.5rem;margin-bottom:1.5rem;flex-wrap:wrap;">
          <button class="config-tab active" data-settings-tab="persona">Bot / Persona</button>
          <button class="config-tab" data-settings-tab="extensions">Extensions</button>
          <button class="config-tab" data-settings-tab="weather">Weather</button>
          <button class="config-tab" data-settings-tab="skills">Skills</button>
          <button class="config-tab" data-settings-tab="sessions">Sessions</button>
          <button class="config-tab" data-settings-tab="geek">Geek (Raw JSON)</button>
        </div>

        <!-- Persona tab -->
        <div class="config-content active" id="settings-tab-persona">
          <div class="form-section">
            <h3 class="form-section-title">Bot Persona</h3>
            <div class="form-group">
              <label class="checkbox-label">
                <input type="checkbox" id="persona-enabled" />
                <span>Enable Persona System</span>
              </label>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Persona Name</label>
                <input type="text" id="persona-name" class="form-input" placeholder="e.g. Vex" />
              </div>
              <div class="form-group">
                <label>Reply Style</label>
                <input type="text" id="persona-reply-style" class="form-input" placeholder="e.g. warm, concise" />
              </div>
            </div>
            <div class="form-group">
              <label>Base Prompt</label>
              <textarea id="persona-base-prompt" class="form-input" rows="4" placeholder="Core persona prompt injected into the system message"></textarea>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="persona-time-awareness" />
                  <span>Time Awareness</span>
                </label>
              </div>
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="persona-emotion-enabled" />
                  <span>Emotion System</span>
                </label>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Emotion Decay / Hour</label>
                <input type="number" id="persona-emotion-decay" class="form-input" min="0" max="100" step="0.1" />
              </div>
              <div class="form-group">
                <label>Emotion Recovery / Reply</label>
                <input type="number" id="persona-emotion-recovery" class="form-input" min="0" max="100" step="0.1" />
              </div>
            </div>
            <div class="form-group">
              <label>Emotion Injection Style</label>
              <input type="text" id="persona-emotion-injection-style" class="form-input" placeholder="e.g. suffix" />
            </div>
            <div class="form-group">
              <label>Emotion Decay Cron</label>
              <input type="text" id="persona-emotion-decay-cron" class="form-input" placeholder="cron expression" />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="persona-memory-enabled" />
                  <span>Memory</span>
                </label>
              </div>
              <div class="form-group">
                <label>Memory Max Turns</label>
                <input type="number" id="persona-memory-max-turns" class="form-input" min="0" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="persona-reflection-enabled" />
                  <span>Reflection</span>
                </label>
              </div>
              <div class="form-group">
                <label>Reflection Trigger Turns</label>
                <input type="number" id="persona-reflection-trigger-turns" class="form-input" min="0" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Reflection History Turns</label>
                <input type="number" id="persona-reflection-history-turns" class="form-input" min="0" />
              </div>
              <div class="form-group">
                <label>Reflection Periodic Cron</label>
                <input type="text" id="persona-reflection-periodic-cron" class="form-input" placeholder="cron expression" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="persona-profile-enabled" />
                  <span>Profile</span>
                </label>
              </div>
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="persona-profile-building" />
                  <span>Profile Building</span>
                </label>
              </div>
            </div>
            <div class="form-group">
              <label>Profile Building Trigger Turns</label>
              <input type="number" id="persona-profile-building-trigger-turns" class="form-input" min="0" />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="persona-rest-enabled" />
                  <span>Rest / Sleep</span>
                </label>
              </div>
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="persona-proactive-nudge" />
                  <span>Proactive Nudge</span>
                </label>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Rest Sleep Hour (0-23)</label>
                <input type="number" id="persona-rest-sleep-hour" class="form-input" min="0" max="23" />
              </div>
              <div class="form-group">
                <label>Rest Wake Hour (0-23)</label>
                <input type="number" id="persona-rest-wake-hour" class="form-input" min="0" max="23" />
              </div>
            </div>
            <div class="form-group">
              <label>Proactive Nudge Cron</label>
              <input type="text" id="persona-proactive-nudge-cron" class="form-input" placeholder="cron expression" />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="persona-greeting-first-chat" />
                  <span>Greeting On First Chat</span>
                </label>
              </div>
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="persona-goodnight-hint" />
                  <span>Goodnight Hint</span>
                </label>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="persona-debug-log" />
                  <span>Debug Log</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- Extensions tab (Skill Learner + ShareLink) -->
        <div class="config-content" id="settings-tab-extensions">
          <div class="form-section">
            <h3 class="form-section-title">Skill Learner</h3>
            <div class="form-group">
              <label class="checkbox-label">
                <input type="checkbox" id="skilllearner-enabled" />
                <span>Enable Skill Learner</span>
              </label>
            </div>
            <div class="form-group">
              <label>Auto Trigger Keywords (comma-separated)</label>
              <input type="text" id="skilllearner-auto-trigger-keywords" class="form-input" placeholder="learn, skill" />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Max Learning Turns</label>
                <input type="number" id="skilllearner-max-learning-turns" class="form-input" min="0" />
              </div>
              <div class="form-group">
                <label>Proactive Threshold (0-1)</label>
                <input type="number" id="skilllearner-proactive-threshold" class="form-input" min="0" max="1" step="0.01" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="skilllearner-auto-learn" />
                  <span>Enable Auto Learn</span>
                </label>
              </div>
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="skilllearner-proactive-suggest" />
                  <span>Enable Proactive Suggest</span>
                </label>
              </div>
            </div>
            <div class="form-group">
              <label class="checkbox-label">
                <input type="checkbox" id="skilllearner-auto-deploy" />
                <span>Auto Deploy To Skills</span>
              </label>
            </div>
          </div>

          <div class="form-section" style="margin-top:1.5rem;">
            <h3 class="form-section-title">ShareLink</h3>
            <div class="form-group">
              <label class="checkbox-label">
                <input type="checkbox" id="sharelink-enabled" />
                <span>Enable ShareLink</span>
              </label>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Response Mode</label>
                <select id="sharelink-response-mode" class="form-input">
                  <option value="simple">simple</option>
                  <option value="detailed">detailed</option>
                </select>
              </div>
              <div class="form-group">
                <label>Description Max Length</label>
                <input type="number" id="sharelink-description-max-length" class="form-input" min="0" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="sharelink-include-description" />
                  <span>Include Description</span>
                </label>
              </div>
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="sharelink-include-cover" />
                  <span>Include Cover</span>
                </label>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="sharelink-auto-detect" />
                  <span>Auto Detect</span>
                </label>
              </div>
              <div class="form-group">
                <label>Audio Download Timeout (ms)</label>
                <input type="number" id="sharelink-audio-timeout" class="form-input" min="0" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Subtitle Max Length</label>
                <input type="number" id="sharelink-subtitle-max-length" class="form-input" min="0" />
              </div>
              <div class="form-group">
                <label>LLM Short Content Threshold</label>
                <input type="number" id="sharelink-llm-short-threshold" class="form-input" min="0" />
              </div>
            </div>
            <div class="form-group">
              <label>LLM Chunk Size</label>
              <input type="number" id="sharelink-llm-chunk-size" class="form-input" min="0" />
            </div>
            <div class="form-group">
              <label>Bilibili Cookie (leave blank to keep existing)</label>
              <input type="text" id="sharelink-bili-sessdata" class="form-input" placeholder="SESSDATA" />
              <input type="text" id="sharelink-bili-jct" class="form-input" placeholder="bili_jct" style="margin-top:0.5rem;" />
              <p class="form-hint" id="sharelink-cookie-status">No cookie configured</p>
            </div>
          </div>
        </div>

        <!-- Weather tab -->
        <div class="config-content" id="settings-tab-weather">
          <div class="form-section">
            <h3 class="form-section-title">Weather</h3>
            <div class="form-row">
              <div class="form-group">
                <label>Weather Provider</label>
                <select id="weather-provider" class="form-input">
                  <option value="wttr">wttr</option>
                  <option value="caiyun">caiyun</option>
                </select>
                <p class="form-hint">wttr is free and needs no API key; Caiyun is more precise and requires an API key</p>
              </div>
              <div class="form-group">
                <label>Caiyun API Version</label>
                <select id="weather-caiyun-api-version" class="form-input">
                  <option value="v2.6">v2.6</option>
                  <option value="v3">v3</option>
                </select>
              </div>
            </div>
            <div class="form-group">
              <label>Caiyun API Key / Token (leave blank to keep existing)</label>
              <input type="password" id="weather-caiyun-api-key" class="form-input" placeholder="Caiyun API key" autocomplete="new-password" />
              <p class="form-hint" id="weather-caiyun-key-status">No Caiyun API key configured</p>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Default Location</label>
                <input type="text" id="weather-default-location" class="form-input" placeholder="深圳" />
              </div>
              <div class="form-group">
                <label>wttr Base URL</label>
                <input type="text" id="weather-wttr-base-url" class="form-input" placeholder="https://wttr.in" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Request Timeout (ms)</label>
                <input type="number" id="weather-request-timeout-ms" class="form-input" min="1" />
              </div>
              <div class="form-group">
                <label>Cache TTL (ms)</label>
                <input type="number" id="weather-cache-ttl-ms" class="form-input" min="0" />
              </div>
            </div>
          </div>
        </div>

        <!-- Skills tab -->
        <div class="config-content" id="settings-tab-skills">
          <div class="form-section">
            <h3 class="form-section-title">Skills</h3>
            <div class="form-group">
              <label class="checkbox-label">
                <input type="checkbox" id="settings-skills-enabled" />
                <span>Enable Skills</span>
              </label>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>User Directory</label>
                <input type="text" id="settings-skills-user-dir" class="form-input" placeholder="~/.vex/skills" />
              </div>
              <div class="form-group">
                <label>Workspace Directory</label>
                <input type="text" id="settings-skills-workspace-dir" class="form-input" placeholder="./.vex/skills" />
              </div>
            </div>
            <div class="form-group">
              <label>Disabled Skills (comma-separated)</label>
              <input type="text" id="settings-skills-disabled" class="form-input" placeholder="skill-a, skill-b" />
            </div>
            <div class="form-group">
              <label>Only Skills (comma-separated, overrides disabled)</label>
              <input type="text" id="settings-skills-only" class="form-input" placeholder="skill-c" />
            </div>
          </div>
        </div>

        <!-- Sessions tab -->
        <div class="config-content" id="settings-tab-sessions">
          <div class="form-section">
            <h3 class="form-section-title">Sessions Store</h3>
            <div class="form-group">
              <label>Store Type</label>
              <select id="sessions-type" class="form-input">
                <option value="memory">memory</option>
                <option value="file">file</option>
              </select>
              <p class="form-hint">Changing the store type requires a restart to take effect</p>
            </div>
            <div class="form-group">
              <label>Directory (file store)</label>
              <input type="text" id="sessions-directory" class="form-input" placeholder="~/.vex/sessions" />
            </div>
            <div class="form-group">
              <label>Session TTL (ms)</label>
              <input type="number" id="sessions-ttl-ms" class="form-input" min="0" />
            </div>
          </div>
        </div>

        <!-- Geek / Raw YAML tab -->
        <div class="config-content" id="settings-tab-geek">
          <div class="form-section">
            <h3 class="form-section-title">Raw YAML Editor</h3>
            <p class="form-hint">Edit arbitrary config as YAML. On save, this patch is merged last and overrides form fields above. Top-level must be a mapping.</p>
            <div class="form-group">
              <label>YAML Patch</label>
              <textarea id="settings-raw-yaml" class="form-input raw-json-editor" rows="18" spellcheck="false" placeholder="persona:
  persona_name: Geek"></textarea>
              <p id="settings-raw-error" class="form-hint" style="color: var(--error);"></p>
            </div>
            <button class="btn btn-secondary" onclick="validateRawYaml()">Validate YAML</button>
          </div>
        </div>

        <!-- Settings save result -->
        <div id="settings-save-result" class="save-result"></div>
      </div>

      <!-- Logs view -->
      <div class="view" id="view-logs">
        <div class="page-header">
          <h1 class="page-title">System Logs</h1>
          <p class="page-desc">View real-time system runtime logs</p>
        </div>
        <div class="log-toolbar">
          <select id="log-level-filter" class="form-input">
            <option value="debug">Debug+</option>
            <option value="info" selected>Info+</option>
            <option value="warn">Warn+</option>
            <option value="error">Error</option>
          </select>
          <input type="text" id="log-module-filter" class="form-input" placeholder="Filter by module" />
          <button id="log-pause-btn" class="btn btn-secondary" onclick="toggleLogPause()">Pause</button>
          <button id="log-clear-btn" class="btn btn-secondary" onclick="clearLogs()">Clear</button>
        </div>
        <div class="log-container" id="log-container">
          <div class="log-entry info"><span class="time">[--:--:--]</span> Waiting for connection...</div>
        </div>
      </div>
    </main>
  </div>

  <!-- Add Provider Modal -->
  <div class="modal-overlay" id="add-provider-modal">
    <div class="modal">
      <div class="modal-header">
        <h3>Add Provider</h3>
        <button class="modal-close" onclick="hideAddProviderModal()">&times;</button>
      </div>
      <div class="form-group">
        <label>Provider Type</label>
        <select id="new-provider-type" class="form-input" onchange="updateProviderModalFields()">
          <option value="deepseek">DeepSeek</option>
          <option value="doubao">Doubao</option>
          <option value="minimax">MiniMax</option>
          <option value="kimi">Kimi</option>
          <option value="stepfun">StepFun</option>
          <option value="modelscope">ModelScope</option>
          <option value="dashscope">DashScope (Qwen)</option>
          <option value="zhipu">Zhipu AI</option>
          <option value="longcat">LongCat</option>
          <option value="openai">OpenAI</option>
          <option value="ollama">Ollama</option>
          <option value="openrouter">OpenRouter</option>
          <option value="together">Together AI</option>
          <option value="groq">Groq</option>
          <option value="custom-openai">Custom OpenAI</option>
          <option value="custom-anthropic">Custom Anthropic</option>
        </select>
      </div>
      <div class="form-group" id="new-provider-base-url-group" style="display:none;">
        <label>Base URL</label>
        <input type="text" id="new-provider-base-url" class="form-input" placeholder="e.g. https://api.openai.com/v1" />
      </div>
      <div class="form-group" id="new-provider-name-group" style="display:none;">
        <label>Display Name</label>
        <input type="text" id="new-provider-name" class="form-input" placeholder="e.g. My OpenAI" />
      </div>
      <div class="form-group" id="new-provider-group-id-group" style="display:none;">
        <label>Group ID (MiniMax)</label>
        <input type="text" id="new-provider-group-id" class="form-input" placeholder="Group ID" />
      </div>
      <div class="form-group">
        <label>API Key</label>
        <input type="password" id="new-provider-api-key" class="form-input" placeholder="Enter API Key" />
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="hideAddProviderModal()">Cancel</button>
        <button class="btn btn-primary" onclick="addProvider()">Add</button>
      </div>
    </div>
  </div>

  <script>
${I18N_CLIENT_JS}
${CONTROL_CLIENT_JS}
  </script>
</body>
</html>`;
}

/** Static file service options */
export interface StaticServerOptions {
  config: VexConfig;
}

/** Handle static file request */
export function handleStaticRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: StaticServerOptions
): boolean {
  const url = req.url || "/";
  const pathname = url.split("?")[0] || "/";

  // Skip WebSocket path
  if (pathname === "/ws") {
    return false;
  }

  // Skip API path
  if (pathname.startsWith("/api/") || pathname.startsWith("/webhook/")) {
    return false;
  }

  // Skip health check
  if (pathname === "/health") {
    return false;
  }

  // Control UI
  if (pathname === "/control" || pathname === "/control/") {
    const html = getControlHtml(options.config);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
    });
    res.end(html);
    return true;
  }

  // Root path or index.html - return WebChat HTML
  if (pathname === "/" || pathname === "/index.html") {
    const html = getEmbeddedHtml(options.config);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
    });
    res.end(html);
    return true;
  }

  // Other static files - external files not yet supported
  // Can add file reading from public directory later

  return false;
}
