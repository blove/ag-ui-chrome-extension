/**
 * Proves the `panel` Vitest project actually gives a component test what it needs: a jsdom
 * document, a `chrome` stub, and a working Preact render through `@testing-library/preact`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';

function Hello(props: { name: string }) {
  return <p data-testid="greeting">Hello, {props.name}</p>;
}

describe('panel test environment', () => {
  it('runs in jsdom', () => {
    expect(typeof document).toBe('object');
    expect(document.body).toBeDefined();
  });

  it('exposes the chrome stub from test-setup', () => {
    expect(chrome.runtime.getManifest().version).toBe('0.1.0');
  });

  it('renders a Preact component', () => {
    render(<Hello name="AG-UI" />);
    expect(screen.getByTestId('greeting').textContent).toBe('Hello, AG-UI');
  });

  it('cleans up between tests', () => {
    expect(screen.queryByTestId('greeting')).toBeNull();
  });
});
