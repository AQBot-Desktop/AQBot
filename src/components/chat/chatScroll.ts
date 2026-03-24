export function getDistanceToHistoryTop(scrollHeight: number, scrollTop: number, clientHeight: number) {
  return scrollHeight + scrollTop - clientHeight;
}

export function shouldShowScrollToBottom(scrollTop: number, threshold = 160) {
  return scrollTop < -threshold;
}
