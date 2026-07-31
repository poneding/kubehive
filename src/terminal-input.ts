import type { Terminal } from "@xterm/xterm";

function isMacWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent;
  return /Macintosh|Mac OS X/i.test(userAgent)
    && /AppleWebKit/i.test(userAgent)
    && !/(Chrome|Chromium|CriOS|Edg|OPR)/i.test(userAgent);
}

/**
 * WKWebView can commit IME text through `input` before the keyCode=229
 * keydown that xterm expects. In that ordering xterm intentionally skips the
 * input event and its later textarea diff is empty, so the committed text is
 * lost. Forward only that complementary case and leave normal composition to
 * xterm's built-in CompositionHelper.
 */
export function attachMacWebKitImeInput(terminal: Terminal): () => void {
  const textarea = terminal.textarea;
  if (!textarea || !isMacWebKit()) return () => undefined;

  let keyDownSeen = false;
  let last229At = Number.NEGATIVE_INFINITY;
  let lastCompositionEndAt = Number.NEGATIVE_INFINITY;

  const handleKeyDown = (event: KeyboardEvent) => {
    keyDownSeen = true;
    if (event.keyCode === 229) last229At = performance.now();
  };
  const handleKeyUp = () => {
    keyDownSeen = false;
  };
  const handleCompositionEnd = () => {
    lastCompositionEndAt = performance.now();
  };
  const handleInput = (event: InputEvent) => {
    if (
      event.target !== textarea
      || terminal.options.screenReaderMode
      || event.inputType !== "insertText"
      || !event.data
      || event.isComposing
    ) return;

    const now = performance.now();
    // In the usual keyCode=229-first flow, xterm's textarea diff owns the input.
    if (now - last229At < 50) return;
    // CompositionHelper owns the final commit of a real composition session.
    if (now - lastCompositionEndAt < 100) return;
    // This mirrors the case xterm 6 skips in CoreBrowserTerminal._inputEvent.
    if (!event.composed || !keyDownSeen) return;

    terminal.input(event.data, true);
    // Do not leave stale committed text for the following 229 diff to resend.
    textarea.value = "";
  };

  textarea.addEventListener("keydown", handleKeyDown, true);
  textarea.addEventListener("keyup", handleKeyUp, true);
  textarea.addEventListener("compositionend", handleCompositionEnd, true);
  textarea.addEventListener("input", handleInput, true);

  return () => {
    textarea.removeEventListener("keydown", handleKeyDown, true);
    textarea.removeEventListener("keyup", handleKeyUp, true);
    textarea.removeEventListener("compositionend", handleCompositionEnd, true);
    textarea.removeEventListener("input", handleInput, true);
  };
}
