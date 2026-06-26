/**
 * Static file service and Control UI
 */

import { existsSync, readFileSync } from "fs";
import { join, extname } from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { getChildLogger } from "../utils/logger.js";
import type { VexConfig } from "../types/index.js";

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
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --bg: #f9fafb;
      --bg-card: #ffffff;
      --text: #111827;
      --text-secondary: #6b7280;
      --border: #e5e7eb;
      --user-bg: #4f46e5;
      --assistant-bg: #f3f4f6;
      --sidebar-width: 280px;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      height: 100vh;
      display: flex;
    }
    /* Sidebar */
    .sidebar {
      width: var(--sidebar-width);
      background: var(--bg-card);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .sidebar-header {
      padding: 1rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .sidebar-logo { font-size: 1.5rem; }
    .sidebar-title { font-weight: 600; font-size: 1.125rem; }
    .new-chat-btn {
      margin: 1rem;
      padding: 0.75rem 1rem;
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      transition: background 0.2s;
    }
    .new-chat-btn:hover { background: var(--primary-hover); }
    .session-list {
      flex: 1;
      overflow-y: auto;
      padding: 0.5rem;
    }
    .session-item {
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.25rem;
      transition: background 0.15s;
    }
    .session-item:hover { background: var(--bg); }
    .session-item.active { background: #eef2ff; }
    .session-icon { font-size: 1rem; opacity: 0.7; }
    .session-info { flex: 1; min-width: 0; }
    .session-title {
      font-size: 0.875rem;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .session-meta {
      font-size: 0.75rem;
      color: var(--text-secondary);
      display: flex;
      gap: 0.5rem;
    }
    .session-delete {
      opacity: 0;
      padding: 0.25rem;
      border: none;
      background: none;
      cursor: pointer;
      font-size: 0.875rem;
      color: var(--text-secondary);
      border-radius: 0.25rem;
    }
    .session-item:hover .session-delete { opacity: 1; }
    .session-delete:hover { background: #fee2e2; color: #dc2626; }
    .sidebar-footer {
      padding: 0.75rem 1rem;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }
    /* Main content area */
    .main-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .header {
      background: var(--bg-card);
      border-bottom: 1px solid var(--border);
      padding: 1rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .header-left { display: flex; align-items: center; gap: 0.75rem; }
    .menu-btn {
      display: none;
      padding: 0.5rem;
      border: none;
      background: none;
      cursor: pointer;
      font-size: 1.25rem;
    }
    .title { font-size: 1.25rem; font-weight: 600; }
    .subtitle { font-size: 0.75rem; color: var(--text-secondary); }
    .status { display: flex; align-items: center; gap: 0.5rem; font-size: 0.875rem; color: var(--text-secondary); }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; }
    .status-dot.disconnected { background: #ef4444; }
    .main { flex: 1; display: flex; flex-direction: column; max-width: 900px; width: 100%; margin: 0 auto; padding: 1rem; overflow: hidden; }
    .messages { flex: 1; overflow-y: auto; padding: 1rem 0; display: flex; flex-direction: column; gap: 1rem; }
    .message { display: flex; gap: 0.75rem; max-width: 85%; }
    .message.user { align-self: flex-end; flex-direction: row-reverse; }
    .message-avatar { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1rem; flex-shrink: 0; }
    .message.user .message-avatar { background: var(--user-bg); color: white; }
    .message.assistant .message-avatar { background: var(--assistant-bg); }
    .message-content { padding: 0.75rem 1rem; border-radius: 1rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    .message.user .message-content { background: var(--user-bg); color: white; border-bottom-right-radius: 0.25rem; }
    .message.assistant .message-content { background: var(--assistant-bg); border-bottom-left-radius: 0.25rem; }
    .message-content code { background: rgba(0, 0, 0, 0.1); padding: 0.125rem 0.375rem; border-radius: 0.25rem; font-family: "SF Mono", Monaco, monospace; font-size: 0.875em; }
    .message.user .message-content code { background: rgba(255, 255, 255, 0.2); }
    .message-content pre { background: rgba(0, 0, 0, 0.05); padding: 0.75rem; border-radius: 0.5rem; overflow-x: auto; margin: 0.5rem 0; }
    .message.user .message-content pre { background: rgba(255, 255, 255, 0.1); }
    .typing { display: flex; gap: 0.25rem; padding: 0.5rem; }
    .typing span { width: 8px; height: 8px; background: var(--text-secondary); border-radius: 50%; animation: typing 1.4s infinite; }
    .typing span:nth-child(2) { animation-delay: 0.2s; }
    .typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typing { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-4px); } }
    .input-area { background: var(--bg-card); border: 1px solid var(--border); border-radius: 1rem; padding: 0.75rem; display: flex; gap: 0.75rem; align-items: flex-end; }
    .input-area textarea { flex: 1; border: none; outline: none; resize: none; font-size: 1rem; line-height: 1.5; max-height: 150px; font-family: inherit; background: transparent; }
    .input-area button { background: var(--primary); color: white; border: none; border-radius: 0.5rem; padding: 0.5rem 1rem; font-size: 0.875rem; font-weight: 500; cursor: pointer; transition: background 0.2s; display: flex; align-items: center; gap: 0.375rem; }
    .input-area button:hover { background: var(--primary-hover); }
    .input-area button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-icon { background: transparent !important; color: var(--text-secondary) !important; padding: 0.5rem !important; }
    .btn-icon:hover { color: var(--text) !important; background: var(--bg) !important; }
    .cancel-btn { background: var(--border) !important; color: var(--text) !important; }
    .cancel-btn:hover { background: var(--text-secondary) !important; color: white !important; }
    .cancelled-hint { color: var(--text-secondary); margin-top: 0.5rem; font-size: 0.875rem; }
    .welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 1rem; color: var(--text-secondary); }
    .welcome-icon { font-size: 4rem; }
    .welcome h2 { color: var(--text); font-size: 1.5rem; }
    .welcome p { max-width: 400px; }
    .features { display: flex; gap: 1rem; margin-top: 1rem; flex-wrap: wrap; justify-content: center; }
    .feature { background: var(--bg-card); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1rem; width: 140px; text-align: center; }
    .feature-icon { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .feature-text { font-size: 0.875rem; color: var(--text); }
    /* Markdown styles */
    .message-content.markdown { white-space: normal; }
    .message-content.markdown h1, .message-content.markdown h2, .message-content.markdown h3, .message-content.markdown h4 { margin: 0.75em 0 0.5em 0; font-weight: 600; line-height: 1.3; }
    .message-content.markdown h1 { font-size: 1.4em; }
    .message-content.markdown h2 { font-size: 1.25em; }
    .message-content.markdown h3 { font-size: 1.1em; }
    .message-content.markdown p { margin: 0.5em 0; }
    .message-content.markdown ul, .message-content.markdown ol { margin: 0.5em 0; padding-left: 1.5em; }
    .message-content.markdown li { margin: 0.25em 0; }
    .message-content.markdown pre { background: #1e1e1e; color: #d4d4d4; padding: 1em; border-radius: 0.5em; overflow-x: auto; margin: 0.75em 0; font-family: "SF Mono", Monaco, Consolas, monospace; font-size: 0.9em; line-height: 1.4; }
    .message-content.markdown pre code { background: none; padding: 0; color: inherit; font-size: inherit; }
    .message-content.markdown code { background: rgba(0, 0, 0, 0.08); padding: 0.15em 0.4em; border-radius: 0.25em; font-family: "SF Mono", Monaco, Consolas, monospace; font-size: 0.9em; }
    .message.user .message-content.markdown code { background: rgba(255, 255, 255, 0.15); }
    .message-content.markdown table { border-collapse: collapse; margin: 0.75em 0; width: 100%; font-size: 0.9em; }
    .message-content.markdown th, .message-content.markdown td { border: 1px solid var(--border); padding: 0.5em 0.75em; text-align: left; }
    .message-content.markdown th { background: rgba(0, 0, 0, 0.04); font-weight: 600; }
    .message-content.markdown blockquote { border-left: 3px solid var(--primary); margin: 0.75em 0; padding: 0.5em 1em; background: rgba(0, 0, 0, 0.03); }
    .message-content.markdown hr { border: none; border-top: 1px solid var(--border); margin: 1em 0; }
    .message-content.markdown a { color: var(--primary); text-decoration: none; }
    .message-content.markdown a:hover { text-decoration: underline; }
    .message-content.markdown strong { font-weight: 600; }
    .message-content.markdown em { font-style: italic; }
    /* Responsive */
    @media (max-width: 768px) {
      .sidebar { position: fixed; left: -100%; top: 0; bottom: 0; z-index: 100; transition: left 0.3s; }
      .sidebar.open { left: 0; }
      .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 99; }
      .sidebar.open + .sidebar-overlay { display: block; }
      .menu-btn { display: block; }
      .message { max-width: 95%; }
    }
    .empty-sessions { padding: 2rem 1rem; text-align: center; color: var(--text-secondary); font-size: 0.875rem; }
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
    const MASCOT_AVATAR = \`${MASCOT_SVG_SMALL}\`;
    let ws = null;
    let reconnectTimer = null;
    let pendingRequests = new Map();
    let requestId = 0;
    let isStreaming = false;
    let currentStreamContent = '';
    let currentSessionKey = null;
    let sessionRestored = false;
    let allSessions = [];

    const STORAGE_KEY = 'vex_session_key';

    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const menuBtn = document.getElementById('menuBtn');
    const sessionList = document.getElementById('sessionList');
    const sessionCount = document.getElementById('sessionCount');
    const newChatBtn = document.getElementById('newChatBtn');
    const messagesEl = document.getElementById('messages');
    const welcomeEl = document.getElementById('welcome');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('sendBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const clearBtn = document.getElementById('clearBtn');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');

    function getSavedSessionKey() { return localStorage.getItem(STORAGE_KEY); }
    function saveSessionKey(sessionKey) { localStorage.setItem(STORAGE_KEY, sessionKey); currentSessionKey = sessionKey; }

    function toggleSidebar() {
      sidebar.classList.toggle('open');
    }

    menuBtn.addEventListener('click', toggleSidebar);
    sidebarOverlay.addEventListener('click', toggleSidebar);

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '/ws');

      ws.onopen = () => {
        statusDot.classList.remove('disconnected');
        statusText.textContent = 'Connected';
        sessionRestored = false;
        // Note: don't load data here; wait for the connected event from the server
      };

      ws.onclose = () => {
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Disconnected';
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = (err) => { console.error('WebSocket error:', err); };
      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data);
          handleFrame(frame);
        } catch (e) { console.error('Failed to parse message:', e); }
      };
    }

    async function restoreSession(sessionKey) {
      try {
        const result = await request('sessions.restore', { sessionKey });
        sessionRestored = true;
        if (result && result.sessionKey) {
          saveSessionKey(result.sessionKey);
        }
        if (result && result.messages && result.messages.length > 0) {
          loadHistoryMessages(result.messages);
        }
        updateSessionListActive();
      } catch (e) {
        console.log('No previous session found, starting fresh');
        localStorage.removeItem(STORAGE_KEY);
        sessionRestored = true;
      }
    }

    async function loadSessionList() {
      try {
        const result = await request('sessions.list', { limit: 50 });
        allSessions = result.sessions || [];
        renderSessionList();
      } catch (e) { console.error('Failed to load sessions:', e); }
    }

    function renderSessionList() {
      // Filter out sessions with no messages
      const sessionsWithMessages = allSessions.filter(s => (s.messageCount || 0) > 0);

      if (sessionsWithMessages.length === 0) {
        sessionList.innerHTML = '<div class="empty-sessions">No recent sessions</div>';
        sessionCount.textContent = '0 sessions';
        return;
      }

      sessionCount.textContent = sessionsWithMessages.length + ' sessions';
      const currentKey = getSavedSessionKey();

      sessionList.innerHTML = sessionsWithMessages.map(s => {
        const isActive = s.sessionKey === currentKey;
        const title = s.label || s.sessionKey.replace(/^webchat:/, '').slice(0, 12) + '...';
        const time = new Date(s.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
        const msgCount = s.messageCount || 0;
        return \`
          <div class="session-item \${isActive ? 'active' : ''}" data-key="\${s.sessionKey}">
            <span class="session-icon">💬</span>
            <div class="session-info">
              <div class="session-title">\${escapeHtml(title)}</div>
              <div class="session-meta"><span>\${msgCount} messages</span><span>\${time}</span></div>
            </div>
            <button class="session-delete" data-key="\${s.sessionKey}" title="Delete">🗑️</button>
          </div>
        \`;
      }).join('');

      sessionList.querySelectorAll('.session-item').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.classList.contains('session-delete')) return;
          switchToSession(el.dataset.key);
        });
      });

      sessionList.querySelectorAll('.session-delete').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteSession(el.dataset.key);
        });
      });
    }

    function updateSessionListActive() {
      const currentKey = getSavedSessionKey();
      sessionList.querySelectorAll('.session-item').forEach(el => {
        el.classList.toggle('active', el.dataset.key === currentKey);
      });
    }

    async function switchToSession(sessionKey) {
      if (isStreaming) return;
      clearMessagesUI();
      saveSessionKey(sessionKey);
      try {
        const result = await request('sessions.restore', { sessionKey });
        if (result && result.messages && result.messages.length > 0) {
          loadHistoryMessages(result.messages);
        }
        updateSessionListActive();
        if (window.innerWidth <= 768) toggleSidebar();
      } catch (e) {
        console.error('Failed to switch session:', e);
      }
    }

    async function deleteSession(sessionKey) {
      if (!confirm('Are you sure you want to delete this session?')) return;
      try {
        await request('sessions.delete', { sessionKey });
        if (getSavedSessionKey() === sessionKey) {
          localStorage.removeItem(STORAGE_KEY);
          clearMessagesUI();
          showWelcome();
        }
        loadSessionList();
      } catch (e) { console.error('Failed to delete session:', e); }
    }

    async function createNewChat() {
      if (isStreaming) return;
      // Tell the server to create a new session and clear Agent context
      try {
        const result = await request('chat.clear');
        // Don't save the returned sessionKey to localStorage
        // so the UI shows the welcome page instead of immediately binding to the new session
      } catch (e) {
        // Ignore error if there's no current session (server-side)
        console.log('Create new chat:', e.message);
      }
      localStorage.removeItem(STORAGE_KEY);
      clearMessagesUI();
      showWelcome();
      currentSessionKey = null;
      loadSessionList();
      if (window.innerWidth <= 768) toggleSidebar();
    }

    newChatBtn.addEventListener('click', createNewChat);

    function clearMessagesUI() {
      const msgs = messagesEl.querySelectorAll('.message');
      msgs.forEach(m => m.remove());
    }

    function showWelcome() {
      if (welcomeEl) welcomeEl.style.display = 'flex';
    }

    function loadHistoryMessages(messages) {
      if (!messages || messages.length === 0) return;
      if (welcomeEl) welcomeEl.style.display = 'none';
      for (const msg of messages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          addMessage(msg.role, content, false);
        }
      }
    }

    function handleFrame(frame) {
      if (frame.type === 'res') {
        const pending = pendingRequests.get(frame.id);
        if (pending) {
          pendingRequests.delete(frame.id);
          if (frame.ok) pending.resolve(frame.payload);
          else pending.reject(new Error(frame.error?.message || 'Unknown error'));
        }
      } else if (frame.type === 'event') {
        handleEvent(frame.event, frame.payload);
      }
    }

    function handleEvent(event, payload) {
      if (event === 'connected') {
        console.log('Connected, clientId:', payload.clientId);
        // Server is ready, now load data
        const savedSessionKey = getSavedSessionKey();
        if (savedSessionKey) {
          restoreSession(savedSessionKey);
        } else {
          // No saved session; server will auto-create on first message
          sessionRestored = true;
        }
        loadSessionList();
      } else if (event === 'chat.delta') {
        if (!isStreaming) {
          isStreaming = true;
          currentStreamContent = '';
          addMessage('assistant', '', true);
          sendBtn.style.display = 'none';
          cancelBtn.style.display = '';
        }
        if (payload.delta) {
          currentStreamContent += payload.delta;
          updateStreamingMessage(currentStreamContent);
        }
        if (payload.done) {
          isStreaming = false;
          sendBtn.style.display = '';
          cancelBtn.style.display = 'none';
          if (payload.cancelled && currentStreamContent.trim()) {
            const msgEl = document.getElementById('streaming-message');
            if (msgEl) {
              const contentEl = msgEl.querySelector('.message-content');
              if (contentEl) contentEl.innerHTML += '<p class="cancelled-hint"><em>(Cancelled)</em></p>';
            }
          }
          finalizeStreamingMessage();
          loadSessionList();
        }
      } else if (event === 'chat.error') {
        isStreaming = false;
        sendBtn.style.display = '';
        cancelBtn.style.display = 'none';
        addMessage('assistant', '❌ Error: ' + payload.error);
      }
    }

    function request(method, params) {
      return new Promise((resolve, reject) => {
        const id = String(++requestId);
        console.log(\`Sending request: \${method}, id: \${id}, params:\`, params);
        pendingRequests.set(id, { resolve, reject });
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'req', id, method, params }));
        } else {
          reject(new Error('WebSocket not connected'));
        }
      });
    }

    function renderContent(content, isAssistant = false) {
      if (isAssistant && typeof marked !== 'undefined') {
        marked.setOptions({ breaks: true, gfm: true });
        return sanitizeHtml(marked.parse(content));
      }
      return escapeHtml(content);
    }

    function sanitizeHtml(html) {
      const template = document.createElement('template');
      template.innerHTML = String(html);
      const blockedTags = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META']);
      const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach((node) => {
        if (blockedTags.has(node.tagName)) {
          node.remove();
          return;
        }
        [...node.attributes].forEach((attr) => {
          const name = attr.name.toLowerCase();
          const value = attr.value.trim().toLowerCase();
          if (name.startsWith('on') || ((name === 'href' || name === 'src') && value.startsWith('javascript:'))) {
            node.removeAttribute(attr.name);
          }
        });
      });
      return template.innerHTML;
    }

    function addMessage(role, content, streaming = false) {
      if (welcomeEl) welcomeEl.style.display = 'none';
      const msgEl = document.createElement('div');
      msgEl.className = 'message ' + role;
      if (streaming) msgEl.id = 'streaming-message';
      const avatar = role === 'user' ? '👤' : MASCOT_AVATAR;
      const isAssistant = role === 'assistant';
      const contentClass = isAssistant ? 'message-content markdown' : 'message-content';
      msgEl.innerHTML = \`<div class="message-avatar">\${avatar}</div><div class="\${contentClass}">\${streaming ? '<div class="typing"><span></span><span></span><span></span></div>' : renderContent(content, isAssistant)}</div>\`;
      messagesEl.appendChild(msgEl);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function updateStreamingMessage(content) {
      const msgEl = document.getElementById('streaming-message');
      if (msgEl) {
        const contentEl = msgEl.querySelector('.message-content');
        contentEl.innerHTML = renderContent(content, true);
        contentEl.classList.add('markdown');
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function finalizeStreamingMessage() {
      const msgEl = document.getElementById('streaming-message');
      if (msgEl) msgEl.removeAttribute('id');
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function cancelRequest() {
      if (!isStreaming) return;
      request('chat.cancel').catch(() => {});
      isStreaming = false;
      sendBtn.style.display = '';
      cancelBtn.style.display = 'none';
      const msgEl = document.getElementById('streaming-message');
      if (msgEl && currentStreamContent.trim()) {
        const contentEl = msgEl.querySelector('.message-content');
        if (contentEl) contentEl.innerHTML += '<p class="cancelled-hint"><em>(Cancelled)</em></p>';
      }
      finalizeStreamingMessage();
      loadSessionList();
    }

    async function sendMessage() {
      const message = inputEl.value.trim();
      if (!message || isStreaming) return;
      inputEl.value = '';
      inputEl.style.height = 'auto';
      addMessage('user', message);
      try {
        await request('chat.send', { message });
      } catch (e) {
        addMessage('assistant', '❌ Send failed: ' + e.message);
      }
    }

    async function clearChat() {
      if (isStreaming) return;
      try {
        const result = await request('chat.clear');
        if (result && result.sessionKey) saveSessionKey(result.sessionKey);
        clearMessagesUI();
        showWelcome();
        loadSessionList();
      } catch (e) { console.error('Failed to clear:', e); }
    }

    function autoResize() {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
    }

    sendBtn.addEventListener('click', sendMessage);
    cancelBtn.addEventListener('click', cancelRequest);
    clearBtn.addEventListener('click', clearChat);
    inputEl.addEventListener('input', autoResize);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancelRequest(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isStreaming) { e.preventDefault(); cancelRequest(); }
    });

    connect();
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
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --bg: #f1f5f9;
      --bg-card: #ffffff;
      --text: #1e293b;
      --text-secondary: #64748b;
      --border: #e2e8f0;
      --success: #22c55e;
      --warning: #f59e0b;
      --error: #ef4444;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    .layout {
      display: flex;
      min-height: 100vh;
    }
    /* Sidebar */
    .sidebar {
      width: 240px;
      background: var(--bg-card);
      border-right: 1px solid var(--border);
      padding: 1.5rem 0;
      display: flex;
      flex-direction: column;
    }
    .sidebar-header {
      padding: 0 1.5rem 1.5rem;
      border-bottom: 1px solid var(--border);
      margin-bottom: 1rem;
    }
    .sidebar-logo {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .sidebar-logo span:first-child { font-size: 1.75rem; }
    .sidebar-logo span:last-child { font-size: 1.25rem; font-weight: 600; }
    .nav-section {
      padding: 0.5rem 1rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1.5rem;
      color: var(--text-secondary);
      text-decoration: none;
      cursor: pointer;
      transition: all 0.15s;
    }
    .nav-item:hover { background: var(--bg); color: var(--text); }
    .nav-item.active { background: #eef2ff; color: var(--primary); font-weight: 500; }
    .nav-item-icon { font-size: 1.125rem; }
    /* Main content */
    .main-content {
      flex: 1;
      padding: 2rem;
      overflow-y: auto;
    }
    .page-header {
      margin-bottom: 2rem;
    }
    .page-title {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .page-desc {
      color: var(--text-secondary);
    }
    /* Cards */
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }
    .card {
      background: var(--bg-card);
      border-radius: 0.75rem;
      padding: 1.5rem;
      border: 1px solid var(--border);
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1rem;
    }
    .card-title {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-secondary);
    }
    .card-icon {
      font-size: 1.5rem;
    }
    .card-value {
      font-size: 2rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
    }
    .card-label {
      font-size: 0.875rem;
      color: var(--text-secondary);
    }
    /* Status indicator */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
    }
    .status-badge.online { background: #dcfce7; color: #166534; }
    .status-badge.offline { background: #fee2e2; color: #991b1b; }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    /* Table */
    .table-container {
      background: var(--bg-card);
      border-radius: 0.75rem;
      border: 1px solid var(--border);
      overflow: hidden;
    }
    .table-header {
      padding: 1rem 1.5rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .table-title {
      font-weight: 600;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 0.875rem 1.5rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th {
      background: var(--bg);
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--bg); }
    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.15s;
    }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-secondary { background: var(--bg); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--border); }
    .btn-danger { background: var(--error); color: white; }
    .btn-danger:hover { opacity: 0.9; }
    /* Hidden views */
    .view { display: none; }
    .view.active { display: block; }
    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }
    .empty-state-icon { font-size: 3rem; margin-bottom: 1rem; }
    /* Model cards */
    .model-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1rem 1.25rem;
    }
    .model-name { font-weight: 600; margin-bottom: 0.25rem; }
    .model-id { font-size: 0.75rem; color: var(--text-secondary); font-family: monospace; }
    .model-tags { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
    .model-tag {
      padding: 0.125rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      background: var(--bg);
      color: var(--text-secondary);
    }
    .model-tag.vision { background: #dbeafe; color: #1e40af; }
    .model-tag.reasoning { background: #fef3c7; color: #92400e; }
    /* Logs */
    .log-container {
      background: #1e293b;
      border-radius: 0.75rem;
      padding: 1rem;
      max-height: 400px;
      overflow-y: auto;
      font-family: "SF Mono", Monaco, monospace;
      font-size: 0.8125rem;
      line-height: 1.6;
    }
    .log-entry { color: #e2e8f0; }
    .log-entry.info { color: #38bdf8; }
    .log-entry.warn { color: #fbbf24; }
    .log-entry.error { color: #f87171; }
    .log-entry .time { color: #64748b; }
    /* Form styles */
    .config-tabs button {
      padding: 0.5rem 1rem;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-secondary);
      font-size: 0.875rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .config-tabs button:hover {
      color: var(--text);
      border-bottom-color: var(--border);
    }
    .config-tabs button.active {
      color: var(--primary);
      border-bottom-color: var(--primary);
      font-weight: 500;
    }
    .config-content { display: none; }
    .config-content.active { display: block; }
    .form-section {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.5rem;
    }
    .form-section-title {
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border);
    }
    .form-group {
      margin-bottom: 1rem;
    }
    .form-group label {
      display: block;
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 0.375rem;
    }
    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }
    .form-input {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-family: inherit;
      background: var(--bg);
      color: var(--text);
      transition: border-color 0.2s;
    }
    .form-input:focus {
      outline: none;
      border-color: var(--primary);
    }
    .form-input::placeholder {
      color: var(--text-muted);
    }
    .form-hint {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 0.5rem;
    }
    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;
      font-size: 0.875rem;
    }
    .checkbox-label input[type="checkbox"] {
      cursor: pointer;
    }
    /* Toggle switch */
    .toggle-switch {
      position: relative;
      width: 44px;
      height: 24px;
      margin: 0;
    }
    .toggle-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .toggle-slider {
      position: absolute;
      cursor: pointer;
      inset: 0;
      background: var(--border);
      border-radius: 24px;
      transition: background 0.2s;
    }
    .toggle-slider::before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background: white;
      border-radius: 50%;
      transition: transform 0.2s;
    }
    .toggle-switch input:checked + .toggle-slider {
      background: var(--primary);
    }
    .toggle-switch input:checked + .toggle-slider::before {
      transform: translateX(20px);
    }
    /* Provider grid */
    .providers-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 1rem;
    }
    .provider-form-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1rem;
    }
    .provider-form-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    .provider-form-header h4 {
      font-size: 0.875rem;
      font-weight: 600;
    }
    .provider-status-badge {
      padding: 0.125rem 0.5rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      background: var(--bg);
      color: var(--text-secondary);
    }
    .provider-status-badge.configured {
      background: #dcfce7;
      color: #166534;
    }
    .provider-actions button {
      padding: 0.25rem 0.5rem;
      font-size: 0.75rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      cursor: pointer;
    }
    .provider-actions button:hover {
      background: var(--border);
    }
    .provider-actions button.danger:hover {
      background: #fee2e2;
      color: #dc2626;
    }
    .channel-config-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1rem;
    }
    .channel-config-card .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    .channel-form-fields {
      display: grid;
      gap: 0.75rem;
    }
    .channel-form-fields input:not([type="checkbox"]) {
      margin-bottom: 0;
    }
    .channel-form-fields .checkbox-label {
      margin-top: 0.5rem;
    }
    /* Save result */
    .save-result {
      padding: 0.75rem;
      border-radius: 0.5rem;
      margin-top: 1rem;
      display: none;
    }
    .save-result.show {
      display: block;
    }
    .save-result.success {
      background: #dcfce7;
      color: #166534;
    }
    .save-result.error {
      background: #fee2e2;
      color: #dc2626;
    }
    .save-result.warning {
      background: #fef3c7;
      color: #92400e;
    }
    /* Modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal-overlay.show {
      display: flex;
    }
    .modal {
      background: var(--bg-card);
      border-radius: 0.75rem;
      padding: 1.5rem;
      max-width: 500px;
      width: 90%;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    .modal-header h3 {
      font-size: 1.125rem;
      font-weight: 600;
    }
    .modal-close {
      background: none;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      color: var(--text-muted);
    }
    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 1rem;
    }
    .channels-form-grid {
      display: grid;
      gap: 1rem;
    }
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
              <span class="card-title">Active Sessions</span>
              <span class="card-icon">👥</span>
            </div>
            <div class="card-value" id="session-count">0</div>
            <div class="card-label">Current connections</div>
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
            <span class="table-title">Active Sessions</span>
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

      <!-- Logs view -->
      <div class="view" id="view-logs">
        <div class="page-header">
          <h1 class="page-title">System Logs</h1>
          <p class="page-desc">View real-time system runtime logs</p>
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
    let ws = null;
    let pendingRequests = new Map();
    let requestId = 0;
    let systemStatus = null;

    // Navigation
    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-' + item.dataset.view).classList.add('active');

        // Auto-load config when switching to config page
        if (item.dataset.view === 'config' && ws?.readyState === WebSocket.OPEN) {
          loadConfig();
        }
      });
    });

    // WebSocket connection
    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '/ws');

      ws.onopen = () => {
        document.getElementById('connection-status').innerHTML =
          '<span class="status-badge online"><span class="status-dot"></span>Connected</span>';
        addLog('info', 'Connected to server');
        refreshStatus();
      };

      ws.onclose = () => {
        document.getElementById('connection-status').innerHTML =
          '<span class="status-badge offline"><span class="status-dot"></span>Disconnected</span>';
        addLog('warn', 'Connection lost, reconnecting...');
        setTimeout(connect, 3000);
      };

      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data);
          console.log('Received WebSocket message:', frame);
          if (frame.type === 'res') {
            const pending = pendingRequests.get(frame.id);
            if (pending) {
              pendingRequests.delete(frame.id);
              if (frame.ok) {
                console.log('Request succeeded:', frame.id, frame.payload);
                pending.resolve(frame.payload);
              } else {
                console.error('Request failed:', frame.id, frame.error);
                pending.reject(new Error(frame.error?.message || 'Unknown error'));
              }
            } else {
              console.warn('No pending request found:', frame.id);
            }
          }
        } catch (e) {
          console.error('Parse error:', e);
        }
      };
    }

    function request(method, params) {
      return new Promise((resolve, reject) => {
        const id = String(++requestId);
        pendingRequests.set(id, { resolve, reject });
        ws.send(JSON.stringify({ type: 'req', id, method, params }));
      });
    }

    async function refreshStatus() {
      try {
        systemStatus = await request('status.get');
        updateOverview(systemStatus);
        updateProviders(systemStatus);
        updateChannels(systemStatus);
        addLog('info', 'Status refreshed');
      } catch (e) {
        addLog('error', 'Failed to get status: ' + e.message);
      }
    }

    function updateOverview(status) {
      document.getElementById('version').textContent = status.version || '--';
      document.getElementById('session-count').textContent = status.sessions || 0;
      document.getElementById('provider-count').textContent = (status.providers || []).length + ' providers';
      document.getElementById('channel-count').textContent = (status.channels || []).length + ' channels';

      const uptime = status.uptime || 0;
      const hours = Math.floor(uptime / 3600000);
      const mins = Math.floor((uptime % 3600000) / 60000);
      document.getElementById('uptime').textContent = hours + 'h ' + mins + 'm';
    }

    function updateProviders(status) {
      const providers = status.providers || [];
      const container = document.getElementById('providers-list');

      if (providers.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🤖</div><p>No providers configured</p></div>';
        return;
      }

      container.innerHTML = providers.map(p => \`
        <div class="card">
          <div class="card-header">
            <span class="card-title">\${p.name || p.id}</span>
            <span class="status-badge \${p.available ? 'online' : 'offline'}">
              <span class="status-dot"></span>\${p.available ? 'Available' : 'Unavailable'}
            </span>
          </div>
          <div class="card-label">ID: \${p.id}</div>
        </div>
      \`).join('');
    }

    function updateChannels(status) {
      const channels = status.channels || [];
      const tbody = document.getElementById('channels-list');

      // Add WebChat
      const allChannels = [
        { id: 'webchat', name: 'WebChat', connected: true },
        ...channels
      ];

      tbody.innerHTML = allChannels.map(c => \`
        <tr>
          <td>\${c.name || c.id}</td>
          <td>
            <span class="status-badge \${c.connected ? 'online' : 'offline'}">
              <span class="status-dot"></span>\${c.connected ? 'Connected' : 'Disconnected'}
            </span>
          </td>
          <td>\${c.id}</td>
        </tr>
      \`).join('');
    }

    function refreshSessions() {
      // Session data retrieved via status
      addLog('info', 'Session list refreshed');
    }

    function addLog(level, message) {
      const container = document.getElementById('log-container');
      const time = new Date().toLocaleTimeString();
      const entry = document.createElement('div');
      entry.className = 'log-entry ' + level;
      entry.innerHTML = '<span class="time">[' + time + ']</span> ' + message;
      container.appendChild(entry);
      container.scrollTop = container.scrollHeight;

      // Limit log entries
      while (container.children.length > 100) {
        container.removeChild(container.firstChild);
      }
    }

    // ===== Configuration Management =====
    let currentConfig = null;
    let pendingProviders = {};  // Temporary provider data storage

    // Config tab switching
    document.querySelectorAll('.config-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.config-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.config-content').forEach(c => c.classList.remove('active'));
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Load config
    async function loadConfig() {
      try {
        console.log('Loading config...');
        if (ws?.readyState !== WebSocket.OPEN) {
          console.warn('WebSocket not connected, waiting...');
          // Wait for connection then load
          const waitConnection = new Promise(resolve => {
            const check = () => {
              if (ws?.readyState === WebSocket.OPEN) {
                resolve();
              } else {
                setTimeout(check, 500);
              }
            };
            check();
          });
          await waitConnection;
        }
        console.log('Sending config.get request...');
        currentConfig = await request('config.get');
        console.log('Config data received:', currentConfig);
        populateConfigForm(currentConfig);
        hideSaveResult();
        addLog('info', 'Config loaded');
      } catch (e) {
        console.error('Failed to load config:', e);
        addLog('error', 'Failed to load config: ' + e.message);
        showSaveResult('error', 'Failed to load config: ' + e.message);
      }
    }

    // Populate form
    function populateConfigForm(config) {
      console.log('populateConfigForm called, config:', config);

      // Agent config
      if (config.agent) {
        const providerSelect = document.getElementById('agent-provider');
        if (providerSelect) {
          providerSelect.value = config.agent.defaultProvider || 'deepseek';
          console.log('Set provider value:', providerSelect.value);
        }
        document.getElementById('agent-model').value = config.agent.defaultModel || '';
        document.getElementById('agent-temperature').value = config.agent.temperature || '';
        document.getElementById('agent-max-tokens').value = config.agent.maxTokens || '';
        document.getElementById('agent-system-prompt').value = config.agent.systemPrompt || '';
      }

      // Provider list
      populateProvidersForm(config.providers);

      // Channels config
      if (config.channels) {
        populateChannelsForm(config.channels);
      }

      // Server config
      if (config.server) {
        document.getElementById('server-port').value = config.server.port || 3000;
        document.getElementById('server-host').value = config.server.host || '0.0.0.0';
      }

      // Logging config
      if (config.logging) {
        document.getElementById('logging-level').value = config.logging.level || 'info';
      }

      // Memory config
      if (config.memory) {
        document.getElementById('memory-enabled').checked = config.memory.enabled !== false;
        document.getElementById('memory-directory').value = config.memory.directory || '';
      }
    }

    // Populate provider list
    function populateProvidersForm(providers) {
      const container = document.getElementById('providers-list-form');
      if (!providers || Object.keys(providers).length === 0) {
        container.innerHTML = '<div style="grid-column:1/-1;padding:2rem;text-align:center;color:var(--text-muted);">No providers configured</div>';
        return;
      }

      container.innerHTML = Object.entries(providers).map(([id, p]) => \`
        <div class="provider-form-card" data-provider-id="\${id}">
          <div class="provider-form-header">
            <h4>\${p.name || id}</h4>
            <span class="provider-status-badge \${p.hasApiKey ? 'configured' : ''}">
              \${p.hasApiKey ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <div class="provider-actions">
            <button onclick="editProvider('\${id}')">Edit</button>
            <button class="danger" onclick="removeProvider('\${id}')">Delete</button>
          </div>
        </div>
      \`).join('');
    }

    // Populate channels config
    function populateChannelsForm(channels) {
      document.getElementById('weixin-enabled').checked = false;
      document.getElementById('weixin-bot-type').value = '';
      document.getElementById('weixin-base-url').value = '';
      document.getElementById('weixin-status').textContent = 'Status: Not logged in';

      const weixin = channels.weixin;
      if (weixin) {
        const hasConfig = weixin.hasToken;
        document.getElementById('weixin-enabled').checked = hasConfig && weixin.enabled !== false;
        document.getElementById('weixin-bot-type').value = weixin.botType || '';
        document.getElementById('weixin-base-url').value = weixin.baseUrl || '';
        document.getElementById('weixin-status').textContent = weixin.hasToken
          ? 'Status: Logged in (Token valid)'
          : 'Status: Not logged in (scan QR in terminal or restart to auto-login)';
        if (weixin.hasToken) {
          document.getElementById('weixin-status').style.color = '#10b981';
        } else {
          document.getElementById('weixin-status').style.color = '#f59e0b';
        }
      }

    // Show add provider modal
    function showAddProviderModal() {
      document.getElementById('add-provider-modal').classList.add('show');
      updateProviderModalFields();
    }

    // Hide add provider modal
    function hideAddProviderModal() {
      document.getElementById('add-provider-modal').classList.remove('show');
      // Clear form
      document.getElementById('new-provider-api-key').value = '';
      document.getElementById('new-provider-base-url').value = '';
      document.getElementById('new-provider-name').value = '';
      document.getElementById('new-provider-group-id').value = '';
    }

    // Update provider modal field visibility
    function updateProviderModalFields() {
      const type = document.getElementById('new-provider-type').value;
      const baseUrlGroup = document.getElementById('new-provider-base-url-group');
      const nameGroup = document.getElementById('new-provider-name-group');
      const groupIdGroup = document.getElementById('new-provider-group-id-group');

      baseUrlGroup.style.display = (type === 'custom-openai' || type === 'custom-anthropic') ? 'block' : 'none';
      nameGroup.style.display = (type === 'custom-openai' || type === 'custom-anthropic') ? 'block' : 'none';
      groupIdGroup.style.display = type === 'minimax' ? 'block' : 'none';
    }

    // Add Provider
    function addProvider() {
      const type = document.getElementById('new-provider-type').value;
      const apiKey = document.getElementById('new-provider-api-key').value.trim();
      const baseUrl = document.getElementById('new-provider-base-url').value.trim();
      const name = document.getElementById('new-provider-name').value.trim();
      const groupId = document.getElementById('new-provider-group-id').value.trim();

      if (!apiKey) {
        alert('Please enter API Key');
        return;
      }

      if ((type === 'custom-openai' || type === 'custom-anthropic') && !baseUrl) {
        alert('Please enter Base URL');
        return;
      }

      // Save to pendingProviders, including apiKey
      pendingProviders[type] = {
        id: type,
        name: name || undefined,
        baseUrl: baseUrl || undefined,
        groupId: groupId || undefined,
        hasApiKey: true,
        apiKey: apiKey  // Save apiKey
      };

      hideAddProviderModal();
      // Refresh provider list display
      if (currentConfig) {
        const mergedProviders = { ...currentConfig.providers, ...pendingProviders };
        populateProvidersForm(mergedProviders);
      }

      showSaveResult('success', 'Provider added (click Save to apply changes)');
    }

    // Edit provider
    function editProvider(id) {
      const provider = currentConfig?.providers[id];
      if (!provider) return;

      const apiKey = prompt('Enter new API Key (leave blank to keep current):');
      if (apiKey === null) return;

      if (apiKey) {
        pendingProviders[id] = {
          ...provider,
          hasApiKey: true,
          apiKey: apiKey  // Save new apiKey
        };
        showSaveResult('success', 'Provider updated (click Save to apply changes)');
      }
    }

    // Remove provider
    function removeProvider(id) {
      if (!confirm('Are you sure you want to remove this provider?')) return;

      pendingProviders[id] = { id: id, hasApiKey: false };
      const mergedProviders = { ...currentConfig.providers };
      delete mergedProviders[id];
      populateProvidersForm(mergedProviders);

      showSaveResult('success', 'Provider removed (click Save to apply changes)');
    }

    // Save all config
    async function saveAllConfig() {
      try {
        hideSaveResult();

        // Build config object
        const configToSave = {};

        // Agent config
        const agentProvider = document.getElementById('agent-provider').value;
        const agentModel = document.getElementById('agent-model').value.trim();
        const agentTemperatureStr = document.getElementById('agent-temperature').value;
        const agentMaxTokensStr = document.getElementById('agent-max-tokens').value;
        const agentSystemPrompt = document.getElementById('agent-system-prompt').value.trim();

        // Only save if any field differs from current config
        const currentAgent = currentConfig && currentConfig.agent ? currentConfig.agent : {};
        const agentChanged =
          agentProvider !== (currentAgent.defaultProvider || '') ||
          agentModel !== (currentAgent.defaultModel || '') ||
          agentTemperatureStr !== String(currentAgent.temperature || '') ||
          agentMaxTokensStr !== String(currentAgent.maxTokens || '') ||
          agentSystemPrompt !== (currentAgent.systemPrompt || '');

        const agentTemperature = parseFloat(agentTemperatureStr);
        const agentMaxTokens = parseInt(agentMaxTokensStr, 10);

        if (agentChanged || agentModel || agentSystemPrompt || !isNaN(agentTemperature) || !isNaN(agentMaxTokens)) {
          configToSave.agent = {
            defaultProvider: agentProvider || currentAgent.defaultProvider || 'deepseek',
            defaultModel: agentModel || currentAgent.defaultModel || '',
            ...(agentTemperature >= 0 && { temperature: agentTemperature }),
            ...(agentMaxTokens > 0 && { maxTokens: agentMaxTokens }),
            ...(agentSystemPrompt && { systemPrompt: agentSystemPrompt })
          };
        }

        // Provider config
        if (Object.keys(pendingProviders).length > 0) {
          configToSave.providers = pendingProviders;
        }

        // Channels config
        const channels = {};

        const weixinEnabled = document.getElementById('weixin-enabled').checked;
        const weixinBotType = document.getElementById('weixin-bot-type').value.trim();
        const weixinBaseUrl = document.getElementById('weixin-base-url').value.trim();
        const weixinHasConfig = weixinEnabled || weixinBotType || weixinBaseUrl;
        if (weixinHasConfig) {
          channels.weixin = {
            hasConfig: true,
            enabled: weixinEnabled,
            ...(weixinBotType && { botType: weixinBotType }),
            ...(weixinBaseUrl && { baseUrl: weixinBaseUrl })
          };
        } else {
          channels.weixin = { hasConfig: false };
        }

        if (Object.keys(channels).length > 0) {
          configToSave.channels = channels;
        }

        // Server config
        const serverPortStr = document.getElementById('server-port').value;
        const serverPort = parseInt(serverPortStr, 10);
        const serverHost = document.getElementById('server-host').value.trim();

        // Check if config changed
        const currentServer = currentConfig && currentConfig.server ? currentConfig.server : {};
        const serverChanged =
          serverPortStr !== String(currentServer.port || '3000') ||
          serverHost !== (currentServer.host || '0.0.0.0');

        if ((serverPort > 0 && serverPort <= 65535 && serverHost) || serverChanged) {
          configToSave.server = {
            port: serverPort > 0 ? serverPort : currentServer.port || 3000,
            host: serverHost || currentServer.host || '0.0.0.0'
          };
        }

        // Logging config
        const logLevel = document.getElementById('logging-level').value;
        const currentLogging = currentConfig && currentConfig.logging ? currentConfig.logging : {};
        const logLevelChanged = logLevel !== (currentLogging.level || 'info');
        if (logLevelChanged) {
          configToSave.logging = { level: logLevel };
        }

        // Memory config
        const memoryEnabled = document.getElementById('memory-enabled').checked;
        const memoryDir = document.getElementById('memory-directory').value.trim();
        const currentMemory = currentConfig && currentConfig.memory ? currentConfig.memory : {};
        const memoryChanged =
          memoryEnabled !== (currentMemory.enabled || false) ||
          memoryDir !== (currentMemory.directory || '');

        if (memoryChanged) {
          configToSave.memory = {
            enabled: memoryEnabled,
            ...(memoryDir && { directory: memoryDir })
          };
        }

        // Save
        const result = await request('config.save', configToSave);

        if (result.success) {
          showSaveResult(result.requiresRestart ? 'warning' : 'success', result.message);
          // Clear pending
          pendingProviders = {};
          // Reload config
          await loadConfig();
          addLog('info', result.message);
        } else {
          showSaveResult('error', result.message || 'Save failed');
        }

      } catch (e) {
        addLog('error', 'Failed to save config: ' + e.message);
        showSaveResult('error', 'Failed to save config: ' + e.message);
      }
    }

    // Show save result
    function showSaveResult(type, message) {
      const resultEl = document.getElementById('save-result');
      resultEl.textContent = message;
      resultEl.className = 'save-result show ' + type;
      // Hide after 5 seconds
      setTimeout(() => {
        hideSaveResult();
      }, 5000);
    }

    // Hide save result
    function hideSaveResult() {
      const resultEl = document.getElementById('save-result');
      resultEl.className = 'save-result';
      resultEl.textContent = '';
    }

    // ===== WeChat QR Login =====
    let qrPollTimer = null;
    let currentQRCode = null;

    async function startWeixinQRLogin() {
      const btn = document.getElementById('weixin-qr-btn');
      const area = document.getElementById('weixin-qr-area');
      const img = document.getElementById('weixin-qr-img');
      const statusEl = document.getElementById('weixin-qr-status');

      btn.textContent = 'Getting QR code...';
      btn.disabled = true;

      try {
        const result = await request('weixin.qr', {});
        if (result.error) {
          btn.textContent = 'Scan QR Login';
          btn.disabled = false;
          alert(result.error);
          return;
        }

        currentQRCode = result.qrcode;
        img.src = result.qrcode_url;
        area.style.display = 'block';
        statusEl.textContent = 'Waiting for scan...';
        statusEl.style.color = '#f59e0b';
        btn.textContent = 'Refresh QR';
        btn.disabled = false;

        startQRPolling();
      } catch (e) {
        btn.textContent = 'Scan QR Login';
        btn.disabled = false;
        alert('Failed to get QR code: ' + e.message);
      }
    }

    function startQRPolling() {
      if (qrPollTimer) clearInterval(qrPollTimer);
      qrPollTimer = setInterval(async () => {
        if (!currentQRCode) return;
        try {
          const result = await request('weixin.qr.status', { qrcode: currentQRCode });
          const statusEl = document.getElementById('weixin-qr-status');
          statusEl.textContent = result.message;

          if (result.status === 'confirmed') {
            statusEl.style.color = '#10b981';
            clearInterval(qrPollTimer);
            qrPollTimer = null;
            currentQRCode = null;
            const btn = document.getElementById('weixin-qr-btn');
            btn.textContent = 'Logged in ✓';
            btn.disabled = true;
            document.getElementById('weixin-status').textContent = 'Status: Logged in (Token valid)';
            document.getElementById('weixin-status').style.color = '#10b981';
            alert('WeChat login successful! Click "Save All Changes" and restart the service.');
          } else if (result.status === 'expired') {
            statusEl.textContent = 'QR code expired, please refresh';
            statusEl.style.color = '#ef4444';
            clearInterval(qrPollTimer);
            qrPollTimer = null;
            currentQRCode = null;
            const btn = document.getElementById('weixin-qr-btn');
            btn.textContent = 'Refresh QR';
            btn.disabled = false;
          } else if (result.status === 'canceled' || result.status === 'denied') {
            statusEl.textContent = result.message;
            statusEl.style.color = '#ef4444';
            clearInterval(qrPollTimer);
            qrPollTimer = null;
            currentQRCode = null;
          }
        } catch (e) {
          console.error('QR poll error:', e);
        }
      }, 2000);
    }

    connect();
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
