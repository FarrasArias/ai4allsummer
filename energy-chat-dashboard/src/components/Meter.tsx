// React import not needed with JSX transform

type MeterProps = {
    label: string;
    valuePercent: number; 
    leftCaption?: string;
    rightCaption?: string;
    ariaDescription?: string;
};

export default function Meter({
    label,
    valuePercent,
    leftCaption = "Energy efficient",
    rightCaption = "Energy heavy",
    ariaDescription,
}: MeterProps) {
    const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

    return (
        <div className="meter">
            <div className="meter-head">
                <span className="meter-label">{label}</span>
                <span className="meter-value">{clamp(valuePercent)}%</span>
            </div>

            <div
                className="meter-track"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={clamp(valuePercent)}
                aria-valuetext={`${clamp(valuePercent)} percent`}
                aria-label={label}
                aria-description={ariaDescription}
            >
                <div className="meter-fill" style={{ width: `${clamp(valuePercent)}%` }} />
            </div>

            <div className="meter-scale">
                <span>{leftCaption}</span>
                <span>{rightCaption}</span>
            </div>
        </div>
    );
}
