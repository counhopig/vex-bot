// @ts-check
/** @typedef {import("../../protocol/messages.js").ClientMessage} ClientMessage */
/** @typedef {import("../../protocol/messages.js").ServerMessage} ServerMessage */

import { state } from "./state.js";
import { setStatus } from "./ui.js";

/** @param {ClientMessage} message */
export function send(message) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try {
      state.ws.send(JSON.stringify(message));
      return true;
    } catch {
      // The connection can close between the ready-state check and send.
    }
  }
  setStatus("Connection lost; reconnecting…");
  return false;
}

/**
 * Opens the WebSocket and dispatches every incoming server message to `dispatch`. `onOpen` runs
 * on every (re)connection to resubscribe and reload what the open page needs; a lost connection
 * reconnects with exponential backoff.
 * @param {(msg: ServerMessage) => void} dispatch
 * @param {() => void} onOpen
 */
export function connect(dispatch, onOpen) {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  state.ws = ws;
  ws.addEventListener("open", () => {
    state.retryMs = 1000;
    setStatus("");
    onOpen();
  });
  ws.addEventListener("message", (event) => dispatch(JSON.parse(event.data)));
  ws.addEventListener("close", () => {
    setStatus("Connection lost; reconnecting…");
    setTimeout(connect, state.retryMs);
    state.retryMs = Math.min(state.retryMs * 2, 10000);
  });
}
