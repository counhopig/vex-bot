/**
 * Client-side JavaScript template strings — extracted from static.ts
 *
 * NOTE: WEBCHAT_CLIENT_JS contains a literal \${MASCOT_SVG_SMALL} placeholder
 * that must be replaced with the actual MASCOT_SVG_SMALL value at the
 * call site in static.ts.
 */

export const WEBCHAT_CLIENT_JS: string = `    const MASCOT_AVATAR = \`\${MASCOT_SVG_SMALL}\`;
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
    const i18n = window.VexI18n;
    const t = (key, vars) => i18n.t(key, vars);
    const applyI18n = (root) => i18n.apply(root);

    function mountLanguageSwitcher(target) {
      if (!target || document.getElementById('languageSelect')) return;
      const select = document.createElement('select');
      select.id = 'languageSelect';
      select.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:4px 6px;background:var(--surface);color:var(--text);font-size:0.75rem;';
      select.innerHTML = '<option value="en">EN</option><option value="zh">中文</option>';
      select.value = i18n.getLang();
      select.addEventListener('change', () => {
        i18n.setLang(select.value);
        renderSessionList();
        applyI18n();
      });
      target.prepend(select);
    }

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
        statusText.textContent = t('Connected');
        sessionRestored = false;
        // Note: don't load data here; wait for the connected event from the server
      };

      ws.onclose = () => {
        statusDot.classList.add('disconnected');
        statusText.textContent = t('Disconnected');
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
        sessionList.innerHTML = '<div class="empty-sessions">' + t('No recent sessions') + '</div>';
        sessionCount.textContent = t('0 sessions');
        return;
      }

      sessionCount.textContent = sessionsWithMessages.length + ' ' + t('sessions');
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
              <div class="session-meta"><span>\${msgCount} \${t('messages')}</span><span>\${time}</span></div>
            </div>
            <button class="session-delete" data-key="\${s.sessionKey}" title="\${t('Delete')}">🗑️</button>
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
      if (!confirm(t('Are you sure you want to delete this session?'))) return;
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
      const { promise, resolve, reject } = Promise.withResolvers();
      const id = String(++requestId);
      console.log(\`Sending request: \${method}, id: \${id}, params:\`, params);
      pendingRequests.set(id, { resolve, reject });
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'req', id, method, params }));
      } else {
        reject(new Error('WebSocket not connected'));
      }
      return promise;
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

    mountLanguageSwitcher(document.querySelector('.sidebar-footer'));
    applyI18n();
    connect();
  `;

