use aqbot_core::error::Result;
use aqbot_core::types::ChatStreamChunk;
use futures::Stream;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::task::JoinHandle;

struct AbortOnDropStream {
    inner: futures::channel::mpsc::UnboundedReceiver<Result<ChatStreamChunk>>,
    handle: JoinHandle<()>,
    terminal_seen: bool,
}

impl Stream for AbortOnDropStream {
    type Item = Result<ChatStreamChunk>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match Pin::new(&mut self.inner).poll_next(cx) {
            Poll::Ready(Some(item)) => {
                self.terminal_seen |= item.as_ref().map_or(true, |chunk| chunk.done);
                Poll::Ready(Some(item))
            }
            Poll::Ready(None) if !self.terminal_seen => {
                self.terminal_seen = true;
                Poll::Ready(Some(Err(incomplete_stream_error())))
            }
            other => other,
        }
    }
}

impl Drop for AbortOnDropStream {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

pub fn spawn_abortable_stream<Fut>(
    task: impl FnOnce(futures::channel::mpsc::UnboundedSender<Result<ChatStreamChunk>>) -> Fut
        + Send
        + 'static,
) -> Pin<Box<dyn Stream<Item = Result<ChatStreamChunk>> + Send>>
where
    Fut: Future<Output = ()> + Send + 'static,
{
    let (tx, rx) = futures::channel::mpsc::unbounded();
    let handle = tokio::spawn(task(tx));
    Box::pin(AbortOnDropStream {
        inner: rx,
        handle,
        terminal_seen: false,
    })
}

pub fn incomplete_stream_error() -> aqbot_core::error::AQBotError {
    aqbot_core::error::AQBotError::Provider("Stream ended without a protocol terminal event".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn drop_aborts_the_background_task() {
        let started = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(AtomicBool::new(false));
        let started_flag = started.clone();
        let cancelled_flag = cancelled.clone();
        let stream = spawn_abortable_stream(move |_tx| async move {
            started_flag.store(true, Ordering::SeqCst);
            let _guard = CancelGuard(cancelled_flag);
            std::future::pending::<()>().await;
        });
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(200);
        while !started.load(Ordering::SeqCst) {
            if tokio::time::Instant::now() > deadline {
                panic!("background stream task did not start");
            }
            tokio::task::yield_now().await;
        }
        drop(stream);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(200);
        while !cancelled.load(Ordering::SeqCst) {
            if tokio::time::Instant::now() > deadline {
                panic!("background stream task was not aborted");
            }
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn producer_without_terminal_returns_one_error() {
        use futures::StreamExt;
        let results = spawn_abortable_stream(|_tx| async {})
            .collect::<Vec<_>>()
            .await;
        assert_eq!(results.len(), 1);
        assert!(results[0]
            .as_ref()
            .unwrap_err()
            .to_string()
            .contains("terminal event"));
    }

    #[tokio::test]
    async fn explicit_error_is_not_duplicated() {
        use futures::StreamExt;
        let results = spawn_abortable_stream(|tx| async move {
            tx.unbounded_send(Err(incomplete_stream_error())).unwrap();
        })
        .collect::<Vec<_>>()
        .await;
        assert_eq!(results.len(), 1);
    }

    struct CancelGuard(Arc<AtomicBool>);
    impl Drop for CancelGuard {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
}
