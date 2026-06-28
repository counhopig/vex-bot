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

    connect();
`;

export const CONTROL_CLIENT_JS: string = `    let ws = null;
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
`;
