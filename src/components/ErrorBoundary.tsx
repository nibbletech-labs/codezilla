import { Component, type ReactNode } from "react";

interface Props {
  name: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class PanelErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[${this.props.name}] crashed:`, error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            gap: "12px",
            padding: "24px",
            color: "var(--text-primary)",
          }}
        >
          <div style={{ fontSize: "14px", color: "#e4676b" }}>
            {this.props.name} encountered an error
          </div>
          <div
            style={{
              fontSize: "12px",
              color: "var(--text-secondary)",
              maxWidth: "300px",
              textAlign: "center",
              wordBreak: "break-word",
            }}
          >
            {this.state.error?.message}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              background: "transparent",
              border: "1px solid var(--accent)",
              color: "var(--text-primary)",
              fontSize: "13px",
              cursor: "pointer",
              padding: "6px 16px",
              borderRadius: "4px",
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
