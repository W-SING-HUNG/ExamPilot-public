import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[ExamPilot] UI error:', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page" style={{ padding: 40 }}>
          <div className="card card-pad">
            <h2 style={{ marginTop: 0 }}>页面出现异常</h2>
            <p className="muted">当前视图渲染失败，你的学习数据已保存在本地，不会丢失。</p>
            <pre className="code" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {this.state.error.message}
            </pre>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>
                重试
              </button>
              <button
                className="btn"
                onClick={() => {
                  window.location.hash = '/home'
                  this.setState({ error: null })
                }}
              >
                返回总览
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
