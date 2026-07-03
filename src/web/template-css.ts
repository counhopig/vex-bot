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
    .sidebar-logo { font-size: 1.5rem; display: inline-flex; align-items: center; justify-content: center; }
    .mascot-img { display: block; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
    .mascot-img-small { width: 32px; height: 32px; }
    .mascot-img-medium { width: 28px; height: 28px; }
    .mascot-img-large { width: 80px; height: 80px; }
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
    .message-avatar { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1rem; flex-shrink: 0; overflow: hidden; }
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
      --primary-soft: #eef2ff;
      --bg: #f1f5f9;
      --bg-card: #ffffff;
      --text: #1e293b;
      --text-secondary: #64748b;
      --text-muted: #94a3b8;
      --border: #e2e8f0;
      --success: #22c55e;
      --warning: #f59e0b;
      --error: #ef4444;
      --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.06);
      --shadow-md: 0 4px 12px rgba(15, 23, 42, 0.08);
      --shadow-lg: 0 12px 32px rgba(15, 23, 42, 0.16);
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    body.no-scroll { overflow: hidden; }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; animation: none !important; }
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
    .mascot-img { display: block; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
    .mascot-img-small { width: 32px; height: 32px; }
    .mascot-img-medium { width: 28px; height: 28px; }
    .mascot-img-large { width: 80px; height: 80px; }
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
    .nav-item.active { background: var(--primary-soft); color: var(--primary); font-weight: 500; box-shadow: inset 3px 0 0 var(--primary); }
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
      box-shadow: var(--shadow-sm);
      transition: box-shadow 0.2s, transform 0.2s;
    }
    .card:hover { box-shadow: var(--shadow-md); transform: translateY(-2px); }
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
      box-shadow: var(--shadow-sm);
      overflow: hidden;
    }
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    tr:hover td { background: var(--bg); transition: background 0.12s; }
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
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.15s;
      user-select: none;
    }
    .btn:active { transform: translateY(1px); }
    .btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
    .btn:disabled { cursor: not-allowed; opacity: 0.65; }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover:not(:disabled) { background: var(--primary-hover); box-shadow: var(--shadow-sm); }
    .btn-secondary { background: var(--bg-card); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover:not(:disabled) { background: var(--bg); border-color: var(--text-muted); }
    .btn-danger { background: var(--error); color: white; }
    .btn-danger:hover:not(:disabled) { opacity: 0.9; }
    /* Button loading spinner */
    .btn.is-loading { color: transparent !important; pointer-events: none; }
    .btn.is-loading > * { visibility: hidden; }
    .btn.is-loading::after {
      content: "";
      position: absolute;
      width: 1rem;
      height: 1rem;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      color: inherit;
      animation: btn-spin 0.6s linear infinite;
      visibility: visible;
    }
    .btn-primary.is-loading::after, .btn-danger.is-loading::after { border-color: #fff; border-right-color: transparent; }
    .btn-secondary.is-loading::after { border-color: var(--text); border-right-color: transparent; }
    @keyframes btn-spin { to { transform: rotate(360deg); } }
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
    .config-tabs button, .config-tab {
      padding: 0.5rem 1rem;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-secondary);
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .config-tabs button:hover, .config-tab:hover {
      color: var(--text);
      border-bottom-color: var(--border);
    }
    .config-tabs button.active, .config-tab.active {
      color: var(--primary);
      border-bottom-color: var(--primary);
      font-weight: 600;
    }
    .config-tab:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 0.25rem; }
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
      box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.15);
      background: var(--bg-card);
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
    /* Password field toggle */
    .input-with-toggle { position: relative; display: flex; }
    .input-with-toggle .form-input { padding-right: 2.75rem; }
    .input-toggle-btn {
      position: absolute;
      top: 50%;
      right: 0.5rem;
      transform: translateY(-50%);
      background: none;
      border: none;
      cursor: pointer;
      font-size: 1rem;
      line-height: 1;
      padding: 0.25rem;
      color: var(--text-muted);
      border-radius: 0.375rem;
    }
    .input-toggle-btn:hover { color: var(--text); background: var(--bg); }
    .input-toggle-btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
    /* Mobile top bar + hamburger */
    .topbar {
      display: none;
      position: sticky;
      top: 0;
      z-index: 60;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      background: var(--bg-card);
      border-bottom: 1px solid var(--border);
    }
    .topbar-title { font-weight: 600; font-size: 1rem; }
    .hamburger {
      display: inline-flex;
      flex-direction: column;
      justify-content: center;
      gap: 4px;
      width: 40px;
      height: 40px;
      padding: 8px;
      background: none;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      cursor: pointer;
    }
    .hamburger span { display: block; height: 2px; background: var(--text); border-radius: 2px; transition: all 0.2s; }
    .sidebar-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.45);
      z-index: 70;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .sidebar-overlay.show { display: block; opacity: 1; }
    .sidebar-close { display: none; }
    /* Toast notifications */
    .toast-container {
      position: fixed;
      top: 1rem;
      right: 1rem;
      z-index: 2000;
      display: flex;
      flex-direction: column;
      gap: 0.625rem;
      max-width: min(360px, calc(100vw - 2rem));
      pointer-events: none;
    }
    .toast {
      pointer-events: auto;
      display: flex;
      align-items: flex-start;
      gap: 0.625rem;
      padding: 0.75rem 0.875rem;
      border-radius: 0.625rem;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-left: 4px solid var(--text-muted);
      box-shadow: var(--shadow-lg);
      font-size: 0.875rem;
      color: var(--text);
      animation: toast-in 0.22s ease;
    }
    .toast.hide { animation: toast-out 0.2s ease forwards; }
    .toast.success { border-left-color: var(--success); }
    .toast.error { border-left-color: var(--error); }
    .toast.warning { border-left-color: var(--warning); }
    .toast.info { border-left-color: var(--primary); }
    .toast-icon { font-size: 1rem; line-height: 1.35; }
    .toast-body { flex: 1; line-height: 1.4; word-break: break-word; }
    .toast-close {
      background: none; border: none; cursor: pointer;
      color: var(--text-muted); font-size: 1rem; line-height: 1; padding: 0 0.25rem;
    }
    .toast-close:hover { color: var(--text); }
    @keyframes toast-in { from { opacity: 0; transform: translateX(1rem); } to { opacity: 1; transform: translateX(0); } }
    @keyframes toast-out { to { opacity: 0; transform: translateX(1rem); } }
    /* Confirm dialog */
    .dialog { max-width: 420px; }
    .dialog-message { color: var(--text-secondary); font-size: 0.9375rem; line-height: 1.5; margin-bottom: 0.5rem; }
    .modal { box-shadow: var(--shadow-lg); animation: modal-pop 0.18s ease; }
    .modal-overlay { backdrop-filter: blur(2px); }
    @keyframes modal-pop { from { opacity: 0; transform: scale(0.96) translateY(6px); } to { opacity: 1; transform: none; } }
    /* Responsive */
    @media (max-width: 900px) {
      .cards { grid-template-columns: 1fr; }
    }
    @media (max-width: 768px) {
      .topbar { display: flex; }
      .layout { flex-direction: column; }
      .sidebar {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: 260px;
        max-width: 82vw;
        z-index: 80;
        transform: translateX(-100%);
        transition: transform 0.24s ease;
        box-shadow: var(--shadow-lg);
        overflow-y: auto;
      }
      .sidebar.open { transform: translateX(0); }
      .sidebar-close {
        display: inline-flex;
        position: absolute;
        top: 1rem;
        right: 1rem;
        background: none;
        border: none;
        font-size: 1.5rem;
        line-height: 1;
        cursor: pointer;
        color: var(--text-muted);
      }
      .main-content { padding: 1.25rem 1rem; }
      .page-header { margin-bottom: 1.25rem; }
      .form-row { grid-template-columns: 1fr; }
      .table-header { flex-wrap: wrap; gap: 0.5rem; }
      th, td { padding: 0.75rem 1rem; white-space: nowrap; }
      .modal { width: 94%; }
      .config-tab, .config-tabs button { white-space: nowrap; }
      #config-tabs, #settings-tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    }
    @media (max-width: 480px) {
      .card-value { font-size: 1.5rem; }
      .toast-container { left: 1rem; right: 1rem; max-width: none; }
    }
`;
