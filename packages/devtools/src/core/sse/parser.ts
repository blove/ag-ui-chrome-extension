export type SseFrame =
  | { kind: 'event'; data: string; eventName?: string; id?: string; retry?: number }
  | { kind: 'keepalive'; comment: string };

export interface SseParser {
  push(chunk: string): SseFrame[];
  flush(): SseFrame[];
}

type SseEventFrame = Extract<SseFrame, { kind: 'event' }>;

function stripOneLeadingSpace(value: string): string {
  return value.startsWith(' ') ? value.slice(1) : value;
}

export function createSseParser(): SseParser {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let lastId: string | undefined;
  let retry: number | undefined;
  let hasData = false;

  function resetFrame(): void {
    dataLines = [];
    eventName = undefined;
    lastId = undefined;
    retry = undefined;
    hasData = false;
  }

  function dispatch(out: SseFrame[]): void {
    if (!hasData) {
      resetFrame();
      return;
    }
    const frame: SseEventFrame = { kind: 'event', data: dataLines.join('\n') };
    if (eventName !== undefined) frame.eventName = eventName;
    if (lastId !== undefined) frame.id = lastId;
    if (retry !== undefined) frame.retry = retry;
    out.push(frame);
    resetFrame();
  }

  function handleLine(line: string, out: SseFrame[]): void {
    if (line === '') {
      dispatch(out);
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : stripOneLeadingSpace(line.slice(colon + 1));
    switch (field) {
      case 'data':
        dataLines.push(value);
        hasData = true;
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        lastId = value;
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) retry = Number(value);
        break;
      default:
        break;
    }
  }

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;
      const out: SseFrame[] = [];
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        handleLine(buffer.slice(0, nl), out);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
      return out;
    },

    flush(): SseFrame[] {
      // Trailing-frame handling is driven out in cycle 3.
      return [];
    },
  };
}
