import { describe, expect, it } from "vitest";
import { CONTROL_CLIENT_JS } from "../src/web/template-client.js";
import { I18N_CLIENT_JS } from "../src/web/i18n.js";
import { CONTROL_CSS } from "../src/web/template-css.js";

describe("control UI client regressions", () => {
  it("loads stored sessions through the websocket instead of only logging refresh", () => {
    expect(CONTROL_CLIENT_JS).toContain("request('sessions.list'");
    expect(CONTROL_CLIENT_JS).toContain("data-session-key");
    expect(CONTROL_CLIENT_JS).toContain("deleteControlSession");
  });

  it("scopes config and settings tabs to their own containers", () => {
    expect(CONTROL_CLIENT_JS).toContain("querySelectorAll('#config-tabs .config-tab')");
    expect(CONTROL_CLIENT_JS).toContain("querySelectorAll('#settings-tabs [data-settings-tab]')");
    expect(CONTROL_CLIENT_JS).toContain("querySelectorAll('#view-config .config-content')");
  });

  it("sends complete weixin identity fields when saving channel config", () => {
    expect(CONTROL_CLIENT_JS).toContain("id: 'weixin'");
    expect(CONTROL_CLIENT_JS).toContain("name: 'Personal WeChat'");
  });

  it("keeps i18n data in the shared web i18n module", () => {
    expect(I18N_CLIENT_JS).toContain("window.VexI18n");
    expect(I18N_CLIENT_JS).toContain("控制台");
    expect(I18N_CLIENT_JS).toContain('closest(".log-container")');
    expect(CONTROL_CLIENT_JS).not.toContain("const I18N =");
  });

  it("collects weather settings in the control settings payload", () => {
    expect(CONTROL_CLIENT_JS).toContain("config.weather || {}");
    expect(CONTROL_CLIENT_JS).toContain("weather_provider: getValue('weather-provider')");
    expect(CONTROL_CLIENT_JS).toContain("weather.caiyun_api_key = caiyunApiKey");
    expect(CONTROL_CLIENT_JS).toContain("payload.weather = weather");
  });

  it("replaces native alert/confirm/prompt dialogs with in-page UI", () => {
    // No blocking browser dialogs except the confirmDialog fallback (window.confirm).
    expect(CONTROL_CLIENT_JS).not.toMatch(/[^.]alert\(/);
    expect(CONTROL_CLIENT_JS).not.toMatch(/[^.a-zA-Z]prompt\(/);
    expect(CONTROL_CLIENT_JS).toContain("function showToast");
    expect(CONTROL_CLIENT_JS).toContain("function confirmDialog");
  });

  it("shows loading state on save/refresh actions", () => {
    expect(CONTROL_CLIENT_JS).toContain("function runWithLoading");
    expect(CONTROL_CLIENT_JS).toContain("is-loading");
  });

  it("edits providers through the modal instead of a prompt", () => {
    expect(CONTROL_CLIENT_JS).toContain("providerModalMode");
    expect(CONTROL_CLIENT_JS).toContain("editingProviderId");
  });

  it("wires mobile navigation and dialog dismissal on init", () => {
    expect(CONTROL_CLIENT_JS).toContain("initControlUx()");
    expect(CONTROL_CLIENT_JS).toContain("function initMobileNav");
    expect(CONTROL_CLIENT_JS).toContain("function initPasswordToggles");
  });

  it("defines the previously-undefined --text-muted token and is responsive", () => {
    expect(CONTROL_CSS).toContain("--text-muted:");
    expect(CONTROL_CSS).toContain("@media (max-width: 768px)");
    expect(CONTROL_CSS).toContain(".toast");
    expect(CONTROL_CSS).toContain(".btn.is-loading");
  });
});
