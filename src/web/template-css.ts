export const COMMON_CSS: string = "";

export const WEBCHAT_CSS: string = `    * { margin: 0; padding: 0; box-sizing: border-box; }
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
`;

export const CONTROL_CSS: string = `    * { margin: 0; padding: 0; box-sizing: border-box; }
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
    .log-entry { color: #e2e8f0; white-space: pre-wrap; word-break: break-word; }
    .log-entry.debug { color: #94a3b8; }
    .log-entry.info { color: #38bdf8; }
    .log-entry.warn { color: #fbbf24; }
    .log-entry.error { color: #f87171; }
    .log-entry .time { color: #64748b; }
    .log-entry .module { color: #a78bfa; }
    .log-toolbar {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-bottom: 0.75rem;
      flex-wrap: wrap;
    }
    .log-toolbar select.form-input { width: auto; }
    .log-toolbar input.form-input { width: auto; flex: 1; min-width: 160px; }
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
    .raw-json-editor {
      font-family: "SF Mono", Monaco, Consolas, monospace;
      font-size: 0.8125rem;
      line-height: 1.5;
      white-space: pre;
      tab-size: 2;
      min-height: 300px;
      resize: vertical;
    }
`;
