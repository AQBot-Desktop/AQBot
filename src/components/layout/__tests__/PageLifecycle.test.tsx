import { Activity, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  PageLifecycleProvider,
  usePageConnectionGeneration,
  usePageSuspendCleanup,
} from '@/components/layout/PageLifecycle';

function TransientProbe() {
  const [open, setOpen] = useState(false);
  usePageSuspendCleanup(() => setOpen(false));
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>open</button>
      <output aria-label="transient-state">{open ? 'open' : 'closed'}</output>
    </>
  );
}

function AsyncProbe({ wait }: { wait: Promise<void> }) {
  const generationRef = usePageConnectionGeneration();
  const [opened, setOpened] = useState(false);
  const start = async () => {
    const generation = generationRef.current;
    await wait;
    if (generationRef.current === generation) setOpened(true);
  };
  return (
    <>
      <button type="button" onClick={() => { void start(); }}>start async</button>
      <output aria-label="async-state">{opened ? 'open' : 'closed'}</output>
    </>
  );
}

describe('PageLifecycle', () => {
  it('closes transient state when an Activity page is suspended', () => {
    const { rerender } = render(
      <Activity mode="visible">
        <PageLifecycleProvider active>
          <TransientProbe />
        </PageLifecycleProvider>
      </Activity>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.getByLabelText('transient-state')).toHaveTextContent('open');

    rerender(
      <Activity mode="hidden">
        <PageLifecycleProvider active={false}>
          <TransientProbe />
        </PageLifecycleProvider>
      </Activity>,
    );
    rerender(
      <Activity mode="visible">
        <PageLifecycleProvider active>
          <TransientProbe />
        </PageLifecycleProvider>
      </Activity>,
    );
    expect(screen.getByLabelText('transient-state')).toHaveTextContent('closed');
  });

  it('invalidates async overlay work across an Activity disconnect and reconnect', async () => {
    let resolve!: () => void;
    const wait = new Promise<void>((next) => { resolve = next; });
    const renderProbe = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <PageLifecycleProvider active={mode === 'visible'}>
          <AsyncProbe wait={wait} />
        </PageLifecycleProvider>
      </Activity>
    );
    const view = render(renderProbe('visible'));
    fireEvent.click(screen.getByRole('button', { name: 'start async' }));
    view.rerender(renderProbe('hidden'));
    view.rerender(renderProbe('visible'));
    await act(async () => resolve());
    expect(screen.getByLabelText('async-state')).toHaveTextContent('closed');
  });
});
