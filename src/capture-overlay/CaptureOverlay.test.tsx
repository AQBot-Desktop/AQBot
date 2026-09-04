import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), close: vi.fn(), createUrl: vi.fn(), revokeUrl: vi.fn() }));
vi.mock('@/lib/invoke', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ close: mocks.close }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ default: { changeLanguage: async () => undefined, dir: () => 'ltr' } }));

import { CaptureOverlay } from './CaptureOverlay';

const snapshot = { capture_id: 'capture-current', width: 1920, height: 1080, language: 'en-US' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('PointerEvent', MouseEvent);
  mocks.createUrl.mockReturnValue('blob:capture-test');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: mocks.createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: mocks.revokeUrl });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'capture_overlay_snapshot') return snapshot;
    if (command === 'capture_overlay_image') return new ArrayBuffer(8);
    return undefined;
  });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function mountedOverlay(imageLoaded = true) {
  const result = render(<CaptureOverlay />);
  const image = await screen.findByRole('img');
  if (imageLoaded) fireEvent.load(image);
  const overlay = screen.getByLabelText('settings.selectionToolbar.captureInstructions');
  Object.assign(overlay, {
    setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  });
  return { ...result, overlay };
}

describe('CaptureOverlay', () => {
  it('loads only binary image bytes and revokes the object URL on close', async () => {
    const { unmount } = await mountedOverlay();
    expect(mocks.invoke).toHaveBeenCalledWith('capture_overlay_image', { captureId: snapshot.capture_id });
    expect(mocks.createUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:capture-test');
    unmount();
    expect(mocks.revokeUrl).toHaveBeenCalledWith('blob:capture-test');
  });

  it('submits image-local pixels instead of base64 or global screen coordinates', async () => {
    const { overlay } = await mountedOverlay();
    fireEvent.pointerDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(overlay, { clientX: 400, clientY: 300 });
    fireEvent.pointerUp(overlay, { clientX: 400, clientY: 300 });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('capture_overlay_confirm', {
      captureId: snapshot.capture_id, region: { x: 150, y: 150, width: 450, height: 300 },
    }));
  });

  it('cancels with Escape without confirming a screenshot', async () => {
    await mountedOverlay();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('capture_overlay_cancel', { captureId: snapshot.capture_id }));
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'capture_overlay_confirm')).toBe(false);
  });

  it('does not allow a selection before the preview loads or after it fails', async () => {
    const { overlay } = await mountedOverlay(false);
    const select = () => {
      fireEvent.pointerDown(overlay, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(overlay, { clientX: 400, clientY: 300 });
    };
    select();
    expect(overlay.setPointerCapture).not.toHaveBeenCalled();
    fireEvent.load(screen.getByRole('img'));
    fireEvent.pointerDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.error(screen.getByRole('img'));
    fireEvent.pointerUp(overlay, { clientX: 400, clientY: 300 });
    select();
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'capture_overlay_confirm')).toBe(false);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('capture_overlay_cancel', { captureId: snapshot.capture_id }));
  });

  it('discards a drag when the viewport size changes', async () => {
    const { overlay } = await mountedOverlay();
    fireEvent.pointerDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.resize(window);
    fireEvent.pointerUp(overlay, { clientX: 400, clientY: 300 });
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'capture_overlay_confirm')).toBe(false);
  });

  it('keeps empty selections local and exposes typed backend failures', async () => {
    const { overlay } = await mountedOverlay();
    fireEvent.pointerDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(overlay, { clientX: 100, clientY: 100 });
    expect(screen.getByRole('alert')).toHaveTextContent('settings.selectionToolbar.captureInvalidRegion');
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'capture_overlay_confirm')).toBe(false);
    mocks.invoke.mockRejectedValueOnce({ code: 'capture_expired', detail: 'expired' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'common.cancel' })));
    expect(screen.getByRole('alert')).toHaveTextContent('settings.selectionToolbar.captureExpired');
  });
});
