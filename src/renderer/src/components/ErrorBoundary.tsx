import { Component, ErrorInfo, ReactNode } from 'react'

/**
 * Last line of defence: a rendering bug shows a recoverable message instead of a blank
 * window. Tracking itself runs in the main process and is unaffected by renderer errors.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer error', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="login-wrap">
        <div className="card login">
          <h1>Something went wrong</h1>
          <p className="muted">
            The window hit an unexpected error. Tracking continues in the background and no data was lost.
          </p>
          <button className="btn primary block" onClick={() => location.reload()}>
            Reload window
          </button>
        </div>
      </div>
    )
  }
}
