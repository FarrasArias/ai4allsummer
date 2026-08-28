// React import not needed with JSX transform
import { useTip } from "./TipContext";

export default function TipsBox() {
  const { tip, dismissTip } = useTip();

  return (
    <div className="tips-box">
      {/* Speech bubble (only when a tip is active) */}
      {tip.visible && tip.message && (
        <div className="tips-speech-bubble" onClick={dismissTip} title="Click to dismiss">
          <div className="tips-speech-text">{tip.message}</div>
          <div className="tips-speech-tail" />
        </div>
      )}

      {/* Planet mascot icon (always visible) */}
      <div className="tips-planet-icon">
        🌍
      </div>
    </div>
  );
}
