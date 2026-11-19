// @ts-check

export const $ = (id) => document.getElementById(id);
/** A form control by id: an input, textarea or select, which all carry value and disabled. */
export const $field = (id) => /** @type {HTMLInputElement} */ ($(id));

export function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Shows connection state in the top status line; an empty text hides it again. */
export function setStatus(text) {
  $("status").textContent = text;
  $("status").hidden = !text;
}

let flashTimer;
/** A status message that clears itself again after a few seconds. */
export function flash(text) {
  setStatus(text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setStatus(""), 4000);
}
