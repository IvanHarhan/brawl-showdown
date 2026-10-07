// Подключается первым: SDK запоминает globalThis.WebSocket при загрузке модуля.
// SDK сначала пробует node-вариант new WebSocket(url, {headers, protocols}) и ловит ошибку.
// Safari эту пойманную ошибку всё равно пишет в консоль — отдаём браузеру сразу правильные аргументы.
{
  const Native = window.WebSocket;
  class SafeWebSocket extends Native {
    constructor(url: string | URL, p?: string | string[] | { protocols?: string | string[] }) {
      super(url, p && typeof p === 'object' && !Array.isArray(p) ? p.protocols : p);
    }
  }
  window.WebSocket = SafeWebSocket as typeof WebSocket;
}

export {};
