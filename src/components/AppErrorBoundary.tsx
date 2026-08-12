import { Component, type ErrorInfo, type ReactNode } from "react";
import { resolveLanguage, translate } from "../lib/i18n";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

function recoveryLanguage() {
  try {
    return resolveLanguage(localStorage.getItem("webreader.language"));
  } catch {
    return "zh" as const;
  }
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("WebReader recovered from an unexpected interface error.", error, info.componentStack);
  }

  private returnToLibrary = () => {
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;

    const language = recoveryLanguage();
    const t = (key: "readerCrashedTitle" | "readerCrashedText" | "backToLibrary" | "reloadApp") => translate(language, key);
    return (
      <main className="recovery-shell" role="alert">
        <section className="recovery-panel">
          <h1>{t("readerCrashedTitle")}</h1>
          <p>{t("readerCrashedText")}</p>
          <div className="recovery-actions">
            <button className="primary-button" type="button" onClick={this.returnToLibrary}>{t("backToLibrary")}</button>
            <button className="secondary-button" type="button" onClick={() => window.location.reload()}>{t("reloadApp")}</button>
          </div>
        </section>
      </main>
    );
  }
}
