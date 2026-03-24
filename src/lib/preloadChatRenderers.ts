let preloadPromise: Promise<void> | null = null;

export function preloadChatRenderers(): Promise<void> {
  if (preloadPromise) return preloadPromise;

  preloadPromise = (async () => {
    try {
      const [
        markstream,
        streamMonacoModule,
      ] = await Promise.all([
        import('markstream-react'),
        import('stream-monaco'),
      ]);

      void markstream.preloadExtendedLanguageIcons();

      void streamMonacoModule;
    } catch (e) {
      console.warn('Failed to preload chat renderers:', e);
    }
  })();

  return preloadPromise;
}
