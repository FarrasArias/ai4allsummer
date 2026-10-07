/* Energy as people read it in the app: µWh for tiny amounts, then mWh, then Wh. */
export function formatEnergy(wh: number): string {
    if (wh < 0.001) return `${(wh * 1000000).toFixed(2)} µWh`;
    if (wh < 1) return `${(wh * 1000).toFixed(2)} mWh`;
    return `${wh.toFixed(4)} Wh`;
}
