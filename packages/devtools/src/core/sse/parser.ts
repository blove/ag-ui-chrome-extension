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
    if (line.startsWith(':')) {
      out.push({ kind: 'keepalive', comment: stripOneLeadingSpace(line.slice(1)) });
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
      let start = 0;
      let i = 0;
      while (i < buffer.length) {
        const ch = buffer[i];
        if (ch === '\n') {
          handleLine(buffer.slice(start, i), out);
          i += 1;
          start = i;
        } else if (ch === '\r') {
          if (i === buffer.length - 1) {
            // A trailing CR may be the first half of a CRLF pair split across
            // chunks. Hold it in the buffer until the next push or flush().
            break;
          }
          handleLine(buffer.slice(start, i), out);
          i += buffer[i + 1] === '\n' ? 2 : 1;
          start = i;
        } else {
          i += 1;
        }
      }
      buffer = buffer.slice(start);
      return out;
    },

    flush(): SseFrame[] {
      const out: SseFrame[] = [];
      if (buffer !== '') {
        // A held-back trailing CR was a real terminator after all.
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        buffer = '';
        handleLine(line, out);
      }
      dispatch(out);
      return out;
    },
  };
}