export const CONTROL_CLIENT_JS: string = `    let ws = null;
    let pendingRequests = new Map();
    let requestId = 0;
    let systemStatus = null;
    const i18n = window.VexI18n;
    const t = (key, vars) => i18n.t(key, vars);
    const applyI18n = (root) => i18n.apply(root);

    function mountLanguageSwitcher() {
      if (document.getElementById('controlLanguageSelect')) return;
      const sidebar = document.querySelector('.sidebar');
      const select = document.createElement('select');
      select.id = 'controlLanguageSelect';
      select.style.cssText = 'margin:0.75rem 1rem;border:1px solid var(--border);border-radius:6px;padding:6px;background:var(--bg);color:var(--text-primary);font-size:0.8125rem;';
      select.innerHTML = '<option value="en">English</option><option value="zh">中文</option>';
      select.value = i18n.getLang();
      select.addEventListener('change', () => {
        i18n.setLang(select.value);
        applyI18n();
        refreshStatus();
        if (currentConfig) populateConfigForm(currentConfig);
        if (currentSettings) populateSettingsForm(currentSettings);
      });
      sidebar?.appendChild(select);
    }

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
        // Auto-load settings when switching to settings page
        if (item.dataset.view === 'settings' && ws?.readyState === WebSocket.OPEN) {
          loadSettings();
        }
        if (item.dataset.view === 'sessions' && ws?.readyState === WebSocket.OPEN) {
          refreshSessions();
        }
        if ((item.dataset.view === 'providers' || item.dataset.view === 'channels') && ws?.readyState === WebSocket.OPEN) {
          refreshStatus();
        }
        // Stream backend logs only while the Logs view is open.
        if (item.dataset.view === 'logs') {
          subscribeLogs();
        } else {
          unsubscribeLogs();
        }
      });
    });

    // WebSocket connection
    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '/ws');

      ws.onopen = () => {
        document.getElementById('connection-status').innerHTML =
          '<span class="status-badge online"><span class="status-dot"></span>' + t('Connected') + '</span>';
        addLog('info', 'Connected to server');
        refreshStatus();
        // Re-subscribe to backend logs if the Logs view is currently open.
        if (document.getElementById('view-logs')?.classList.contains('active')) {
          logsSubscribed = false;
          subscribeLogs();
        }
      };

      ws.onclose = () => {
        document.getElementById('connection-status').innerHTML =
          '<span class="status-badge offline"><span class="status-dot"></span>' + t('Disconnected') + '</span>';
        addLog('warn', 'Connection lost, reconnecting...');
        logsSubscribed = false;
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
          } else if (frame.type === 'event') {
            if (frame.event === 'log.entry' && frame.payload) {
              onBackendLog(frame.payload);
            }
          }
        } catch (e) {
          console.error('Parse error:', e);
        }
      };
    }

    function request(method, params) {
      const { promise, resolve, reject } = Promise.withResolvers();
      const id = String(++requestId);
      pendingRequests.set(id, { resolve, reject });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
      return promise;
    }

    async function refreshStatus() {
      try {
        systemStatus = await request('status.get');
        updateOverview(systemStatus);
        updateProviders(systemStatus);
        updateChannels(systemStatus);
        refreshSessions();
        addLog('info', 'Status refreshed');
      } catch (e) {
        addLog('error', 'Failed to get status: ' + e.message);
      }
    }

    function updateOverview(status) {
      document.getElementById('version').textContent = status.version || '--';
      document.getElementById('session-count').textContent = status.sessions || 0;
      document.getElementById('provider-count').textContent = (status.providers || []).length + ' ' + t('providers');
      document.getElementById('channel-count').textContent = (status.channels || []).length + ' ' + t('channels');

      const uptime = status.uptime || 0;
      const hours = Math.floor(uptime / 3600000);
      const mins = Math.floor((uptime % 3600000) / 60000);
      document.getElementById('uptime').textContent = hours + 'h ' + mins + 'm';
    }

    function updateProviders(status) {
      const providers = status.providers || [];
      const container = document.getElementById('providers-list');

      if (providers.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🤖</div><p>' + t('No providers configured') + '</p></div>';
        return;
      }

      container.innerHTML = providers.map(p => \`
        <div class="card">
          <div class="card-header">
            <span class="card-title">\${p.name || p.id}</span>
            <span class="status-badge \${p.available ? 'online' : 'offline'}">
              <span class="status-dot"></span>\${p.available ? t('Available') : t('Unavailable')}
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
              <span class="status-dot"></span>\${c.connected ? t('Connected') : t('Disconnected')}
            </span>
          </td>
          <td>\${c.id}</td>
        </tr>
      \`).join('');
    }

    async function refreshSessions() {
      const tbody = document.getElementById('sessions-list');
      try {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">' + t('Loading sessions...') + '</td></tr>';
        const result = await request('sessions.list', { limit: 100 });
        const sessions = result.sessions || [];
        if (sessions.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty-state">' + t('No stored sessions') + '</td></tr>';
          return;
        }
        tbody.innerHTML = sessions.map(s => {
          const channel = s.sessionKey && s.sessionKey.includes(':') ? s.sessionKey.split(':')[0] : 'unknown';
          const lastActive = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '--';
          return \`
            <tr>
              <td title="\${escapeControlHtml(s.sessionKey || '')}">\${escapeControlHtml(s.label || s.sessionKey || s.sessionId || '--')}</td>
              <td>\${escapeControlHtml(channel)}</td>
              <td>\${s.messageCount || 0}</td>
              <td>\${escapeControlHtml(lastActive)}</td>
              <td>
                <button class="btn btn-danger" data-session-key="\${escapeControlAttr(s.sessionKey || '')}">\${t('Delete')}</button>
              </td>
            </tr>
          \`;
        }).join('');
        tbody.querySelectorAll('[data-session-key]').forEach(btn => {
          btn.addEventListener('click', () => deleteControlSession(btn.dataset.sessionKey || ''));
        });
        addLog('info', 'Loaded ' + sessions.length + ' stored sessions');
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">' + t('Failed to load sessions') + '</td></tr>';
        addLog('error', 'Failed to load sessions: ' + e.message);
      }
    }

    async function deleteControlSession(sessionKey) {
      if (!sessionKey || !confirm(t('Delete this session?'))) return;
      try {
        await request('sessions.delete', { sessionKey });
        await refreshSessions();
        addLog('info', 'Session deleted');
      } catch (e) {
        addLog('error', 'Failed to delete session: ' + e.message);
      }
    }

    function escapeControlHtml(text) {
      return String(text ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
      }[c]));
    }

    function escapeControlAttr(text) {
      return escapeControlHtml(text);
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

    // ===== Backend log streaming =====
    let backendLogs = [];       // rolling buffer of received backend entries
    let logPaused = false;
    let logsSubscribed = false;
    const LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

    function logPasses(entry) {
      const minLevel = document.getElementById('log-level-filter')?.value || 'info';
      if ((LOG_LEVEL_ORDER[entry.level] ?? 1) < (LOG_LEVEL_ORDER[minLevel] ?? 1)) return false;
      const needle = (document.getElementById('log-module-filter')?.value || '').trim().toLowerCase();
      if (needle) {
        const hay = ((entry.module || '') + ' ' + (entry.msg || '')).toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    }

    function appendBackendLog(entry) {
      const container = document.getElementById('log-container');
      if (!container) return;
      const el = document.createElement('div');
      el.className = 'log-entry ' + entry.level;
      const timeSpan = document.createElement('span');
      timeSpan.className = 'time';
      timeSpan.textContent = '[' + new Date(entry.time).toLocaleTimeString() + '] ';
      el.appendChild(timeSpan);
      if (entry.module) {
        const modSpan = document.createElement('span');
        modSpan.className = 'module';
        modSpan.textContent = '[' + entry.module + '] ';
        el.appendChild(modSpan);
      }
      // textContent keeps arbitrary log messages from being interpreted as HTML.
      el.appendChild(document.createTextNode(entry.msg || ''));
      container.appendChild(el);
      container.scrollTop = container.scrollHeight;
      while (container.children.length > 500) container.removeChild(container.firstChild);
    }

    function renderLogView() {
      const container = document.getElementById('log-container');
      if (!container) return;
      container.innerHTML = '';
      for (const entry of backendLogs) {
        if (logPasses(entry)) appendBackendLog(entry);
      }
    }

    function onBackendLog(entry) {
      backendLogs.push(entry);
      while (backendLogs.length > 1000) backendLogs.shift();
      if (!logPaused && logPasses(entry)) appendBackendLog(entry);
    }

    function toggleLogPause() {
      logPaused = !logPaused;
      const btn = document.getElementById('log-pause-btn');
      if (btn) btn.textContent = logPaused ? t('Resume') : t('Pause');
      if (!logPaused) renderLogView();
    }

    function clearLogs() {
      backendLogs = [];
      const container = document.getElementById('log-container');
      if (container) container.innerHTML = '';
    }
    window.toggleLogPause = toggleLogPause;
    window.clearLogs = clearLogs;

    async function subscribeLogs() {
      if (logsSubscribed || ws?.readyState !== WebSocket.OPEN) return;
      logsSubscribed = true;
      try {
        const res = await request('logs.subscribe');
        backendLogs = (res && res.entries) || [];
        renderLogView();
      } catch (e) {
        logsSubscribed = false;
        addLog('error', 'Failed to subscribe logs: ' + e.message);
      }
    }

    async function unsubscribeLogs() {
      if (!logsSubscribed) return;
      logsSubscribed = false;
      try { await request('logs.unsubscribe'); } catch (e) { /* ignore */ }
    }

    // Re-render on filter changes.
    document.getElementById('log-level-filter')?.addEventListener('change', renderLogView);
    document.getElementById('log-module-filter')?.addEventListener('input', renderLogView);

    // ===== Configuration Management =====
    let currentConfig = null;
    let pendingProviders = {};  // Temporary provider data storage

    // Config tab switching
    document.querySelectorAll('#config-tabs .config-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#config-tabs .config-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('#view-config .config-content').forEach(c => c.classList.remove('active'));
        const content = document.getElementById('tab-' + tab.dataset.tab);
        if (content) content.classList.add('active');
      });
    });

    // Load config
    async function loadConfig() {
      try {
        console.log('Loading config...');
        if (ws?.readyState !== WebSocket.OPEN) {
          console.warn('WebSocket not connected, waiting...');
          // Wait for connection then load
          const { promise, resolve } = Promise.withResolvers();
          const check = () => {
            if (ws?.readyState === WebSocket.OPEN) {
              resolve();
            } else {
              setTimeout(check, 500);
            }
          };
          check();
          await promise;
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
        showSaveResult('error', t('Failed to load config') + ': ' + e.message);
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
        container.innerHTML = '<div style="grid-column:1/-1;padding:2rem;text-align:center;color:var(--text-muted);">' + t('No providers configured') + '</div>';
        return;
      }

      container.innerHTML = Object.entries(providers).map(([id, p]) => \`
        <div class="provider-form-card" data-provider-id="\${id}">
          <div class="provider-form-header">
            <h4>\${p.name || id}</h4>
            <span class="provider-status-badge \${p.hasApiKey ? 'configured' : ''}">
              \${p.hasApiKey ? t('Configured') : t('Not configured')}
            </span>
          </div>
          <div class="provider-actions">
            <button onclick="editProvider('\${id}')">\${t('Edit')}</button>
            <button class="danger" onclick="removeProvider('\${id}')">\${t('Delete')}</button>
          </div>
        </div>
      \`).join('');
    }

    // Populate channels config
    function populateChannelsForm(channels) {
      document.getElementById('weixin-enabled').checked = false;
      document.getElementById('weixin-bot-type').value = '';
      document.getElementById('weixin-base-url').value = '';
      document.getElementById('weixin-status').textContent = t('Status: Not logged in');

      const weixin = channels.weixin;
      if (weixin) {
        const hasConfig = weixin.hasToken;
        document.getElementById('weixin-enabled').checked = hasConfig && weixin.enabled !== false;
        document.getElementById('weixin-bot-type').value = weixin.botType || '';
        document.getElementById('weixin-base-url').value = weixin.baseUrl || '';
        document.getElementById('weixin-status').textContent = weixin.hasToken
          ? t('Status: Logged in (Token valid)')
          : t('Status: Not logged in (scan QR in terminal or restart to auto-login)');
        if (weixin.hasToken) {
          document.getElementById('weixin-status').style.color = '#10b981';
        } else {
          document.getElementById('weixin-status').style.color = '#f59e0b';
        }
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
        alert(t('Please enter API Key'));
        return;
      }

      if ((type === 'custom-openai' || type === 'custom-anthropic') && !baseUrl) {
        alert(t('Please enter Base URL'));
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

      showSaveResult('success', t('Provider added (click Save to apply changes)'));
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
        showSaveResult('success', t('Provider updated (click Save to apply changes)'));
      }
    }

    // Remove provider
    function removeProvider(id) {
      if (!confirm(t('Are you sure you want to remove this provider?'))) return;

      pendingProviders[id] = { id: id, hasApiKey: false };
      const mergedProviders = { ...currentConfig.providers };
      delete mergedProviders[id];
      populateProvidersForm(mergedProviders);

      showSaveResult('success', t('Provider removed (click Save to apply changes)'));
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
        const currentWeixin = currentConfig && currentConfig.channels ? currentConfig.channels.weixin : null;
        const weixinHasConfig = Boolean(currentWeixin?.hasConfig || currentWeixin?.hasToken || weixinEnabled || weixinBotType || weixinBaseUrl);
        if (weixinHasConfig) {
          channels.weixin = {
            id: 'weixin',
            name: 'Personal WeChat',
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
        showSaveResult('error', t('Failed to save config') + ': ' + e.message);
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

      btn.textContent = t('Getting QR code...');
      btn.disabled = true;

      try {
        const result = await request('weixin.qr', {});
        if (result.error) {
          btn.textContent = t('Scan QR Login');
          btn.disabled = false;
          alert(result.error);
          return;
        }

        currentQRCode = result.qrcode;
        img.src = result.qrcode_url;
        area.style.display = 'block';
        statusEl.textContent = t('Waiting for scan...');
        statusEl.style.color = '#f59e0b';
        btn.textContent = t('Refresh QR');
        btn.disabled = false;

        startQRPolling();
      } catch (e) {
        btn.textContent = t('Scan QR Login');
        btn.disabled = false;
        alert(t('Failed to get QR code') + ': ' + e.message);
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
            btn.textContent = t('Logged in ✓');
            btn.disabled = true;
            document.getElementById('weixin-status').textContent = t('Status: Logged in (Token valid)');
            document.getElementById('weixin-status').style.color = '#10b981';
            alert(t('WeChat login successful! Click "Save All Changes" and restart the service.'));
          } else if (result.status === 'expired') {
            statusEl.textContent = t('QR code expired, please refresh');
            statusEl.style.color = '#ef4444';
            clearInterval(qrPollTimer);
            qrPollTimer = null;
            currentQRCode = null;
            const btn = document.getElementById('weixin-qr-btn');
            btn.textContent = t('Refresh QR');
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

    // ===== Settings (Persona / Extensions / Skills / Sessions / Geek) =====
    let currentSettings = null;

    document.querySelectorAll('#settings-tabs [data-settings-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#settings-tabs [data-settings-tab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('#view-settings .config-content').forEach(c => c.classList.remove('active'));
        const content = document.getElementById('settings-tab-' + tab.dataset.settingsTab);
        if (content) content.classList.add('active');
      });
    });

    async function loadSettings() {
      try {
        if (ws?.readyState !== WebSocket.OPEN) {
          const { promise, resolve } = Promise.withResolvers();
          const check = () => {
            if (ws?.readyState === WebSocket.OPEN) resolve();
            else setTimeout(check, 500);
          };
          check();
          await promise;
        }
        currentSettings = await request('config.get');
        populateSettingsForm(currentSettings);
        hideSettingsSaveResult();
        addLog('info', 'Settings loaded');
      } catch (e) {
        addLog('error', 'Failed to load settings: ' + e.message);
        showSettingsSaveResult('error', t('Failed to load settings') + ': ' + e.message);
      }
    }

    function populateSettingsForm(config) {
      const p = config.persona || {};
      setChecked('persona-enabled', p.enabled);
      setValue('persona-name', p.persona_name);
      setValue('persona-reply-style', p.persona_reply_style);
      setValue('persona-base-prompt', p.persona_base_prompt);
      setChecked('persona-time-awareness', p.time_awareness_enabled);
      setChecked('persona-emotion-enabled', p.emotion_enabled);
      setValue('persona-emotion-decay', p.emotion_decay_per_hour);
      setValue('persona-emotion-recovery', p.emotion_recovery_per_reply);
      setValue('persona-emotion-injection-style', p.emotion_injection_style);
      setValue('persona-emotion-decay-cron', p.emotion_decay_cron);
      setChecked('persona-memory-enabled', p.memory_enabled);
      setValue('persona-memory-max-turns', p.memory_max_turns);
      setChecked('persona-reflection-enabled', p.reflection_enabled);
      setValue('persona-reflection-trigger-turns', p.reflection_trigger_turns);
      setValue('persona-reflection-history-turns', p.reflection_history_turns);
      setValue('persona-reflection-periodic-cron', p.reflection_periodic_cron);
      setChecked('persona-profile-enabled', p.profile_enabled);
      setChecked('persona-profile-building', p.profile_building_enabled);
      setValue('persona-profile-building-trigger-turns', p.profile_building_trigger_turns);
      setChecked('persona-rest-enabled', p.rest_enabled);
      setChecked('persona-proactive-nudge', p.proactive_nudge_enabled);
      setValue('persona-rest-sleep-hour', p.rest_sleep_hour);
      setValue('persona-rest-wake-hour', p.rest_wake_hour);
      setValue('persona-proactive-nudge-cron', p.proactive_nudge_cron);
      setChecked('persona-greeting-first-chat', p.greeting_on_first_chat);
      setChecked('persona-goodnight-hint', p.goodnight_hint_enabled);
      setChecked('persona-debug-log', p.debug_log_enabled);

      const sl = config.skillLearner || {};
      setChecked('skilllearner-enabled', sl.enabled);
      setValue('skilllearner-auto-trigger-keywords', Array.isArray(sl.autoTriggerKeywords) ? sl.autoTriggerKeywords.join(', ') : '');
      setValue('skilllearner-max-learning-turns', sl.maxLearningTurns);
      setValue('skilllearner-proactive-threshold', sl.proactiveThreshold);
      setChecked('skilllearner-auto-learn', sl.enableAutoLearn);
      setChecked('skilllearner-proactive-suggest', sl.enableProactiveSuggest);
      setChecked('skilllearner-auto-deploy', sl.autoDeployToSkills);

      const sh = config.sharelink || {};
      setChecked('sharelink-enabled', sh.enabled);
      setValue('sharelink-response-mode', sh.responseMode || 'simple');
      setValue('sharelink-description-max-length', sh.descriptionMaxLength);
      setChecked('sharelink-include-description', sh.includeDescription);
      setChecked('sharelink-include-cover', sh.includeCover);
      setChecked('sharelink-auto-detect', sh.autoDetect);
      setValue('sharelink-audio-timeout', sh.audioDownloadTimeout);
      setValue('sharelink-subtitle-max-length', sh.subtitleMaxLength);
      setValue('sharelink-llm-short-threshold', sh.llmShortContentThreshold);
      setValue('sharelink-llm-chunk-size', sh.llmChunkSize);
      setValue('sharelink-bili-sessdata', '');
      setValue('sharelink-bili-jct', '');
      const cookieStatus = document.getElementById('sharelink-cookie-status');
      if (cookieStatus) {
        cookieStatus.textContent = sh.hasBilibiliCookie ? 'Cookie configured (leave blank to keep)' : 'No cookie configured';
      }

      const weather = config.weather || {};
      setValue('weather-provider', weather.weather_provider || 'wttr');
      setValue('weather-caiyun-api-version', weather.caiyun_api_version || 'v2.6');
      setValue('weather-caiyun-api-key', '');
      setValue('weather-default-location', weather.default_location);
      setValue('weather-wttr-base-url', weather.wttr_base_url || 'https://wttr.in');
      setValue('weather-request-timeout-ms', weather.request_timeout_ms);
      setValue('weather-cache-ttl-ms', weather.cache_ttl_ms);
      const caiyunKeyStatus = document.getElementById('weather-caiyun-key-status');
      if (caiyunKeyStatus) {
        caiyunKeyStatus.textContent = weather.hasCaiyunApiKey ? t('Caiyun API key configured (leave blank to keep)') : t('No Caiyun API key configured');
      }

      const sk = config.skills || {};
      setChecked('settings-skills-enabled', sk.enabled);
      setValue('settings-skills-user-dir', sk.userDir);
      setValue('settings-skills-workspace-dir', sk.workspaceDir);
      setValue('settings-skills-disabled', Array.isArray(sk.disabled) ? sk.disabled.join(', ') : '');
      setValue('settings-skills-only', Array.isArray(sk.only) ? sk.only.join(', ') : '');

      const se = config.sessions || {};
      setValue('sessions-type', se.type || 'memory');
      setValue('sessions-directory', se.directory);
      setValue('sessions-ttl-ms', se.ttlMs);

      setValue('settings-raw-yaml', '');
      setRawError('');
    }

    function setValue(id, value) {
      const el = document.getElementById(id);
      if (el !== null) el.value = value === undefined || value === null ? '' : String(value);
    }

    function setChecked(id, value) {
      const el = document.getElementById(id);
      if (el !== null) el.checked = Boolean(value);
    }

    function getValue(id) {
      const el = document.getElementById(id);
      return el ? el.value : '';
    }

    function getChecked(id) {
      const el = document.getElementById(id);
      return el ? el.checked : false;
    }

    function csvToArray(str) {
      if (!str) return undefined;
      const arr = str.split(',').map(s => s.trim()).filter(Boolean);
      return arr.length > 0 ? arr : undefined;
    }

    function numOrUndef(id) {
      const v = getValue(id);
      if (v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }

    function collectSettings() {
      const payload = {};

      const persona = {
        enabled: getChecked('persona-enabled'),
        persona_name: getValue('persona-name') || undefined,
        persona_reply_style: getValue('persona-reply-style') || undefined,
        persona_base_prompt: getValue('persona-base-prompt') || undefined,
        time_awareness_enabled: getChecked('persona-time-awareness'),
        emotion_enabled: getChecked('persona-emotion-enabled'),
        emotion_decay_per_hour: numOrUndef('persona-emotion-decay'),
        emotion_recovery_per_reply: numOrUndef('persona-emotion-recovery'),
        emotion_injection_style: getValue('persona-emotion-injection-style') || undefined,
        emotion_decay_cron: getValue('persona-emotion-decay-cron') || undefined,
        memory_enabled: getChecked('persona-memory-enabled'),
        memory_max_turns: numOrUndef('persona-memory-max-turns'),
        reflection_enabled: getChecked('persona-reflection-enabled'),
        reflection_trigger_turns: numOrUndef('persona-reflection-trigger-turns'),
        reflection_history_turns: numOrUndef('persona-reflection-history-turns'),
        reflection_periodic_cron: getValue('persona-reflection-periodic-cron') || undefined,
        profile_enabled: getChecked('persona-profile-enabled'),
        profile_building_enabled: getChecked('persona-profile-building'),
        profile_building_trigger_turns: numOrUndef('persona-profile-building-trigger-turns'),
        rest_enabled: getChecked('persona-rest-enabled'),
        proactive_nudge_enabled: getChecked('persona-proactive-nudge'),
        rest_sleep_hour: numOrUndef('persona-rest-sleep-hour'),
        rest_wake_hour: numOrUndef('persona-rest-wake-hour'),
        proactive_nudge_cron: getValue('persona-proactive-nudge-cron') || undefined,
        greeting_on_first_chat: getChecked('persona-greeting-first-chat'),
        goodnight_hint_enabled: getChecked('persona-goodnight-hint'),
        debug_log_enabled: getChecked('persona-debug-log'),
      };
      payload.persona = persona;

      const skillLearner = {
        enabled: getChecked('skilllearner-enabled'),
        autoTriggerKeywords: csvToArray(getValue('skilllearner-auto-trigger-keywords')),
        maxLearningTurns: numOrUndef('skilllearner-max-learning-turns'),
        enableAutoLearn: getChecked('skilllearner-auto-learn'),
        enableProactiveSuggest: getChecked('skilllearner-proactive-suggest'),
        proactiveThreshold: numOrUndef('skilllearner-proactive-threshold'),
        autoDeployToSkills: getChecked('skilllearner-auto-deploy'),
      };
      payload.skillLearner = skillLearner;

      const sharelink = {
        enabled: getChecked('sharelink-enabled'),
        responseMode: getValue('sharelink-response-mode') || undefined,
        descriptionMaxLength: numOrUndef('sharelink-description-max-length'),
        includeDescription: getChecked('sharelink-include-description'),
        includeCover: getChecked('sharelink-include-cover'),
        autoDetect: getChecked('sharelink-auto-detect'),
        audioDownloadTimeout: numOrUndef('sharelink-audio-timeout'),
        subtitleMaxLength: numOrUndef('sharelink-subtitle-max-length'),
        llmShortContentThreshold: numOrUndef('sharelink-llm-short-threshold'),
        llmChunkSize: numOrUndef('sharelink-llm-chunk-size'),
      };
      const sessdata = getValue('sharelink-bili-sessdata').trim();
      const biliJct = getValue('sharelink-bili-jct').trim();
      if (sessdata || biliJct) {
        sharelink.bilibiliCookie = {
          ...(sessdata ? { sessdata } : {}),
          ...(biliJct ? { biliJct } : {}),
        };
      }
      payload.sharelink = sharelink;

      const weather = {
        weather_provider: getValue('weather-provider') || undefined,
        caiyun_api_version: getValue('weather-caiyun-api-version') || undefined,
        wttr_base_url: getValue('weather-wttr-base-url') || undefined,
        default_location: getValue('weather-default-location') || undefined,
        request_timeout_ms: numOrUndef('weather-request-timeout-ms'),
        cache_ttl_ms: numOrUndef('weather-cache-ttl-ms'),
      };
      const caiyunApiKey = getValue('weather-caiyun-api-key').trim();
      if (caiyunApiKey) {
        weather.caiyun_api_key = caiyunApiKey;
      }
      payload.weather = weather;

      const skills = {
        enabled: getChecked('settings-skills-enabled'),
        userDir: getValue('settings-skills-user-dir') || undefined,
        workspaceDir: getValue('settings-skills-workspace-dir') || undefined,
        disabled: csvToArray(getValue('settings-skills-disabled')),
        only: csvToArray(getValue('settings-skills-only')),
      };
      payload.skills = skills;

      const sessions = {
        type: getValue('sessions-type') || undefined,
        directory: getValue('sessions-directory') || undefined,
        ttlMs: numOrUndef('sessions-ttl-ms'),
      };
      payload.sessions = sessions;

      const raw = getValue('settings-raw-yaml').trim();
      if (raw) {
        payload.rawYaml = raw;
      }

      return payload;
    }

    async function saveAllSettings() {
      try {
        hideSettingsSaveResult();
        const payload = collectSettings();
        const result = await request('config.save', payload);
        if (result.success) {
          showSettingsSaveResult(result.requiresRestart ? 'warning' : 'success', result.message);
          await loadSettings();
          addLog('info', result.message);
        } else {
          showSettingsSaveResult('error', result.message || 'Save failed');
          addLog('error', result.message || 'Save failed');
        }
      } catch (e) {
        addLog('error', 'Failed to save settings: ' + e.message);
        showSettingsSaveResult('error', t('Failed to save settings') + ': ' + e.message);
      }
    }

    function validateRawYaml() {
      const raw = getValue('settings-raw-yaml');
      if (!raw.trim()) {
        setRawError('');
        alert(t('Raw YAML editor is empty — nothing to validate.'));
        return;
      }
      setRawError(t('YAML will be validated by the server when you save.'));
    }

    function setRawError(msg) {
      const el = document.getElementById('settings-raw-error');
      if (el) el.textContent = msg || '';
    }

    function showSettingsSaveResult(type, message) {
      const el = document.getElementById('settings-save-result');
      el.textContent = message;
      el.className = 'save-result show ' + type;
      setTimeout(hideSettingsSaveResult, 5000);
    }

    function hideSettingsSaveResult() {
      const el = document.getElementById('settings-save-result');
      el.className = 'save-result';
      el.textContent = '';
    }

    mountLanguageSwitcher();
    applyI18n();
    connect();
`;
