import { formatEstimate } from "../format";

/* "GPT-4o, estimated: ~160 mWh", shown next to an answer's measured energy.
   Scaled from Epoch AI's published GPT-4o estimate by the tokens the answer
   used; backend/utilities/cloud_estimate.py has the method and sources. */

export const CLOUD_ESTIMATE_NOTE =
    "What the same answer would take on GPT-4o, estimated from published research " +
    "(Epoch AI, 2025) by the tokens this answer used. An estimate, not a measurement; " +
    "the energy before it is measured on this Mac.";

export default function CloudEstimate({ wh }: { wh?: number | null }) {
    if (wh == null) return null;
    return <span title={CLOUD_ESTIMATE_NOTE}>· GPT-4o, estimated: {formatEstimate(wh)}</span>;
}
